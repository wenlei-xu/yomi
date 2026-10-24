const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const { versionName, versionCode, webVersion, schemaVersion } = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(versionName) || !Number.isSafeInteger(versionCode) || versionCode < 2) throw new Error('Invalid version.json')
const notes = fs.readFileSync(path.join(root, 'release-notes.txt'), 'utf8').trim()
if (!notes || notes.length > 5000) throw new Error('Release notes must contain 1-5000 characters')
const output = path.join(root, 'release-output', `v${versionName}-${versionCode}`)
const releases = path.join(output, 'releases')
// An immutable release must never be silently rebuilt under the same public URL.
if (fs.existsSync(output)) throw new Error('This release already exists. Increase version.json before creating the next release.')
function run(file, args, cwd = root) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`Build step failed: ${file}`)
}
run('node', ['scripts/init-signing.cjs'])
run('npm', ['run', 'build'])
run('npx', ['cap', 'sync', 'android'])
run(process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew', ['assembleRelease'], path.join(root, 'android'))
const apkPath = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
if (!sdk) throw new Error('ANDROID_HOME is required to verify the release APK')
const toolsRoot = path.join(sdk, 'build-tools')
const toolsVersion = fs.readdirSync(toolsRoot).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}))[0]
if (!toolsVersion) throw new Error('Android build-tools are required to verify the release APK')
run(path.join(toolsRoot, toolsVersion, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'), ['verify', '--verbose', '--print-certs', apkPath])
const apk = fs.readFileSync(apkPath)
if (apk.length > 200 * 1024 * 1024) throw new Error('APK exceeds the updater limit')
const fileName = `yomi-${versionName}-${versionCode}.apk`
const manifest = { format: 'yomi-release', applicationId: 'app.yomi.mobile', versionName, versionCode, minSdk: 24,
  url: `https://stoneapi.me/releases/${fileName}`, size: apk.length, sha256: crypto.createHash('sha256').update(apk).digest('hex'),
  publishedAt: new Date().toISOString(), notes }
fs.mkdirSync(releases, { recursive: true })
fs.writeFileSync(path.join(output,'release-baseline.json'),JSON.stringify({versionName,versionCode,webVersion,schemaVersion},null,2)+'\n')
fs.writeFileSync(path.join(releases, fileName), apk, { flag: 'wx' })
fs.writeFileSync(path.join(releases, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
fs.writeFileSync(path.join(output, 'UPLOAD.txt'), `Yomi ${versionName} (${versionCode})

1. Open OSS Bucket yomi-xu, folder releases/.
2. Upload ${fileName} first. Set only this object to public-read.
3. Verify https://stoneapi.me/releases/${fileName} is downloadable.
4. Upload latest.json LAST. Set this object to public-read.
5. latest.json: Content-Type application/json; Cache-Control no-cache, max-age=0, must-revalidate.
6. APK: Cache-Control public, max-age=31536000, immutable.

Keep the bucket private. Never upload the signing folder, backup files or API credentials.
This script prepares files locally; it does not publish them to OSS.
`)
console.log(`Ready for OSS upload: ${output}`)
console.log(`APK SHA-256: ${manifest.sha256}`)
