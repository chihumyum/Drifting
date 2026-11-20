<#
.SYNOPSIS
  Checks that the Windows executable starts on a machine that has nothing but
  Windows: no Visual C++ redistributable, no build tree.

.DESCRIPTION
  script/check-windows-standalone.ps1 -Exe <drifting.exe>
  script/check-windows-standalone.ps1 -Installer <...-setup.exe>
                                      [-Product <name>] [-BundleId <id>]
                                      [-StartSeconds <n>]

  -Exe: the executable imports no Visual C++ runtime library. A clean
  Windows has none, and an executable that imports VCRUNTIME140.dll does not
  start there (0xC0000135). A CI runner has the redistributable installed,
  so only the import table shows it (next/.cargo/config.toml links the
  runtime statically).

  -Installer, for CI runners (it installs into the current user's profile
  and changes HKCU; do not run it on a machine you use): installs silently,
  checks the installed executable's imports, starts it and looks at it after
  -StartSeconds, then uninstalls. A start that ends with a loader failure
  fails the check. Any other early exit is reported with the app's log as a
  warning for now: whether a hosted runner can show a GPUI window at all was
  not known when this was written (2026-11-21); once a run shows it can,
  make that a failure too.

  Build the installer in a profile without debug assertions (`dist`): GPUI's
  Windows backend compiles its shaders from the build tree's source files
  when debug assertions are on, so a debug build only starts on the machine
  that built it.
#>
param(
  [string]$Exe = '',
  [string]$Installer = '',
  [string]$Product = 'Drifting Next',
  [string]$BundleId = 'cc.drifting.next.dev',
  [int]$StartSeconds = 30
)
$ErrorActionPreference = 'Stop'
if (-not $Exe -and -not $Installer) { throw 'give -Exe or -Installer' }

function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "check failed: $Message" }
  Write-Output "ok: $Message"
}

# The DLL names in a PE file's import table.
function Get-PeImports([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  if ([BitConverter]::ToUInt32($bytes, $pe) -ne 0x00004550) { throw "$Path is not a PE file" }
  $sectionCount = [BitConverter]::ToUInt16($bytes, $pe + 6)
  $optionalSize = [BitConverter]::ToUInt16($bytes, $pe + 20)
  $optional = $pe + 24
  $magic = [BitConverter]::ToUInt16($bytes, $optional)
  $directories = switch ($magic) {
    0x20B { $optional + 112 }
    0x10B { $optional + 96 }
    default { throw "$Path has an unknown optional header ($magic)" }
  }
  # Data directory 1 is the import table.
  $importRva = [BitConverter]::ToUInt32($bytes, $directories + 8)
  if ($importRva -eq 0) { return @() }
  $sections = $optional + $optionalSize
  $offsetOf = {
    param([uint32]$Rva)
    for ($i = 0; $i -lt $sectionCount; $i++) {
      $s = $sections + $i * 40
      $virtualSize = [BitConverter]::ToUInt32($bytes, $s + 8)
      $virtualAddress = [BitConverter]::ToUInt32($bytes, $s + 12)
      $rawSize = [BitConverter]::ToUInt32($bytes, $s + 16)
      $rawPointer = [BitConverter]::ToUInt32($bytes, $s + 20)
      $span = [Math]::Max($virtualSize, $rawSize)
      if ($Rva -ge $virtualAddress -and $Rva -lt $virtualAddress + $span) {
        return [int]($Rva - $virtualAddress + $rawPointer)
      }
    }
    throw "no section of $Path holds RVA $Rva"
  }
  $names = @()
  $descriptor = & $offsetOf $importRva
  while ($true) {
    $lookup = [BitConverter]::ToUInt32($bytes, $descriptor)
    $nameRva = [BitConverter]::ToUInt32($bytes, $descriptor + 12)
    $thunks = [BitConverter]::ToUInt32($bytes, $descriptor + 16)
    if ($lookup -eq 0 -and $nameRva -eq 0 -and $thunks -eq 0) { break }
    $start = & $offsetOf $nameRva
    $end = [Array]::IndexOf($bytes, [byte]0, $start)
    $names += [System.Text.Encoding]::ASCII.GetString($bytes, $start, $end - $start)
    $descriptor += 20
  }
  return $names
}

function Assert-Standalone([string]$Path) {
  $imports = @(Get-PeImports $Path)
  Assert ($imports.Count -gt 0) "$(Split-Path -Leaf $Path) has an import table ($($imports.Count) libraries)"
  $runtime = @($imports | Where-Object { $_ -match '^(vcruntime|msvcp|vccorlib|concrt|vcomp)\d' })
  if ($runtime.Count -gt 0) {
    throw "check failed: $Path imports $($runtime -join ', '): it does not start on a Windows without the Visual C++ redistributable"
  }
  Write-Output 'ok: no Visual C++ runtime library among the imports'
}

if ($Exe) { Assert-Standalone (Resolve-Path $Exe).Path }
if (-not $Installer) { return }

$installerPath = (Resolve-Path $Installer).Path
$vendorKey = "HKCU:\Software\drifting\$Product"
$process = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
Assert ($process.ExitCode -eq 0) "the installer exits with 0 ($($process.ExitCode))"
$dir = (Get-ItemProperty $vendorKey).'(default)'
$installed = Join-Path $dir 'drifting.exe'
Assert (Test-Path $installed) "the installer put drifting.exe in $dir"
try {
  Assert-Standalone $installed

  # Loader failures: a missing DLL, a wrong-architecture image, a missing
  # entry point, a DLL whose initialization failed.
  $loaderFailures = @(-1073741515, -1073741701, -1073741511, -1073741502)
  $app = Start-Process -FilePath $installed -WorkingDirectory $dir -PassThru
  $null = $app.Handle
  $exited = $app.WaitForExit($StartSeconds * 1000)
  $log = Get-ChildItem (Join-Path $env:LOCALAPPDATA "$BundleId\logs") -Filter *.log -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $exited) {
    $app.Refresh()
    Write-Output "ok: still running after $StartSeconds s (window '$($app.MainWindowTitle)')"
    # Closing the window only hides it to the notification area.
    Stop-Process -Id $app.Id -Force
    $app.WaitForExit(10000) | Out-Null
  } else {
    $code = $app.ExitCode
    Write-Output ('the app exited after its start with {0} (0x{0:X8})' -f $code)
    if ($log) { Get-Content $log.FullName -Tail 40 | ForEach-Object { Write-Output "  log: $_" } }
    if ($loaderFailures -contains $code) {
      throw ('check failed: the installed executable does not load (0x{0:X8})' -f $code)
    }
    Write-Output ('::warning::the installed app exited {0} s or less after its start with 0x{1:X8}; see the log lines above' -f $StartSeconds, $code)
  }
} finally {
  $uninstall = Join-Path $dir 'uninstall.exe'
  if (Test-Path $uninstall) {
    Start-Process -FilePath $uninstall -ArgumentList @('/S', "_?=$dir") -Wait | Out-Null
    Remove-Item -Force -Recurse -LiteralPath $dir -ErrorAction SilentlyContinue
  }
}
Write-Output 'check-windows-standalone: done'
