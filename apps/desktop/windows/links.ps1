# The installed copy's folder links (W26, Windows). pnpm links each workspace package (@pasabot/*) into the folders
# that use it; the installer cannot carry links (Inno Setup would copy through them, so every package would exist
# twice and load twice). So build-windows.ps1 writes them down in links.json and removes them, and this script puts
# them back as directory junctions after install (a junction needs no admin rights and no Developer Mode).
#   links.ps1            make the junctions (installer, after copying the files; safe to run again)
#   links.ps1 -Check     only check them; exit 1 when one is missing or wrong (selftest.ps1)
#   links.ps1 -Remove    stop the running PasaBot of this install and remove the junctions (uninstaller, first)
# A junction is made only inside this install folder, to a folder inside it: links.json cannot point elsewhere.
param([switch]$Check, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = [System.IO.Path]::GetFullPath((Join-Path $here 'pasabot'))
$list = Join-Path $here 'links.json'

function Inside([string]$p) {
  $full = [System.IO.Path]::GetFullPath($p)
  return $full.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)
}
function Is-Link([string]$p) {
  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return $i -and ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

if ($Remove) {
  # stop this install's PasaBot first (its launcher pid is in the data folder's lock; only if it runs our launcher)
  $pbHome = if ($env:PASABOT_HOME) { $env:PASABOT_HOME } else { Join-Path $env:USERPROFILE '.pasabot' }
  $lock = Join-Path $pbHome 'run\desktop.lock'
  if (Test-Path -LiteralPath $lock) {
    try {
      $pid0 = [int]((Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).pid)
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pid0"
      if ($p -and $p.CommandLine -and $p.CommandLine.IndexOf($base, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $pid0 /T /F | Out-Null
      }
    } catch {}
  }
}

if (-not (Test-Path -LiteralPath $list)) { if ($Check) { exit 1 } else { exit 0 } }
$links = Get-Content -LiteralPath $list -Raw -Encoding UTF8 | ConvertFrom-Json
$bad = 0
foreach ($l in $links) {
  $path = Join-Path $base ([string]$l.path)
  $target = Join-Path $base ([string]$l.target)
  if (-not (Inside $path) -or -not (Inside $target)) { Write-Output "refused (outside the install): $($l.path)"; $bad++; continue }
  if ($Remove) {
    # a junction is removed as a link only: [IO.Directory]::Delete without recursion never touches its target
    if (Is-Link $path) { [System.IO.Directory]::Delete($path, $false) }
    continue
  }
  if (Is-Link $path) {
    $now = (Get-Item -LiteralPath $path -Force).Target
    if ($now -is [array]) { $now = $now[0] }
    if ($now -and ([System.IO.Path]::GetFullPath($now) -ieq [System.IO.Path]::GetFullPath($target))) { continue }
    if ($Check) { Write-Output "wrong link: $($l.path)"; $bad++; continue }
    [System.IO.Directory]::Delete($path, $false)
  } elseif (Test-Path -LiteralPath $path) {
    Write-Output "in the way (not a link): $($l.path)"; $bad++; continue
  }
  if ($Check) { Write-Output "missing link: $($l.path)"; $bad++; continue }
  if (-not (Test-Path -LiteralPath $target)) { Write-Output "missing target: $($l.target)"; $bad++; continue }
  $parent = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
}
if ($bad -gt 0) { exit 1 }
exit 0
