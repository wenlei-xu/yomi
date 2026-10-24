const path = require('node:path')
const { spawnSync } = require('node:child_process')

const mode = process.argv[2]
if (!['Configure', 'Upload'].includes(mode)) {
  console.error('Usage: node scripts/oss-run.cjs Configure|Upload')
  process.exit(2)
}
if (process.platform !== 'win32') {
  console.error('OSS credential storage currently requires Windows DPAPI.')
  process.exit(2)
}

const windowsDirectory = process.env.WINDIR || 'C:\\Windows'
const powershell = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const result = spawnSync(powershell, [
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', path.join(__dirname, 'oss-release.ps1'),
  '-Mode', mode
], { stdio: 'inherit', windowsHide: false })

if (result.error) {
  console.error('Could not start Windows PowerShell for the OSS operation.')
  process.exit(1)
}
process.exit(result.status ?? 1)
