<#
.SYNOPSIS
  Builds the NSIS installer for the development identity ("Drifting Next"),
  or with -ReleaseIdentity for the release client's ("Drifting").

.DESCRIPTION
  script/bundle-windows.ps1 [-BuildProfile release|dist|debug] [-Target <triple>]
                            [-Output <dir>] [-SkipBuild] [-ReleaseIdentity]

  `dist` is the shipped build: release with line tables, whose drifting.pdb
  (beside the executable, printed as `pdb=`) the release workflow uploads
  to Sentry. The installer never carries it.

  The installer is unsigned (decision D10). By default it carries the
  development identity from script/windows/drifting.nsi, so it installs
  beside a Tauri Drifting without touching its folder, registry keys or
  `drifting:` links.

  -ReleaseIdentity is the release workflow's build (needs -BuildProfile dist
  and a version without `-dev`): the app's `release-identity` feature, built
  without its default features as the macOS release is (on Windows
  `runtime-shaders` changes nothing), and the 0.1 Tauri installer's product
  name, bundle id and `drifting:` scheme, so it installs over a Tauri
  Drifting (the hand-over; docs/rust-rewrite/foundations/f7-platform.md).
  Never run such an installer on a machine whose Drifting is not throwaway.
  `cargo xtask check-binary --release-identity <exe>` checks the executable.

  Needs NSIS 3 (`makensis` on PATH or in Program Files). Windows only.
#>
param(
  [ValidateSet('release', 'dist', 'debug')]
  [string]$BuildProfile = 'release',
  [string]$Target = '',
  [string]$Output = '',
  [switch]$SkipBuild,
  [switch]$ReleaseIdentity
)
$ErrorActionPreference = 'Stop'

# The release identity (dr-platform's `RELEASE`, the 0.1 Tauri installer's;
# identity.rs checks these lines). The development one is drifting.nsi's
# defaults.
$releaseProductName = 'Drifting'
$releaseBundleId = 'cc.drifting.client'
$releaseUrlScheme = 'drifting'
if ($ReleaseIdentity -and $BuildProfile -ne 'dist') {
  throw '-ReleaseIdentity builds the shipped build only: add -BuildProfile dist'
}

$next = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Output) { $Output = Join-Path $next 'target\bundle' }
New-Item -ItemType Directory -Force -Path $Output | Out-Null

$manifest = Get-Content (Join-Path $next 'app\drifting\Cargo.toml')
$version = ($manifest | Select-String -Pattern '^version = "(.*)"$' | Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $version) { throw 'no version in app/drifting/Cargo.toml' }
# VIProductVersion takes four numbers: 0.2.0-dev -> 0.2.0.0
$numeric = "$($version.Split('-')[0]).0"
if ($ReleaseIdentity -and $version -like '*-dev*') {
  throw "-ReleaseIdentity: app/drifting/Cargo.toml says $version; a release has a release version"
}

if (-not $SkipBuild) {
  $cargo = @('build', '--locked', '-p', 'drifting')
  if ($BuildProfile -eq 'release') { $cargo += '--release' }
  if ($BuildProfile -eq 'dist') { $cargo += @('--profile', 'dist') }
  if ($Target) { $cargo += @('--target', $Target) }
  if ($ReleaseIdentity) { $cargo += @('--no-default-features', '--features', 'release-identity') }
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

$arch = switch -Wildcard ($Target) {
  'aarch64*' { 'arm64' }
  'x86_64*'  { 'x64' }
  ''         { if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' } }
  default    { throw "unsupported Windows target '$Target' (expected x86_64-pc-windows-msvc or aarch64-pc-windows-msvc)" }
}
$fontsDir = if ($env:DRIFTING_FONTS_DIR) { $env:DRIFTING_FONTS_DIR } else { Join-Path $next '.cache\fonts' }
$faces = @(
  'DriftingSans-Regular.ttf',
  'DriftingSans-Medium.ttf',
  'DriftingSans-SemiBold.ttf',
  'DriftingSerif-Regular.ttf',
  'DriftingSerif-Bold.ttf',
  'SarasaMonoSC-Regular.ttf',
  'OFL-1.1.txt'
)
$hasAllFonts = ($faces | Where-Object { -not (Test-Path (Join-Path $fontsDir $_)) }).Count -eq 0
$productName = if ($ReleaseIdentity) { $releaseProductName } else { 'Drifting Next' }
$installer = Join-Path $Output "$($productName.Replace(' ', '_'))_${version}_windows_${arch}-setup.exe"
$nsisArgs = @(
  '/V2',
  '/INPUTCHARSET', 'UTF8',
  "/DVERSION=$version",
  "/DVERSION_NUMERIC=$numeric",
  "/DEXE_SOURCE=$exe",
  "/DOUTFILE=$installer"
)
if ($ReleaseIdentity) {
  $nsisArgs += @(
    "/DPRODUCT_NAME=$releaseProductName",
    "/DBUNDLE_ID=$releaseBundleId",
    "/DURL_SCHEME=$releaseUrlScheme"
  )
}
if ($hasAllFonts) {
  $nsisArgs += "/DFONTS_DIR=$fontsDir"
}
$nsisArgs += (Join-Path $PSScriptRoot 'windows\drifting.nsi')
& $makensis @nsisArgs
if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
$size = [math]::Round((Get-Item $installer).Length / 1MB, 1)
Write-Output "bundle-windows: $installer ($size MiB)"
Write-Output "installer=$installer"
$pdb = Join-Path $targetDir 'drifting.pdb'
if ($BuildProfile -eq 'dist' -and (Test-Path $pdb)) { Write-Output "pdb=$pdb" }
