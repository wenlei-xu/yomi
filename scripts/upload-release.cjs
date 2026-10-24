const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const OSS = require('ali-oss')

const root = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'))
const output = path.join(root, 'release-output', `upload-${version.versionName}-${version.versionCode}`)
const releases = path.join(output, 'releases')
const publicBase = 'https://stoneapi.me/releases/'
const latestCache = 'no-cache, max-age=0, must-revalidate'
const immutableCache = 'public, max-age=31536000, immutable'

function fail(message) {
  throw new Error(message)
}

function runPreparation() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare-upload.cjs')], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) fail('Could not start the release file verifier.')
  if (result.status !== 0) fail('Release file verification failed; nothing was uploaded.')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    fail(`Invalid release metadata: ${path.basename(file)}`)
  }
}

function getReleaseName(url, expectedName) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail(`Invalid release URL for ${expectedName}`)
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'stoneapi.me' || parsed.pathname !== `/releases/${expectedName}`) {
    fail(`Unexpected release URL for ${expectedName}`)
  }
  return expectedName
}

function fileRecord(name, contentType, cacheControl, immutable = false) {
  const filePath = path.join(releases, name)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Missing release file: ${name}`)
  const bytes = fs.readFileSync(filePath)
  return {
    name,
    filePath,
    contentType,
    cacheControl,
    immutable,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchPublicObject(name, retry = false) {
  const url = new URL(encodeURIComponent(name), publicBase)
  let lastError
  const attempts = retry ? 5 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(45000)
      })
      if (response.status === 404) {
        if (retry && attempt + 1 < attempts) {
          await delay(1000 * (attempt + 1))
          continue
        }
        return { status: 404 }
      }
      if (response.status !== 200) {
        fail(`Public URL check failed for ${name}: HTTP ${response.status}`)
      }
      return { status: 200, bytes: Buffer.from(await response.arrayBuffer()) }
    } catch (error) {
      if (error.message.startsWith('Public URL check failed')) throw error
      lastError = error
      if (attempt + 1 < attempts) await delay(1000 * (attempt + 1))
    }
  }
  fail(`Could not verify ${name} at stoneapi.me (${lastError?.name || 'network error'}).`)
}

async function verifyPublishedObject(record) {
  const remote = await fetchPublicObject(record.name, true)
  if (remote.status !== 200) fail(`Published object is not publicly readable: ${record.name}`)
  const digest = crypto.createHash('sha256').update(remote.bytes).digest('hex')
  if (remote.bytes.length !== record.size || digest !== record.sha256) {
    fail(`Public download does not match the prepared file: ${record.name}`)
  }
  console.log(`Publicly verified: ${record.name} (${record.size} bytes, SHA-256 ${digest})`)
}

async function main() {
  if (!process.env.OSS_ACCESS_KEY_ID || !process.env.OSS_ACCESS_KEY_SECRET) {
    fail('OSS credentials are unavailable. Run: npm run oss:configure')
  }

  runPreparation()

  const latestFile = path.join(releases, 'latest.json')
  const latest = readJson(latestFile)
  const apkName = path.basename(new URL(latest.url).pathname)
  if (apkName !== `yomi-${version.versionName}-${version.versionCode}.apk`) fail('APK name does not match version.json')
  getReleaseName(latest.url, apkName)

  const webDescriptorName = `latest-web-${version.versionCode}.json`
  const webDescriptor = readJson(path.join(releases, webDescriptorName))
  let webPayload
  try {
    webPayload = JSON.parse(Buffer.from(webDescriptor.payload, 'base64').toString('utf8'))
  } catch {
    fail('Invalid signed web release descriptor.')
  }
  const webName = path.basename(new URL(webPayload.url).pathname)
  if (webName !== `web-${version.versionCode}-${version.webVersion}.zip` || webPayload.nativeVersionCode !== version.versionCode || webPayload.schemaVersion !== version.schemaVersion) {
    fail('Web release does not match version.json.')
  }
  getReleaseName(webPayload.url, webName)

  const expectedNames = [apkName, webName, webDescriptorName, 'latest.json'].sort()
  const actualNames = fs.readdirSync(releases).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('Upload folder contains unexpected files.')

  const files = [
    fileRecord(apkName, 'application/vnd.android.package-archive', immutableCache, true),
    fileRecord(webName, 'application/zip', immutableCache, true),
    fileRecord(webDescriptorName, 'application/json', latestCache),
    fileRecord('latest.json', 'application/json', latestCache)
  ]

  const client = new OSS({
    region: 'oss-cn-hongkong',
    endpoint: 'https://oss-cn-hongkong.aliyuncs.com',
    authorizationV4: true,
    bucket: 'yomi-xu',
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    timeout: 120000
  })

  for (const record of files) {
    console.log(`Uploading releases/${record.name}...`)
    const headers = {
      'Content-Type': record.contentType,
      'Cache-Control': record.cacheControl,
      'x-oss-object-acl': 'public-read'
    }
    if (record.immutable) headers['x-oss-forbid-overwrite'] = 'true'
    try {
      await client.put(`releases/${record.name}`, record.filePath, { headers })
    } catch (error) {
      const status = error.status || error.statusCode
      if (record.immutable && (status === 409 || error.code === 'FileAlreadyExists')) {
        const existing = await fetchPublicObject(record.name, true)
        const digest = existing.status === 200 ? crypto.createHash('sha256').update(existing.bytes).digest('hex') : ''
        if (existing.status === 200 && existing.bytes.length === record.size && digest === record.sha256) {
          console.log(`Already published and verified: ${record.name}`)
          continue
        }
        fail(`Immutable object already exists but does not match this release: ${record.name}`)
      }
      fail(`OSS upload failed for ${record.name}${status ? ` (HTTP ${status})` : ''}; check the RAM policy and bucket region.`)
    }
  }

  for (const record of files) await verifyPublishedObject(record)
  console.log(`Release ${version.versionName} (${version.versionCode}) is available at ${publicBase}`)
}

main().catch(error => {
  const id = process.env.OSS_ACCESS_KEY_ID || ''
  const secret = process.env.OSS_ACCESS_KEY_SECRET || ''
  let message = String(error.message || error)
  for (const credential of [id, secret].filter(Boolean)) message = message.replaceAll(credential, '[redacted]')
  console.error(`Release upload stopped: ${message}`)
  process.exitCode = 1
})
