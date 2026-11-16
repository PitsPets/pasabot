# "Check this computer": a thin wrapper (W26 proof kit). The checks themselves are JavaScript run by the bundled
# node.exe (apps\desktop\src\selftest.ts), so they also run where an application control policy (Smart App Control)
# puts unsigned PowerShell in Constrained Language Mode. This wrapper uses only cmdlets and the call operator, which
# that mode allows. The Start-menu entry runs node.exe directly; CI and older shortcuts call this file.
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\PasaBot\selftest.ps1" [-Pause]
param([switch]$Pause, [string]$InstallDir = '')
$here = if ($InstallDir) { $InstallDir } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$node = Join-Path $here 'node.exe'
$js = Join-Path $here 'pasabot\apps\desktop\dist\selftest.js'
$a = @($js, '--install', $here)
if ($Pause) { $a += '--pause' }
& $node @a
exit $LASTEXITCODE
