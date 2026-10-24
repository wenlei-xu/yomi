param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Configure', 'Upload')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security -ErrorAction Stop
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDirectory '..')).Path
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'Yomi'
$credentialPath = Join-Path $credentialDirectory 'oss-credentials.dpapi'

if ($Mode -eq 'Configure') {
  $accessKeyId = (Read-Host 'OSS RAM AccessKey ID').Trim()
  if ([string]::IsNullOrWhiteSpace($accessKeyId)) {
    throw 'AccessKey ID cannot be empty.'
  }

  $accessKeySecret = Read-Host 'OSS RAM AccessKey Secret (input is hidden)' -AsSecureString
  if ($accessKeySecret.Length -eq 0) {
    throw 'AccessKey Secret cannot be empty.'
  }

  New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
  $secretPointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($accessKeySecret)
  $plainBytes = $null
  try {
    $secretText = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $plainJson = [ordered]@{ accessKeyId = $accessKeyId; accessKeySecret = $secretText } | ConvertTo-Json -Compress
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($plainJson)
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $temporaryPath = "$credentialPath.tmp"
    [System.IO.File]::WriteAllText($temporaryPath, [Convert]::ToBase64String($protectedBytes), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $credentialPath -Force
  }
  finally {
    if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    $secretText = $null
    $plainJson = $null
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  Write-Host 'OSS credentials saved encrypted for this Windows user.'
  exit 0
}

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw 'OSS credentials are not configured. Run: npm run oss:configure'
}

$plainBytes = $null
$exitCode = 1
try {
  $protectedBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $credentialPath -Raw).Trim())
  $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $stored = [System.Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($stored.accessKeyId) -or [string]::IsNullOrWhiteSpace($stored.accessKeySecret)) {
    throw 'The local OSS credential file is invalid. Run: npm run oss:configure'
  }
  $env:OSS_ACCESS_KEY_ID = $stored.accessKeyId
  $env:OSS_ACCESS_KEY_SECRET = $stored.accessKeySecret
  Push-Location $projectRoot
  try {
    & node (Join-Path $scriptDirectory 'upload-release.cjs')
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
}
finally {
  Remove-Item Env:OSS_ACCESS_KEY_ID -ErrorAction SilentlyContinue
  Remove-Item Env:OSS_ACCESS_KEY_SECRET -ErrorAction SilentlyContinue
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  $stored = $null
}

exit $exitCode
