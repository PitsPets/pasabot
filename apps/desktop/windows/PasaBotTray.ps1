# PasaBot tray for Windows 10/11 (W26). Only what ships with Windows: PowerShell 5.1 + WinForms NotifyIcon; no
# extra runtime, no admin rights. It draws what the launcher describes (one JSON object per line on its stdout, see
# apps/desktop/src/main.ts) and sends commands back on its stdin; every word comes translated from the launcher.
# The launcher opens PasaBot itself (--open-urls --app-window): in its own app window (Edge in app mode, with
# PasaBot's own profile), so this script never handles a link, and a setup code never passes through it.
# Started (hidden, no console flash) by the Start-menu shortcut or PasaBot.cmd:
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File PasaBotTray.ps1
# Not run on a Windows PC by the author (built on a Mac): selftest.ps1 checks it there (syntax, start, stop).
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'PasaBotIcon.ps1')
$node = Join-Path $here 'node.exe'
$payload = Join-Path $here 'payload.json'
$root = Join-Path $here 'pasabot'
$app = Join-Path $here 'PasaBot.cmd'
$pbHome = if ($env:PASABOT_HOME) { $env:PASABOT_HOME } else { Join-Path $env:USERPROFILE '.pasabot' }
$logDir = Join-Path $pbHome 'logs'
$log = Join-Path $logDir 'desktop.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$text) {
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    [System.IO.File]::AppendAllText($log, "$([DateTime]::Now.ToString('s')) $text`r`n", $utf8)
  } catch {}
}

# quote one argument for the launcher's command line (CreateProcess rules); Windows paths never hold a quote
function Quote([string]$s) {
  if ($s -match '"') { throw "argument has a quote: $s" }
  if ($s -match '\\$') { $s = $s + '\' }
  return '"' + $s + '"'
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$launchArgs = @((Quote "$root\apps\desktop\dist\main.js"), '--payload', (Quote $payload), '--app', (Quote $app), '--open-urls', '--app-window')
# the Windows display language, when there is one (the invariant culture has no name): a plain tag only
$lang = [System.Globalization.CultureInfo]::CurrentUICulture.Name
if ($lang -and $lang -match '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$') { $launchArgs += @('--locale', $lang) }
if ($NoOpen) { $launchArgs += '--no-browser' }
$psi.Arguments = $launchArgs -join ' '
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.StandardOutputEncoding = $utf8
$psi.StandardErrorEncoding = $utf8
$psi.WorkingDirectory = $here

$icons = @{ running = (New-PasaBotIcon 'running'); stopped = (New-PasaBotIcon 'stopped'); problem = (New-PasaBotIcon 'problem') }
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = $icons.stopped
$icon.Text = 'PasaBot'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$icon.ContextMenuStrip = $menu
$script:status = $null
$script:launcher = $null
$script:hinted = $false

function Send($obj) {
  $l = $script:launcher
  if ($l -and -not $l.HasExited) {
    try { $l.StandardInput.WriteLine(($obj | ConvertTo-Json -Compress)); $l.StandardInput.Flush() } catch {}
  }
}

# NotifyIcon.Text takes at most 63 characters on Windows PowerShell (.NET Framework)
function Set-Tip([string]$text) {
  if (-not $text) { $text = 'PasaBot' }
  if ($text.Length -gt 63) { $text = $text.Substring(0, 62) + [char]0x2026 }
  $icon.Text = $text
}

function Add-Item($text, $enabled, $checked, $onClick) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem([string]$text)
  $item.Enabled = [bool]$enabled
  if ($null -ne $checked) { $item.Checked = [bool]$checked }
  if ($onClick) { $item.add_Click($onClick) }
  [void]$menu.Items.Add($item)
  return $item
}

function Rebuild {
  $menu.Items.Clear()
  $s = $script:status
  if ($null -eq $s) { [void](Add-Item 'PasaBot' $false $null $null); return }
  $l = $s.labels
  [void](Add-Item $l.status $false $null $null)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $open = Add-Item $l.open $s.can.open $null { Send @{ cmd = 'open' } }
  $open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
  [void](Add-Item $l.stopAll $s.can.stopAll $null { Send @{ cmd = 'stop-all' } })
  if ($s.can.stop) { [void](Add-Item $l.stop $true $null { Send @{ cmd = 'stop' } }) }
  else { [void](Add-Item $l.start $s.can.start $null { Send @{ cmd = 'start' } }) }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void](Add-Item $l.autostart $s.autostartAvailable $s.autostart { Send @{ cmd = 'autostart'; on = -not $script:status.autostart } })
  [void](Add-Item $l.updateCheck $true $s.updateCheck { Send @{ cmd = 'update-check'; on = -not $script:status.updateCheck } })
  if ($s.updateCheck) { [void](Add-Item $l.checkNow $true $null { Send @{ cmd = 'check-now' } }) }
  if ($s.updateLine) { [void](Add-Item $s.updateLine ($null -ne $s.updatePage) $null { Send @{ cmd = 'open-update' } }) }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void](Add-Item $l.logs $true $null { Send @{ cmd = 'logs' } })
  [void](Add-Item $l.quit $true $null { [System.Windows.Forms.Application]::Exit() })
}

function Set-State($s) {
  $state = if ($s.server -eq 'failed') { 'problem' } elseif ($s.server -eq 'running' -and -not $s.allStopped) { 'running' } elseif ($s.server -eq 'external') { 'running' } else { 'stopped' }
  $icon.Icon = $icons[$state]
  Set-Tip "$($s.labels.title): $($s.labels.status)"
}

# the first time: Windows hides new tray icons under the ^ arrow, so say once where PasaBot went
function Show-HintOnce($s) {
  if ($script:hinted) { return }
  $script:hinted = $true
  $flag = Join-Path $pbHome 'run\tray-hint-shown'
  if (Test-Path -LiteralPath $flag) { return }
  if ($s.labels.trayHint) {
    $icon.BalloonTipTitle = [string]$s.labels.title
    $icon.BalloonTipText = [string]$s.labels.trayHint
    $icon.ShowBalloonTip(8000)
  }
  try { New-Item -ItemType File -Force -Path $flag | Out-Null } catch {}
}

# a left click opens PasaBot, as people expect of a tray icon (the right click shows the menu; a double click is
# one left click to WinForms, so it opens one window, not two)
$icon.add_MouseClick({ param($sender, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send @{ cmd = 'open' } } })


try {
  $script:launcher = [System.Diagnostics.Process]::Start($psi)
} catch {
  Write-Log "tray: could not start the launcher: $($_.Exception.Message)"
  [void][System.Windows.Forms.MessageBox]::Show("PasaBot could not start.`r`n$($_.Exception.Message)`r`n`r`n$log", 'PasaBot')
  foreach ($i in $icons.Values) { $i.Dispose() }
  exit 1
}
$launcher = $script:launcher
$errText = $launcher.StandardError.ReadToEndAsync()
$reader = $launcher.StandardOutput
$script:pending = $reader.ReadLineAsync()

function Show-Failure {
  $code = $null
  try { if ($launcher.WaitForExit(5000)) { $code = $launcher.ExitCode } } catch {}
  $err = ''
  try { if ($errText.Wait(2000)) { $err = [string]$errText.Result } } catch {}
  if ($err) { Write-Log ("launcher: " + $err.Trim()) }
  if ($code -ne 0 -and $null -ne $code) {
    $tail = ($err.Trim() -split "`r?`n" | Select-Object -Last 5) -join "`r`n"
    $title = if ($script:status) { [string]$script:status.labels.title } else { 'PasaBot' }
    $lead = if ($script:status -and $script:status.labels.trayFailed) { [string]$script:status.labels.trayFailed } else { 'PasaBot could not start. Details are in this file:' }
    [void][System.Windows.Forms.MessageBox]::Show("$lead`r`n$log`r`n`r`n$tail", $title)
  }
}

# read the launcher's events on a timer (WinForms is single-threaded)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  while ($script:pending.IsCompleted) {
    $line = $null
    try { $line = $script:pending.Result } catch { $line = $null }
    if ($null -eq $line) {
      $timer.Stop()
      Show-Failure
      [System.Windows.Forms.Application]::Exit()
      return
    }
    $e = $null
    try { $e = $line | ConvertFrom-Json } catch { $e = $null }
    if ($e) {
      switch ($e.event) {
        'status' { $script:status = $e; Set-State $e; Rebuild; Show-HintOnce $e }
        # a second PasaBot started while this one runs: the launcher opened the window, this copy only quits
        'already-running' { $timer.Stop(); [System.Windows.Forms.Application]::Exit(); return }
        'reveal' { try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + [string]$e.path + '"') } catch {} }
        'notice' { [void][System.Windows.Forms.MessageBox]::Show([string]$e.text, 'PasaBot') }
      }
    }
    $script:pending = $reader.ReadLineAsync()
  }
})

try {
  $icon.Visible = $true
  Rebuild
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  # never a ghost icon: hide and free it however this ends
  $timer.Stop()
  $icon.Visible = $false
  $icon.Dispose()
  foreach ($i in $icons.Values) { $i.Dispose() }
  # closing stdin tells the launcher to stop the server and exit; it kills the server tree if it must
  try { $launcher.StandardInput.Close() } catch {}
  try { if (-not $launcher.WaitForExit(15000)) { $launcher.Kill() } } catch {}
}
