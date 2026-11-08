<#
.SYNOPSIS
  Builds the NSIS installer for the development identity ("Drifting Next").

.DESCRIPTION
  script/bundle-windows.ps1 [-BuildProfile release|dist|debug] [-Target <triple>]
                            [-Output <dir>] [-SkipBuild]

  `dist` is the shipped build: release with line tables, whose drifting.pdb
  (beside the executable, printed as `pdb=`) the release workflow uploads
  to Sentry. The installer never carries it.

  The installer is unsigned (decision D10) and carries the development
  identity from script/windows/drifting.nsi, so it installs beside a Tauri
  Drifting without touching its folder, registry keys or `drifting:` links.
  The release identity is the hand-over's job; see
  docs/rust-rewrite/foundations/f7-platform.md.

  Needs NSIS 3 (`makensis` on PATH or in Program Files). Windows only.
#>
param(
  [ValidateSet('release', 'dist', 'debug')]
  [string]$BuildProfile = 'release',
  [string]$Target = '',
  [string]$Output = '',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

$next = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Output) { $Output = Join-Path $next 'target\bundle' }
New-Item -ItemType Directory -Force -Path $Output | Out-Null

$manifest = Get-Content (Join-Path $next 'app\drifting\Cargo.toml')
$version = ($manifest | Select-String -Pattern '^version = "(.*)"$' | Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $version) { throw 'no version in app/drifting/Cargo.toml' }
# VIProductVersion takes four numbers: 0.2.0-dev -> 0.2.0.0
$numeric = "$($version.Split('-')[0]).0"

if (-not $SkipBuild) {
  $cargo = @('build', '--locked', '-p', 'drifting')
  if ($BuildProfile -eq 'release') { $cargo += '--release' }
  if ($BuildProfile -eq 'dist') { $cargo += @('--profile', 'dist') }
  if ($Target) { $cargo += @('--target', $Target) }
  Push-Location $next
  try { & cargo @cargo; if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' } } finally { Pop-Location }
}
$targetDir = if ($Target) { Join-Path $next "target\$Target\$BuildProfile" } else { Join-Path $next "target\$BuildProfile" }
$exe = Join-Path $targetDir 'drifting.exe'
if (-not (Test-Path $exe)) { throw "no executable at $exe" }

$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $makensis) {
  foreach ($candidate in @("${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe")) {
    if (Test-Path $candidate) { $makensis = $candidate; break }
  }
}
if (-not $makensis) { throw 'makensis (NSIS 3) is not installed' }

$arch = if ($Target -like 'aarch64*' -or (-not $Target -and $env:PROCESSOR_ARCHITECTURE -eq 'ARM64')) { 'arm64' } else { 'x64' }
$installer = Join-Path $Output "Drifting_Next_${version}_windows_${arch}-setup.exe"
& $makensis /V2 /INPUTCHARSET UTF8 "/DVERSION=$version" "/DVERSION_NUMERIC=$numeric" "/DEXE_SOURCE=$exe" "/DOUTFILE=$installer" (Join-Path $PSScriptRoot 'windows\drifting.nsi')
if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
$size = [math]::Round((Get-Item $installer).Length / 1MB, 1)
Write-Output "bundle-windows: $installer ($size MiB)"
Write-Output "installer=$installer"
$pdb = Join-Path $targetDir 'drifting.pdb'
if ($BuildProfile -eq 'dist' -and (Test-Path $pdb)) { Write-Output "pdb=$pdb" }
