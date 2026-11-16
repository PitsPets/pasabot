# Build the Windows package (W26) on a Windows 10/11 PC or a windows-latest CI runner. NOT RUN by the author (no
# Windows machine); .github/workflows/desktop.yml runs it, then selftest.ps1 on the result.
# Produces apps\desktop\out\PasaBot\ (a portable folder) and, when Inno Setup's iscc.exe is found,
# apps\desktop\out\PasaBot-Setup-<version>.exe (per-user install, no admin). Self-contained: it carries its own
# node.exe, so the person installs nothing else. Unsigned: signing is the owner's step.
#   powershell -ExecutionPolicy Bypass -File apps\desktop\windows\build-windows.ps1 [-NodeExe C:\path\node.exe] [-UpdateUrl https://...]
param(
  [string]$NodeExe = '',
  [string]$UpdateUrl = '',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $here '..\..\..')).Path
$out = Join-Path $root 'apps\desktop\out'
$dest = Join-Path $out 'PasaBot'
$payloadRoot = Join-Path $dest 'pasabot'
if ($UpdateUrl -and -not $UpdateUrl.StartsWith('https://')) { throw '-UpdateUrl must be https' }
if (-not $NodeExe) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw 'build-windows: node.exe not found; install Node 22+ or pass -NodeExe' }
  $NodeExe = $cmd.Source
}
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "build-windows: $NodeExe does not exist" }

# a native command's failure stops the build (PowerShell 5.1 does not do that by itself)
function Run([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "build-windows: $what failed (exit $LASTEXITCODE)" }
}
# robocopy: 0-7 are kinds of success, 8 and up are failures. /XJ: never through a junction (pnpm's node_modules is
# made of them, some in cycles), /XD: never a dependency or git folder, even one that is a real folder
function Copy-Tree([string]$from, [string]$to, [string[]]$extra) {
  & robocopy $from $to @extra /XJ /XD node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "build-windows: robocopy $from failed (exit $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

Push-Location $root
try {
  if (-not $SkipBuild) {
    Run 'pnpm install' { npx --yes pnpm@12.18.0 install --frozen-lockfile }
    Run 'build' { npx --yes pnpm@12.18.0 -r run build }
  }
} finally { Pop-Location }
$version = (Get-Content -Raw (Join-Path $root 'apps\server\package.json') | ConvertFrom-Json).version

Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $payloadRoot | Out-Null
# the same selection as the macOS copy payload: built output, manifests, locales, data, release keys
Copy-Tree $root $payloadRoot @('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'LICENSE', 'NOTICE')
# Walk the sources by hand: Windows PowerShell 5.1's Get-ChildItem -Recurse goes through junctions, and pnpm's
# node_modules is a mesh of them (some in cycles). Skipped names and every link are left out BEFORE going in.
$skipNames = @('node_modules', '.git', '.claude', 'out', 'e2e', 'coverage', 'test-results', '__fixtures__')
# copied whole wherever they are; catalog and the release keys only at their one place (as the macOS copy does).
# Not a bare 'skills': that name is also the skills module's own folder (catalog\skills comes with catalog, a
# module's built skills with its dist).
$dataNames = @('dist', 'locales', 'migrations')
$dataPaths = @('catalog', 'deploy\release-keys')
$pkgDirs = New-Object System.Collections.ArrayList
$dataDirs = New-Object System.Collections.ArrayList
function Find-Sources([string]$dir) {
  foreach ($c in @(Get-ChildItem -LiteralPath $dir -Force -Directory)) {
    if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    if ($skipNames -contains $c.Name) { continue }
    $rel = $c.FullName.Substring($root.Length + 1)
    if (($dataNames -contains $c.Name) -or ($dataPaths -contains $rel)) { [void]$dataDirs.Add($rel); continue }
    if (Test-Path -LiteralPath (Join-Path $c.FullName 'package.json')) { [void]$pkgDirs.Add($rel) }
    Find-Sources $c.FullName
  }
}
Find-Sources $root
foreach ($rel in $pkgDirs) { Copy-Tree (Join-Path $root $rel) (Join-Path $payloadRoot $rel) @('package.json') }
foreach ($rel in $dataDirs) {
  Copy-Tree (Join-Path $root $rel) (Join-Path $payloadRoot $rel) @('/S', '/XF', '*.test.*', '*.map')
}

# production dependencies, hoisted: a flat node_modules with real folders (no .pnpm store of links, short paths)
Push-Location $payloadRoot
try {
  $env:PATH = "$(Split-Path -Parent $NodeExe);$env:PATH"
  Run 'pnpm install --prod' { npx --yes pnpm@12.18.0 install --prod --frozen-lockfile --config.node-linker=hoisted }
} finally { Pop-Location }

# what is left as links are the workspace packages (@pasabot/*): write them down and remove them; links.ps1 makes
# them again as junctions after install (an installer would copy through them, so every package would load twice)
# Found by hand, never through a link: each link is recorded once and not gone into (Get-ChildItem -Recurse would
# list a nested link twice, directly and through its parent, and the delete below would then fail on the second).
function Find-Links([string]$dir) {
  foreach ($c in @(Get-ChildItem -LiteralPath $dir -Force -Directory)) {
    if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $c } else { Find-Links $c.FullName }
  }
}
$links = @()
foreach ($i in @(Find-Links $payloadRoot)) {
  $target = $i.Target
  if ($target -is [array]) { $target = $target[0] }
  if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $i.FullName) $target }
  $t = [System.IO.Path]::GetFullPath($target)
  if (-not $t.StartsWith($payloadRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "build-windows: $($i.FullName) links outside the payload ($t)"
  }
  $links += [pscustomobject]@{ path = $i.FullName.Substring($payloadRoot.Length + 1); target = $t.Substring($payloadRoot.Length + 1) }
}
# removes the link itself, never what it points to
foreach ($l in $links) { [System.IO.Directory]::Delete((Join-Path $payloadRoot $l.path), $false) }
$left = @(Find-Links $payloadRoot)
if ($left.Count -gt 0) { throw "build-windows: links left in the payload: $($left[0].FullName)" }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $dest 'links.json'), (ConvertTo-Json -InputObject @($links) -Depth 3), $utf8)
Write-Host "build-windows: $($links.Count) workspace links recorded for links.ps1"

# the database's native module must be there for this Node (better-sqlite3 ships a Windows prebuild)
$sqlite = Get-ChildItem -Recurse -File -Filter 'better_sqlite3.node' (Join-Path $payloadRoot 'node_modules') -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $sqlite) { throw 'build-windows: better_sqlite3.node is missing from the payload' }

# long paths: the install folder is %LOCALAPPDATA%\Programs\PasaBot (about 60 characters with a long user name)
$longest = (Get-ChildItem -Recurse -Force -File $dest | ForEach-Object { $_.FullName.Length - $dest.Length } | Measure-Object -Maximum).Maximum
Write-Host "build-windows: longest path inside the package: $longest characters"
if ($longest + 60 -gt 259) { throw "build-windows: a path would pass 260 characters once installed ($longest + 60)" }

Copy-Item $NodeExe (Join-Path $dest 'node.exe')
foreach ($f in 'PasaBotTray.ps1', 'PasaBotIcon.ps1', 'links.ps1', 'selftest.ps1') { Copy-Item (Join-Path $here $f) $dest }
. (Join-Path $here 'PasaBotIcon.ps1')
Save-PasaBotIco (Join-Path $dest 'pasabot.ico')
$updateJson = if ($UpdateUrl) { ConvertTo-Json $UpdateUrl } else { 'null' }
[System.IO.File]::WriteAllText((Join-Path $dest 'payload.json'), "{`"root`":`"pasabot`",`"updateUrl`":$updateJson,`"payload`":`"copy`"}", $utf8)
# what open-at-login starts: the tray, hidden (the console only flashes); `exit` closes the console even when an
# older Startup script STARTed it (cmd /K)
$ascii = New-Object System.Text.ASCIIEncoding
[System.IO.File]::WriteAllText((Join-Path $dest 'PasaBot.cmd'),
  "@echo off`r`nstart `"`" /min `"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0PasaBotTray.ps1`"`r`nexit`r`n", $ascii)

# the portable folder works as it is once its links are made (the installer does that for the installed copy)
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'links.ps1')
if ($LASTEXITCODE -ne 0) { throw 'build-windows: links.ps1 failed on the portable folder' }

$iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $iscc) {
  foreach ($c in "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") {
    if (Test-Path -LiteralPath $c) { $iscc = $c; break }
  }
}
if ($iscc) {
  # the installer must not carry the portable folder's junctions: they are made again on the person's PC
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'links.ps1') -Remove
  & $iscc "/DVersion=$version" "/DSource=$dest" "/O$out" (Join-Path $here 'pasabot.iss')
  if ($LASTEXITCODE -ne 0) { throw "build-windows: iscc failed (exit $LASTEXITCODE)" }
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'links.ps1')
  Write-Host "build-windows: $out\PasaBot-Setup-$version.exe (unsigned)"
} else {
  Write-Host 'build-windows: Inno Setup (iscc.exe) not found; portable folder only'
}
Write-Host "build-windows: $dest (version $version, unsigned)"
