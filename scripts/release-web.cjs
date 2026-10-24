const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { zipSync } = require('fflate')
const root = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'))
const output = path.join(root, 'release-output', `web-${version.versionCode}-${version.webVersion}`)
const properties = path.resolve(root, '..', '.local/yomi-signing/keystore.properties')
const nativeRelease = path.join(root, 'release-output', `v${version.versionName}-${version.versionCode}`, 'release-baseline.json')
if (!fs.existsSync(properties) || !fs.existsSync(nativeRelease)) throw new Error('Build the native release first with npm run release')
const baseline = JSON.parse(fs.readFileSync(nativeRelease, 'utf8'))
if (baseline.versionCode !== version.versionCode || baseline.schemaVersion !== version.schemaVersion) throw new Error('Native version or schema changed: publish an APK update instead')
if (!Number.isSafeInteger(version.webVersion) || version.webVersion < baseline.webVersion) throw new Error('Invalid webVersion')
const schemaVersion = /schemaVersion\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(root, 'src/data/schema.ts'), 'utf8'))
if (Number(schemaVersion?.[1]) !== baseline.schemaVersion) throw new Error('Database schema changed: an APK release is required')
if (fs.existsSync(output)) throw new Error('This web release already exists; increase webVersion')
const build = spawnSync('npm', ['run', 'build'], { cwd: root, shell: process.platform === 'win32', stdio: 'inherit', windowsHide: true })
if (build.status !== 0) throw new Error('Web build failed')
const entries = {}
function collect(folder, prefix = '') {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlinks cannot be packaged')
    const name = prefix + entry.name
    if (entry.isDirectory()) collect(path.join(folder, entry.name), name + '/')
    else if (!name.endsWith('.map')) entries[name] = new Uint8Array(fs.readFileSync(path.join(folder, entry.name)))
  }
}
collect(path.join(root, 'dist'))
if (!entries['index.html']) throw new Error('Missing index.html')
const expanded = Object.values(entries).reduce((total,bytes)=>total+bytes.length,0)
if (Object.keys(entries).length > 2000 || expanded > 80 * 1024 * 1024) throw new Error('Web files exceed updater limits')
const zip = Buffer.from(zipSync(entries, { level: 6 }))
if (zip.length > 20 * 1024 * 1024) throw new Error('Web ZIP exceeds updater limit')
const fileName = `web-${version.versionCode}-${version.webVersion}.zip`
const payload = { format:'yomi-web-release', nativeVersionCode:version.versionCode, webVersion:version.webVersion,
  schemaVersion:version.schemaVersion, url:`https://stoneapi.me/releases/${fileName}`, size:zip.length,
  sha256:crypto.createHash('sha256').update(zip).digest('hex'), publishedAt:new Date().toISOString() }
fs.mkdirSync(output, { recursive:true })
const payloadFile = path.join(output, 'payload.json')
fs.writeFileSync(payloadFile, JSON.stringify(payload))
const executable = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
const signed = spawnSync(executable, [path.join(root,'scripts/SignWebUpdate.java'), properties, payloadFile], { encoding:'utf8', windowsHide:true })
if (signed.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.stdout)) throw new Error('Web bundle signing failed')
const releases = path.join(output,'releases'); fs.mkdirSync(releases)
fs.writeFileSync(path.join(releases,fileName),zip)
fs.writeFileSync(path.join(releases,`latest-web-${version.versionCode}.json`),JSON.stringify({payload:fs.readFileSync(payloadFile).toString('base64'),signature:signed.stdout},null,2)+'\n')
fs.writeFileSync(path.join(output,'UPLOAD.txt'),`Upload releases/${fileName} first, then releases/latest-web-${version.versionCode}.json LAST.\nSet only these objects to public-read. Use no-cache, max-age=0, must-revalidate on the JSON descriptor.\nNever upload signing keys or the whole release-output parent directory.\n`)
console.log(`Signed web release ready: ${releases}`)
