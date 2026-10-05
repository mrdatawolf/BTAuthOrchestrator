# Windows entrypoint (normally launched via start.bat). Prepares .env and the
# data directory ACL, runs the shared startup checks, then starts the service.
# Prepare dependencies/build/seed manually: npm ci, npm run build, npm run seed.
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$AppDir = $PSScriptRoot
Set-Location -LiteralPath $AppDir

function Fail([string]$Message) {
  [Console]::Error.WriteLine("Startup check failed: $Message")
  exit 1
}

# Reads KEY=value from .env text, honouring optional surrounding quotes.
function Get-EnvValue([string]$Text, [string]$Name) {
  $match = [regex]::Match($Text, "(?m)^[ \t]*$Name[ \t]*=[ \t]*([^\r\n]*)")
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value.Trim().Trim('"', "'")
}

# Writes without a BOM: Node's --env-file would read a BOM as part of the first key.
function Write-EnvFile([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Sets KEY=value in $script:EnvText, replacing an existing line or appending one.
function Set-EnvValue([string]$Name, [string]$Value) {
  $Line = "$Name=$Value"
  if ($script:EnvText -match "(?m)^[ \t]*$Name[ \t]*=") {
    $script:EnvText = [regex]::Replace($script:EnvText, "(?m)^[ \t]*$Name[ \t]*=[^\r\n]*", $Line)
  } else {
    $NewLine = if ($script:EnvText.Contains("`r`n")) { "`r`n" } else { "`n" }
    if ($script:EnvText.Length -gt 0 -and -not $script:EnvText.EndsWith("`n")) { $script:EnvText += $NewLine }
    $script:EnvText += $Line + $NewLine
  }
  $script:EnvChanged = $true
}

# 32 random bytes as 64 lowercase hex characters.
function New-RandomHex {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# --- Runtime, dependencies, build ---------------------------------------------

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Install Node.js >=20.6.0 and make sure node is on PATH.'
}
# Windows PowerShell 5.1 strips embedded double quotes when passing native
# arguments. Use a regex delimiter so the JavaScript needs no inner quotes.
& node -e 'const [major, minor] = process.versions.node.split(/\./).map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { Fail 'Node.js >=20.6.0 is required.' }
if (-not (Test-Path -LiteralPath 'node_modules' -PathType Container)) { Fail "Dependencies are missing. Run npm ci in $AppDir." }
if (-not (Test-Path -LiteralPath 'dist\index.js' -PathType Leaf)) { Fail "Compiled application is missing. Run npm run build in $AppDir." }

# --- .env: DB_ENCRYPTION_KEY and admin tokens ---------------------------------

$EnvPath = Join-Path $AppDir '.env'
if (-not (Test-Path -LiteralPath $EnvPath -PathType Leaf)) {
  if (-not (Test-Path -LiteralPath '.env.example' -PathType Leaf)) { Fail "Create $EnvPath and configure it." }
  Copy-Item -LiteralPath '.env.example' -Destination $EnvPath
  Write-Host "Created .env from .env.example; review the remaining values before production use."
}
$EnvText = [System.IO.File]::ReadAllText($EnvPath)
$EnvChanged = $false

$DataDirSetting = Get-EnvValue $EnvText 'PGLITE_DATA_DIR'
$DataDir = $null
if ($DataDirSetting) {
  $DataDir = if ([System.IO.Path]::IsPathRooted($DataDirSetting)) { $DataDirSetting } else { Join-Path $AppDir $DataDirSetting }
  $DataDir = [System.IO.Path]::GetFullPath($DataDir)
}

$Key = Get-EnvValue $EnvText 'DB_ENCRYPTION_KEY'
if ([string]::IsNullOrEmpty($Key) -or $Key -eq 'replace-with-encryption-key') {
  # A new key cannot decrypt secrets already stored under a previous key.
  if ($DataDir -and (Test-Path -LiteralPath $DataDir) -and (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1)) {
    Fail "DB_ENCRYPTION_KEY is not set but $DataDir already contains data. Restore the original key in .env; a new key cannot decrypt existing secrets."
  }
  Set-EnvValue 'DB_ENCRYPTION_KEY' (New-RandomHex)
  Write-Host 'Generated a new DB_ENCRYPTION_KEY in .env. Back it up: losing it makes stored secrets unrecoverable.'
} elseif ($Key -cnotmatch '^[0-9a-f]{64}$') {
  Fail 'DB_ENCRYPTION_KEY in .env must be exactly 64 lowercase hexadecimal characters. Fix it, or clear the value to have one generated (only before the database is seeded).'
}

# Admin bearer tokens are independent of stored data, so they are safe to
# generate whenever they are missing or still the .env.example placeholder.
# A value that is set but invalid is left for the configuration check to report.
$Tokens = [ordered]@{
  'EMERGENCY_ROTATION_TOKEN' = 'replace-with-emergency-rotation-token'
  'LOCAL_USER_ADMIN_TOKEN'   = 'replace-with-local-user-admin-token'
}
foreach ($Name in $Tokens.Keys) {
  $Value = Get-EnvValue $EnvText $Name
  if ([string]::IsNullOrEmpty($Value) -or $Value -eq $Tokens[$Name]) {
    Set-EnvValue $Name (New-RandomHex)
    Write-Host "Generated a new $Name in .env. Give it to the administrators who call that API."
  }
}

if ($EnvChanged) { Write-EnvFile $EnvPath $EnvText }

# --- Data directory permissions (Windows equivalent of chmod 700) -------------

# Only an existing directory is locked down; when it is absent the seeding
# step below explains npm run seed. Ownership is never changed automatically
# (CONTRACT-007 §5).
if ($DataDir -and (Test-Path -LiteralPath $DataDir -PathType Container)) {
  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $Acl = Get-Acl -LiteralPath $DataDir
    $Owner = $Acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($Owner -ne $Sid) {
      $UserName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      Fail "$DataDir is not owned by $UserName. From an elevated prompt run: icacls `"$DataDir`" /setowner `"$UserName`" /T"
    }
    # Owner-only full control, inheritance from the parent removed.
    $Acl = New-Object System.Security.AccessControl.DirectorySecurity
    $Acl.SetOwner($Sid)
    $Acl.SetAccessRuleProtection($true, $false)
    $Acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      $Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $DataDir -AclObject $Acl
    # Drop any explicit entries on existing children so they inherit only the rule above.
    if (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1) {
      & icacls.exe (Join-Path $DataDir '*') /reset /T /C /Q | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "Unable to reset permissions under $DataDir (icacls exit $LASTEXITCODE)." }
    }
  } else {
    & chmod 700 -- $DataDir
    if ($LASTEXITCODE -ne 0) { Fail "Unable to set mode 0700 on $DataDir." }
  }
}

# --- Seeding -------------------------------------------------------------------

# npm run seed is interactive (it prompts for CLIENT_SECRET and the first
# local user), so the launcher only explains it rather than running it.
$SeedSteps = @"
The database has not been seeded yet. From $AppDir run:
  npm run seed
Answer its prompts (the Entra CLIENT_SECRET, then the first local user's
username, email and password), then run start.bat again.
"@
if ($DataDir -and -not ((Test-Path -LiteralPath $DataDir -PathType Container) -and
    (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1))) {
  Fail $SeedSteps
}

# --- Shared configuration and database checks --------------------------------

& node --env-file=.env scripts/startup-check.js
if ($LASTEXITCODE -ne 0) {
  Write-Host 'If the message above mentions npm run seed (incomplete bootstrap or no active local user):'
  Write-Host "  cd `"$AppDir`""
  Write-Host '  npm run seed'
  Write-Host '  start.bat'
  exit $LASTEXITCODE
}

Write-Host 'Startup checks passed; starting BTAuthOrchestrator.'
& node --env-file=.env dist/index.js
exit $LASTEXITCODE
