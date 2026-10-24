const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const folder = path.resolve(root, '..', '.local', 'yomi-signing')
const properties = path.join(folder, 'keystore.properties')
const keystore = path.join(folder, 'yomi-release.p12')
if (fs.existsSync(properties) && fs.existsSync(keystore)) {
  console.log('Existing Yomi release key retained. No key rotation performed.')
  process.exit(0)
}
if (fs.existsSync(properties) || fs.existsSync(keystore)) throw new Error('Incomplete signing setup. Restore the existing key and properties; do not regenerate.')
fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
if (process.platform === 'win32') {
  const identity = spawnSync('whoami', [], { encoding: 'utf8' }).stdout.trim()
  const acl = spawnSync('icacls', [folder, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' })
  if (acl.status !== 0) throw new Error('Unable to restrict the signing folder permissions')
}
const password = crypto.randomBytes(32).toString('hex')
const executable = process.env.JAVA_HOME
  ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool'
const generated = spawnSync(executable, ['-genkeypair', '-alias', 'yomi-release', '-keyalg', 'RSA', '-keysize', '3072',
  '-sigalg', 'SHA256withRSA', '-validity', '10000', '-storetype', 'PKCS12', '-keystore', keystore,
  '-storepass:env', 'YOMI_SIGNING_PASSWORD', '-keypass:env', 'YOMI_SIGNING_PASSWORD',
  '-dname', 'CN=Yomi Release, O=Yomi', '-noprompt'], {
  env: { ...process.env, YOMI_SIGNING_PASSWORD: password }, windowsHide: true, encoding: 'utf8'
})
if (generated.status !== 0) throw new Error('Key generation failed. Check Java/keytool and the signing folder.')
fs.writeFileSync(properties, `storeFile=${keystore.replace(/\\/g, '/')}
storePassword=${password}
keyAlias=yomi-release
keyPassword=${password}
`, { mode: 0o600, flag: 'wx' })
console.log(`Release signing initialized in ${folder}. Back up this entire private folder securely; it is not part of the upload package.`)
