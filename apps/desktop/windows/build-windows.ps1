# Build the Windows package (W26) on a Windows 10/11 PC or a windows-latest CI runner. NOT RUN by the author (no
# Windows machine); .github/workflows/desktop.yml runs it, then selftest.ps1 on the result.
# Produces apps\desktop\out\PasaBot\ (a portable folder) and, when Inno Setup's iscc.exe is found,
# apps\desktop\out\PasaBot-Setup-<version>.exe (per-user install, no admin). Self-contained: it carries its own
# node.exe, so the person installs nothing else. Unsigned: release-windows.yml signs it (docs/SIGNING.md).
#   powershell -ExecutionPolicy Bypass -File apps\desktop\windows\build-windows.ps1 [-NodeExe C:\path\node.exe] [-UpdateUrl https://...]
#     -SqliteFromSource   compile better-sqlite3 from its pinned source here (node-gyp + MSVC) instead of shipping its
#                         prebuilt binary, so the database engine is our own build and can be signed (CI does this)
#     -NoInstaller        the portable folder only (release-windows.yml signs its files, then compiles the installer)
#     -InstallerOnly      compile the installer from an existing portable folder (after its files were signed)
#     -SignedUninstallerDir <dir>   Inno Setup's SignedUninstaller: the uninstaller is taken, signed, from <dir>
# The folder holds only what PasaBot runs: build-time tools, other systems' binaries and the command shims of every
# node_modules are removed, and scripts\windows-binaries.mjs --strict fails the build when an executable file is not
# in the signing policy.
# Nothing in it needs PowerShell to start, stop or uninstall PasaBot (windows-shell.js, run by node.exe).
param(
  [string]$NodeExe = '',
  [string]$UpdateUrl = '',
  [switch]$SkipBuild,
  [switch]$SqliteFromSource,
  [switch]$NoInstaller,
  [switch]$InstallerOnly,
  [string]$SignedUninstallerDir = ''
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
# the folder links (workspace junctions), made or removed by node.exe (windows-shell.js), never by PowerShell
function Links([string[]]$extra) {
  & (Join-Path $dest 'node.exe') (Join-Path $payloadRoot 'apps\desktop\dist\windows-shell.js') links @extra
  if ($LASTEXITCODE -ne 0) { throw "build-windows: windows-shell.js links $extra failed (exit $LASTEXITCODE)" }
}
function Compile-Installer {
  $iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
  if (-not $iscc) {
    foreach ($c in "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") {
      if (Test-Path -LiteralPath $c) { $iscc = $c; break }
    }
  }
  if (-not $iscc) { Write-Host 'build-windows: Inno Setup (iscc.exe) not found; portable folder only'; return }
  $isccArgs = @("/DVersion=$version", "/DSource=$dest", "/O$out")
  if ($SignedUninstallerDir) { $isccArgs += "/DSignedUninstallerDir=$SignedUninstallerDir" }
  # the installer must not carry the portable folder's junctions: they are made again on the person's PC
  Links @('--remove')
  & $iscc @isccArgs (Join-Path $here 'pasabot.iss')
  $code = $LASTEXITCODE
  Links @()
  if ($code -ne 0) { throw "build-windows: iscc failed (exit $code)" }
  Write-Host "build-windows: $out\PasaBot-Setup-$version.exe (unsigned)"
}

Push-Location $root
try {
  if (-not $SkipBuild -and -not $InstallerOnly) {
    Run 'pnpm install' { npx --yes pnpm@12.18.0 install --frozen-lockfile }
    Run 'build' { npx --yes pnpm@12.18.0 -r run build }
  }
} finally { Pop-Location }
$version = (Get-Content -Raw (Join-Path $root 'apps\server\package.json') | ConvertFrom-Json).version
if ($InstallerOnly) {
  if (-not (Test-Path -LiteralPath (Join-Path $dest 'node.exe'))) { throw "build-windows: no portable folder at $dest" }
  Compile-Installer
  exit 0
}

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

# Only what PasaBot runs (docs/WINDOWS-BINARIES.md): vitest is an optional peer of two workspace packages, so the
# install brings it with vite, rolldown, lightningcss and esbuild (each with a native binary), none of them ever
# loaded at run time; pnpm's command shims (.cmd/.ps1) are never used either, and neither are Playwright's browser
# installer scripts. Removed here, so the set of executables to sign stays small and explicit.
$nm = Join-Path $payloadRoot 'node_modules'
foreach ($d in @('vitest', '@vitest', 'vite', 'rolldown', '@rolldown', 'esbuild', '@esbuild', 'tsx') + @(Get-ChildItem -LiteralPath $nm -Directory -Filter 'lightningcss*' | ForEach-Object { $_.Name })) {
  $p = Join-Path $nm $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
Remove-Item (Join-Path $nm 'playwright-core\bin\*.ps1') -Force -ErrorAction SilentlyContinue
# pnpm writes command shims in every node_modules whose packages depend on one with a command, not only the top one:
# a workspace package's own node_modules too (packages\testkit\node_modules\.bin, for @pasabot/server's command).
# Every node_modules\.bin goes, found by hand and never through a link (the workspace links are still here; going
# through one would reach the same folder twice).
function Remove-Shims([string]$dir) {
  foreach ($c in @(Get-ChildItem -LiteralPath $dir -Force -Directory)) {
    if ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
    if ($c.Name -eq '.bin' -and $c.Parent.Name -eq 'node_modules') { Remove-Item -LiteralPath $c.FullName -Recurse -Force }
    else { Remove-Shims $c.FullName }
  }
}
Remove-Shims $payloadRoot

# what is left as links are the workspace packages (@pasabot/*): write them down and remove them; windows-shell.js makes
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
Write-Host "build-windows: $($links.Count) workspace links recorded for windows-shell.js links"

# the database's native module must be there and load in this Node. better-sqlite3 13 ships prebuilds\<os>-<arch>.node
# (N-API, any Node 22+) and loads the one for the running system before any build\Release copy. So: name the file
# this node.exe needs (with -SqliteFromSource: compile it here from the package's own pinned source, SQLite
# amalgamation included, and put it in that place), drop every other system's prebuild, then really open a database
# with it, resolved the way the server resolves it (from packages\db, walking up to the hoisted node_modules).
$nodeArch = (& $NodeExe -p 'process.arch' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArch -notin @('x64', 'arm64')) { throw "build-windows: $NodeExe reports an unsupported arch '$nodeArch'" }
$dbDir = Join-Path $payloadRoot 'packages\db'
Push-Location $dbDir
try {
  $sqliteDir = (& $NodeExe -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $sqliteDir) { throw 'build-windows: better-sqlite3 is missing from the payload' }
  $prebuild = Join-Path $sqliteDir "prebuilds\win32-$nodeArch.node"
  # the record scripts\windows-binaries.mjs reads: only a build that compiled the engine here may have it signed
  $sqliteRecord = Join-Path $out 'sqlite-from-source.json'
  Remove-Item -LiteralPath $sqliteRecord -Force -ErrorAction SilentlyContinue
  if ($SqliteFromSource) {
    $upstreamHash = if (Test-Path -LiteralPath $prebuild) { (Get-FileHash -Algorithm SHA256 -LiteralPath $prebuild).Hash.ToLower() } else { $null }
    # node-gyp pinned to the version better-sqlite3 itself builds with; --force_build=1: build even though a
    # prebuild exists (binding.gyp skips the build otherwise)
    Push-Location $sqliteDir
    try {
      Run 'better-sqlite3 from source' { npx --yes node-gyp@13.1.0 rebuild --release --force_build=1 }
      $built = Join-Path $sqliteDir 'build\Release\better_sqlite3.node'
      if (-not (Test-Path -LiteralPath $built)) { throw 'build-windows: node-gyp made no build\Release\better_sqlite3.node' }
      Copy-Item -LiteralPath $built -Destination $prebuild -Force
      Remove-Item -LiteralPath (Join-Path $sqliteDir 'build') -Recurse -Force
      $builtHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $prebuild).Hash.ToLower()
      if ($builtHash -eq $upstreamHash) { throw 'build-windows: the compiled better-sqlite3 is byte-identical to the upstream prebuild' }
      $rec = [ordered]@{ builtFromSource = $true; file = "prebuilds/win32-$nodeArch.node"; upstreamSha256 = $upstreamHash; builtSha256 = $builtHash }
      [System.IO.File]::WriteAllText($sqliteRecord, (ConvertTo-Json -InputObject $rec), (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "build-windows: better-sqlite3 compiled from source into prebuilds\win32-$nodeArch.node"
    } finally { Pop-Location }
  }
  if (-not (Test-Path -LiteralPath $prebuild)) { throw "build-windows: better-sqlite3's prebuilds\win32-$nodeArch.node is missing from the payload" }
  Get-ChildItem -LiteralPath (Join-Path $sqliteDir 'prebuilds') -File | Where-Object { $_.Name -ne "win32-$nodeArch.node" } | Remove-Item -Force
  & $NodeExe -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get(); console.log('build-windows: the database module loads (win32-' + process.arch + ')')"
  if ($LASTEXITCODE -ne 0) { throw "build-windows: better-sqlite3 does not load in $NodeExe (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# long paths: the install folder is %LOCALAPPDATA%\Programs\PasaBot (about 60 characters with a long user name)
$longest = (Get-ChildItem -Recurse -Force -File $dest | ForEach-Object { $_.FullName.Length - $dest.Length } | Measure-Object -Maximum).Maximum
Write-Host "build-windows: longest path inside the package: $longest characters"
if ($longest + 60 -gt 259) { throw "build-windows: a path would pass 260 characters once installed ($longest + 60)" }

Copy-Item $NodeExe (Join-Path $dest 'node.exe')
foreach ($f in 'PasaBotTray.ps1', 'PasaBotIcon.ps1', 'selftest.ps1') { Copy-Item (Join-Path $here $f) $dest }
. (Join-Path $here 'PasaBotIcon.ps1')
Save-PasaBotIco (Join-Path $dest 'pasabot.ico')
$updateJson = if ($UpdateUrl) { ConvertTo-Json $UpdateUrl } else { 'null' }
[System.IO.File]::WriteAllText((Join-Path $dest 'payload.json'), "{`"root`":`"pasabot`",`"updateUrl`":$updateJson,`"payload`":`"copy`"}", $utf8)
# what open-at-login starts: windows-shell.js start, run by node.exe (the tray when PowerShell can run it, else the
# launcher alone); `exit` closes the console even when an older Startup script STARTed it (cmd /K)
$ascii = New-Object System.Text.ASCIIEncoding
[System.IO.File]::WriteAllText((Join-Path $dest 'PasaBot.cmd'),
  "@echo off`r`nstart `"`" /min `"%~dp0node.exe`" `"%~dp0pasabot\apps\desktop\dist\windows-shell.js`" start`r`nexit`r`n", $ascii)

# the portable folder works as it is once its links are made (the installer does that for the installed copy)
Links @()

# the executable inventory: every file Windows may run or load, and the release policy for each (fails on a stray)
& $NodeExe (Join-Path $root 'scripts\windows-binaries.mjs') $dest --md (Join-Path $out 'windows-binaries.md') --json (Join-Path $out 'windows-binaries.json') --sqlite-built (Join-Path $out 'sqlite-from-source.json') --strict
if ($LASTEXITCODE -ne 0) { throw 'build-windows: an executable file in the package is not in the signing policy (scripts\windows-binaries.mjs)' }

if (-not $NoInstaller) { Compile-Installer }
Write-Host "build-windows: $dest (version $version, unsigned)"
