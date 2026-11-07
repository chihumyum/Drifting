<#
.SYNOPSIS
  Builds the development installer and checks what an update and the
  hand-over rely on: install folder, Add/Remove Programs entry, vendor key,
  URL scheme, Start menu shortcut, updating in place (Tauri's /P /UPDATE
  flags), honouring a recorded install folder, and a clean uninstall.

.DESCRIPTION
  For CI runners (.github/workflows/next.yml): it installs into the current
  user's profile and changes HKCU. Do not run it on a machine you use.
  Expects `cargo build -p drifting` (debug) to have run.
#>
$ErrorActionPreference = 'Stop'
$next = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not (Get-Command makensis -ErrorAction SilentlyContinue) -and
    -not (Test-Path "${env:ProgramFiles(x86)}\NSIS\makensis.exe")) {
  choco install nsis --no-progress -y | Out-Null
}

$result = & (Join-Path $PSScriptRoot 'bundle-windows.ps1') -BuildProfile debug -SkipBuild
$installer = ($result | Select-String '^installer=(.*)$').Matches[0].Groups[1].Value
$product = 'Drifting Next'
$scheme = 'drifting-next-dev'
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$vendorKey = "HKCU:\Software\drifting\$product"
$schemeKey = "HKCU:\Software\Classes\$scheme"

function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $installer -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "installer $Arguments exited with $($process.ExitCode)" }
}
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "check failed: $Message" }
  Write-Output "ok: $Message"
}
function Assert-Installed([string]$Dir) {
  Assert (Test-Path "$Dir\drifting.exe") "drifting.exe in $Dir"
  Assert (Test-Path "$Dir\uninstall.exe") "uninstall.exe in $Dir"
  $entry = Get-ItemProperty $uninstallKey
  Assert ($entry.DisplayName -eq $product) 'Add/Remove Programs names the product'
  Assert ($entry.UninstallString -eq "`"$Dir\uninstall.exe`"") 'the uninstall command points at the folder'
  Assert ($entry.MainBinaryName -eq 'drifting.exe') 'MainBinaryName matches the Tauri installer'
  Assert ((Get-ItemProperty $vendorKey).'(default)' -eq $Dir) 'the vendor key records the folder'
  $command = (Get-ItemProperty "$schemeKey\shell\open\command").'(default)'
  Assert ($command -eq "`"$Dir\drifting.exe`" `"%1`"") "$scheme`: opens the installed executable"
  Assert ($null -ne (Get-ItemProperty $schemeKey).'URL Protocol') "$scheme`: is a URL protocol"
}
function Invoke-Uninstall([string]$Dir) {
  $process = Start-Process -FilePath "$Dir\uninstall.exe" -ArgumentList @('/S', "_?=$Dir") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "uninstaller exited with $($process.ExitCode)" }
  Remove-Item -Force "$Dir\uninstall.exe" -ErrorAction SilentlyContinue
  Remove-Item -Force $Dir -ErrorAction SilentlyContinue
  Assert (-not (Test-Path "$Dir\drifting.exe")) 'uninstall removes the executable'
  Assert (-not (Test-Path $uninstallKey)) 'uninstall removes the Add/Remove Programs entry'
  Assert (-not (Test-Path $vendorKey)) 'uninstall removes the vendor key'
  Assert (-not (Test-Path $schemeKey)) "uninstall removes $scheme`:"
}

# A first install goes where Tauri put Drifting: %LOCALAPPDATA%\<product>.
$default = Join-Path $env:LOCALAPPDATA $product
Invoke-Installer @('/S')
Assert-Installed $default
Assert (Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$product.lnk") 'a Start menu shortcut'

# An update as Tauri's updater starts it (without /R: nothing to relaunch).
$before = (Get-Item "$default\drifting.exe").LastWriteTimeUtc
Invoke-Installer @('/P', '/UPDATE', '/ARGS')
Assert-Installed $default
Assert ((Get-Item "$default\drifting.exe").LastWriteTimeUtc -ge $before) 'the update rewrote the executable'
Invoke-Uninstall $default

# A folder an earlier installer recorded wins over the default.
$custom = Join-Path $env:RUNNER_TEMP 'Drifting Custom'
if (-not $env:RUNNER_TEMP) { $custom = Join-Path $env:TEMP 'Drifting Custom' }
New-Item -Force -Path $vendorKey | Out-Null
Set-ItemProperty -Path $vendorKey -Name '(default)' -Value $custom
Invoke-Installer @('/S')
Assert-Installed $custom
Invoke-Uninstall $custom
Write-Output 'check-windows-installer: all checks passed'
