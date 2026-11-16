# "Check this computer": one command that proves PasaBot works on this Windows PC (W26 proof kit).
# It builds nothing and never touches your own PasaBot data: it starts the installed app's launcher and server on a
# free port with a temporary data folder, checks each piece, stops everything, deletes the temporary folder, and
# prints a short PASS/FAIL table. A text report (no codes, no keys, no passwords) is written next to this script.
#   Start menu > PasaBot > Check this computer        (or)
#   powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\PasaBot\selftest.ps1"
# Written on a Mac without a Windows PC: this script is how the real Windows run is proven.
param([switch]$Pause, [string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
$here = if ($InstallDir) { $InstallDir } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$node = Join-Path $here 'node.exe'
$root = Join-Path $here 'pasabot'
$launcherJs = Join-Path $root 'apps\desktop\dist\main.js'
$appWindowJs = Join-Path $root 'apps\desktop\dist\app-window.js'
$osKeyJs = Join-Path $root 'apps\server\dist\vault\os-key.js'
$payload = Join-Path $here 'payload.json'
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$report = Join-Path $here 'selftest-report.txt'
# only when a check failed: what the test launchers and server said (codes hidden), to send with the report
$logsFile = Join-Path $here 'selftest-logs.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$results = New-Object System.Collections.ArrayList
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pasabot-selftest-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$started = @()
$launchers = @()

# never a setup code, session or password in the report or the logs file
function Hide-Codes([string]$s) {
  $s = $s -replace 'token=[^&#\s"]+', 'token=<hidden>'
  $s = $s -replace '"(token|password|session|secret|key)"\s*:\s*"[^"]*"', '"$1":"<hidden>"'
  return ($s -replace '(?i)\bbearer\s+\S+', 'Bearer <hidden>')
}
function Add-Result([string]$name, [string]$result, [string]$detail = '') {
  $detail = Hide-Codes $detail
  [void]$results.Add([pscustomobject]@{ Check = $name; Result = $result; Detail = $detail })
  $color = switch ($result) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
  Write-Host ("{0,-5} {1}" -f $result, $name) -ForegroundColor $color
  if ($detail) { Write-Host "      $detail" }
}
function Try-Check([string]$name, [scriptblock]$block) {
  try {
    $d = & $block
    if ($d -is [array]) { $d = $d -join ' ' }
    if ($d -like 'SKIP*') { Add-Result $name 'SKIP' ($d -replace '^SKIP:?\s*', '') } else { Add-Result $name 'PASS' ([string]$d) }
  } catch {
    Add-Result $name 'FAIL' $_.Exception.Message
  }
}
function Free-Port {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}
function Quote([string]$s) { if ($s -match '\\$') { $s += '\' }; return '"' + $s + '"' }
# a native program whose errors do not matter (taskkill of a tree that is partly gone, rmdir of a file Edge or
# Defender still holds): Windows PowerShell 5.1 turns redirected stderr into errors, and with 'Stop' the first one
# would end this script. Here they are dropped, and so is the exit code.
function Invoke-Quiet([scriptblock]$block) {
  $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | Out-Null } catch {}
  $global:LASTEXITCODE = 0
}

# who else may open a file or folder: every access-list entry that is not this Windows user
function Get-OtherUsers([string]$path) {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($r in (Get-Acl -LiteralPath $path).Access) {
    $sid = try { $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { [string]$r.IdentityReference }
    if ($sid -ne $me) { [string]$r.IdentityReference }
  }
}

# a launcher with its stdin/stdout wired to us, as the tray runs it. Its stdin is written exactly as the tray writes
# it: Windows PowerShell 5.1 (.NET Framework) has no StandardInputEncoding, so the writer uses the console's input
# code page, and under 65001 (UTF-8) it starts with a BOM; the launcher drops a leading BOM (main.ts parseCommand).
function Start-Launcher([string[]]$extra) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = (@((Quote $launcherJs), '--payload', (Quote $payload), '--home', (Quote $tmp), '--no-browser') + $extra) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $utf8
  $psi.StandardErrorEncoding = $utf8
  $psi.EnvironmentVariables['PASABOT_HOME'] = $tmp
  $p = [System.Diagnostics.Process]::Start($psi)
  $script:started += $p
  # Seen: the name of every event read so far (never its content), for a failed check's detail and the logs file
  $l = [pscustomobject]@{ Name = "launcher $($script:launchers.Count + 1)"; Proc = $p; Err = $p.StandardError.ReadToEndAsync(); Line = $p.StandardOutput.ReadLineAsync(); Seen = (New-Object System.Collections.ArrayList) }
  $script:launchers += $l
  return $l
}
# the next event matching $match within $seconds, else null
function Wait-Event($l, [scriptblock]$match, [int]$seconds) {
  $until = [DateTime]::Now.AddSeconds($seconds)
  while ([DateTime]::Now -lt $until) {
    if ($l.Line.Wait(250)) {
      $text = $l.Line.Result
      if ($null -eq $text) { [void]$l.Seen.Add('(end of output)'); return $null }
      $l.Line = $l.Proc.StandardOutput.ReadLineAsync()
      $e = $null
      try { $e = $text | ConvertFrom-Json } catch {}
      if ($e) { [void]$l.Seen.Add([string]$e.event) } else { [void]$l.Seen.Add('(not JSON)') }
      if ($e -and (& $match $e)) { return $e }
    }
  }
  return $null
}
# the events read since mark $from, for a failed check's detail
function Seen-Since($l, [int]$from) {
  $s = @($l.Seen | Select-Object -Skip $from)
  if ($s.Count) { return ($s -join ', ') } else { return 'none' }
}
function Send($l, $obj) { $l.Proc.StandardInput.WriteLine(($obj | ConvertTo-Json -Compress)); $l.Proc.StandardInput.Flush() }

Write-Host ''
Write-Host 'PasaBot: checking this computer (a test folder, never your own data)' -ForegroundColor Cyan
Write-Host ''
$info = "Windows $([Environment]::OSVersion.Version) $env:PROCESSOR_ARCHITECTURE, PowerShell $($PSVersionTable.PSVersion), $(Get-Date -Format s)"
# how this PowerShell writes a launcher's stdin (see Start-Launcher): the console's input code page, and whether a BOM
# goes first (Windows PowerShell 5.1 under a code page whose encoding has one, such as 65001)
$stdinNote = 'unknown'
try {
  $inEnc = [Console]::InputEncoding
  $bom = $PSVersionTable.PSEdition -ne 'Core' -and $inEnc.GetPreamble().Length -gt 0
  $stdinNote = "code page $($inEnc.CodePage)" + $(if ($bom) { ', a BOM first' } else { ', no BOM' })
} catch {}

Try-Check 'PasaBot is installed' {
  foreach ($f in $node, $launcherJs, (Join-Path $root 'apps\server\dist\host\main.js'), $payload) {
    if (-not (Test-Path -LiteralPath $f)) { throw "missing: $f" }
  }
  $v = & $node --version
  "node $v"
}
Try-Check 'Package links are in place' {
  $out = & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'links.ps1') -Check
  if ($LASTEXITCODE -ne 0) { throw ("links.ps1 -Check: " + (($out | Select-Object -First 3) -join '; ')) }
  'all junctions point inside the install'
}
Try-Check 'Tray scripts are valid PowerShell' {
  $bad = @()
  foreach ($f in 'PasaBotTray.ps1', 'PasaBotIcon.ps1', 'links.ps1', 'selftest.ps1') {
    $tokens = $null; $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $here $f), [ref]$tokens, [ref]$errs)
    if ($errs.Count -gt 0) { $bad += "$f line $($errs[0].Extent.StartLineNumber): $($errs[0].Message)" }
  }
  if ($bad.Count) { throw ($bad -join '; ') }
  '4 scripts parse'
}

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
# any free ports: never the ones your own PasaBot uses
[System.IO.File]::WriteAllText((Join-Path $tmp 'desktop.json'), '{"port":0,"sitesPort":0}', $utf8)
$L1 = $null; $url = $null; $session = $null; $serverPid = $null
try {
  Try-Check 'The app starts (launcher + server)' {
    $script:L1 = Start-Launcher @()
    $s = Wait-Event $script:L1 { param($e) $e.event -eq 'status' -and ($e.server -eq 'running' -or $e.server -eq 'failed') } 120
    if (-not $s) { throw "no 'running' status within 120 s; see $tmp\logs\desktop-server.log" }
    if ($s.server -ne 'running') { throw "the server failed: $($s.labels.status)" }
    $script:url = [string]$s.url
    if ($script:url -notmatch '^http://127\.0\.0\.1:\d+$') { throw "unexpected address $($script:url) (must be 127.0.0.1 only)" }
    $lock = Get-Content -Raw (Join-Path $tmp 'run\desktop.lock') | ConvertFrom-Json
    $script:serverPid = [int]$lock.serverPid
    "listening on $($script:url) (127.0.0.1 only: no firewall prompt)"
  }
  if ($url) {
    Try-Check 'Health answers' {
      $h = Invoke-RestMethod -UseBasicParsing -Uri "$url/api/v1/health" -TimeoutSec 10
      if (-not $h.ok) { throw 'health says not ok' }
      "version $($h.version)"
    }
    Try-Check 'First-run page loads' {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "$url/" -TimeoutSec 10
      if ($r.StatusCode -ne 200 -or $r.Content -notmatch '<html') { throw "HTTP $($r.StatusCode)" }
      $s = Invoke-RestMethod -UseBasicParsing -Uri "$url/api/v1/setup" -TimeoutSec 10
      if (-not $s.needsSetup) { throw 'a fresh data folder should need setup' }
      'the claim page is served'
    }
    $link = $null
    Try-Check 'Setup link is made (private channel)' {
      # the first command this launcher gets, as the tray's first click would be
      $mark = $script:L1.Seen.Count
      Send $script:L1 @{ cmd = 'setup-link' }
      $e = Wait-Event $script:L1 { param($e) $e.event -eq 'setup-link' } 20
      if (-not $e) {
        # which side lost it: the launcher answering a later command (logs -> reveal, nothing opens) means it dropped
        # the first line; no answer at all means it reads no commands
        $seen = Seen-Since $script:L1 $mark
        Send $script:L1 @{ cmd = 'logs' }
        $later = Wait-Event $script:L1 { param($x) $x.event -eq 'reveal' -or $x.event -eq 'setup-link' } 10
        $why = if (-not $later) { 'it answered no later command either' } elseif ($later.event -eq 'setup-link') { 'the link came late' } else { 'it answered a later command, so the first line was lost' }
        throw "no answer within 20 s ($why; events: $seen; stdin: $stdinNote)"
      }
      if (-not $e.url) { throw "the launcher answered without a link (stdin: $stdinNote)" }
      if ([string]$e.url -notmatch '#/setup\?token=([A-Za-z0-9_-]+)') { throw 'the link has no code' }
      $script:link = [string]$e.url
      "a fresh one-time link over the launcher-server channel (stdin: $stdinNote)"
    }
    if ($link) {
      Try-Check 'Claim works' {
        $code = ([regex]::Match($script:link, 'token=([A-Za-z0-9_-]+)')).Groups[1].Value
        $pw = [Guid]::NewGuid().ToString('N')
        $body = @{ token = $code; displayName = 'Selftest'; password = $pw } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$url/api/v1/setup" -ContentType 'application/json' -Body $body -TimeoutSec 20
        if (-not $r.token) { throw 'no session after the claim' }
        $script:session = [string]$r.token
        $again = $null
        try { Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$url/api/v1/setup" -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null; $again = 'accepted' } catch { $again = 'refused' }
        if ($again -ne 'refused') { throw 'the same code worked twice' }
        'owner created; the same code is refused the second time'
      }
    }
    Try-Check 'Data folder is yours only (access list)' {
      $acl = Get-Acl -LiteralPath $tmp
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $others = @()
      foreach ($r in $acl.Access) {
        $sid = try { $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { [string]$r.IdentityReference }
        if ($sid -ne $me) { $others += [string]$r.IdentityReference }
      }
      if (-not $acl.AreAccessRulesProtected) { throw 'inheritance is still on' }
      if ($others.Count) { throw ("also open to: " + (($others | Select-Object -Unique) -join ', ')) }
      'inheritance off, only this Windows user'
    }
    # Windows protection (DPAPI) is for your own data folder only (%USERPROFILE%\.pasabot): a server on any other
    # folder, such as this test one, keeps its key in a vault.key inside that folder (vault/index.ts
    # hostMasterKeySource). So the test server is checked for that, and DPAPI itself is checked on the installed code.
    Try-Check 'Test folder keeps its own vault key' {
      $k = Join-Path $tmp 'vault.key'
      if (-not (Test-Path -LiteralPath $k)) { throw 'no vault.key in the test folder: the vault did not open' }
      if (Test-Path -LiteralPath (Join-Path $tmp 'vault.dpapi')) { throw 'the test folder used Windows protection, which is for your own data folder only' }
      $others = @(Get-OtherUsers $k | Select-Object -Unique)
      if ($others.Count) { throw ("vault.key is also open to: " + ($others -join ', ')) }
      'a vault.key only this Windows user can open, inside the test folder'
    }
    Try-Check 'Vault key is protected by Windows (DPAPI)' {
      # the installed server code that keeps your own folder's key (os-key.js dpapiMasterKey, Windows PowerShell's
      # ProtectedData), on an empty folder of its own inside the test folder: it makes a key, then opens it again
      if (-not (Test-Path -LiteralPath $osKeyJs)) { throw "missing: $osKeyJs" }
      $dir = Join-Path $tmp 'dpapi-check'
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      # only lengths and yes/no come back, never the key; a failed DPAPI run adds the start of its error output
      $probe = "import('file:///' + process.argv[1].replace(/\\/g, '/')).then((m) => { const errs = []; const run = (c, a, i) => { const r = m.runKeyTool(c, a, i); if (r.status !== 0) errs.push(String(r.stderr).replace(/\s+/g, ' ').slice(0, 300)); return r; }; try { const a = m.dpapiMasterKey(process.argv[2], false, run); const b = m.dpapiMasterKey(process.argv[2], true, run); console.log(JSON.stringify({ bytes: a.length, same: a.equals(b) })); a.fill(0); b.fill(0); } catch (e) { console.log(JSON.stringify({ error: String((e && e.message) || e), stderr: errs.join(' / ') })); } }).catch((e) => console.log(JSON.stringify({ error: 'import: ' + String((e && e.message) || e) })))"
      $out = & $node --input-type=module -e $probe $osKeyJs $dir
      $r = $null
      try { $r = ($out | Select-Object -Last 1) | ConvertFrom-Json } catch {}
      if ($null -eq $r) { throw "no answer from os-key.js (node exit $LASTEXITCODE)" }
      if ($r.error) { throw ("DPAPI: $($r.error)" + $(if ($r.stderr) { " ($($r.stderr))" } else { '' })) }
      if ($r.bytes -ne 32 -or -not $r.same) { throw "the key did not open again unchanged ($($r.bytes) bytes)" }
      $f = Join-Path $dir 'vault.dpapi'
      if (-not (Test-Path -LiteralPath $f)) { throw 'no vault.dpapi was written' }
      if (Test-Path -LiteralPath (Join-Path $dir 'vault.key')) { throw 'a plain vault.key file was written' }
      Add-Type -AssemblyName System.Security
      $b = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String((Get-Content -Raw $f).Trim()), $null, 'CurrentUser')
      if ($b.Length -ne 32) { throw "unexpected key length $($b.Length)" }
      [Array]::Clear($b, 0, $b.Length)
      'made, opened again and read back with this Windows user''s protection (vault.dpapi, no plain key)'
    }
    Try-Check 'No open local channel (named pipe)' {
      $pipes = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -match 'pasabot' })
      if ($pipes.Count) { throw ("a PasaBot pipe is open: " + ($pipes -join ', ')) }
      'the launcher-server channel is an inherited handle no other program can open'
    }
    Try-Check 'Owner-only notices answer' {
      if (-not $session) { 'SKIP: no owner session (the claim did not work)'; return }
      $n = Invoke-RestMethod -UseBasicParsing -Uri "$url/api/v1/system/notices" -Headers @{ Authorization = "Bearer $session" } -TimeoutSec 10
      $ids = @($n.notices | ForEach-Object { $_.id })
      if ($ids -notcontains 'windows-no-sandbox') { throw 'the no-sandbox card is missing' }
      "cards: $($ids -join ', ')"
    }
    Try-Check 'Brains found on this PC' {
      if (-not $session) { 'SKIP: no owner session'; return }
      $b = Invoke-RestMethod -UseBasicParsing -Uri "$url/api/m/provider-ops/brains" -Headers @{ Authorization = "Bearer $session" } -TimeoutSec 60
      $list = @($b.brains | ForEach-Object { "$($_.name)=$($_.state)" })
      if ($b.serverOs -ne 'windows') { throw 'the brains page does not know it runs on Windows' }
      ($list -join ', ')
    }
  }
  Try-Check 'App window command (argument array)' {
    $probe = "import('file:///' + process.argv[1].replace(/\\/g, '/')).then((m) => { const c = m.appWindowCommand('win32', 'http://127.0.0.1:1/#/setup?token=abc&x=1', { home: 'C:\\h', env: process.env }); console.log(JSON.stringify(c)); })"
    $out = & $node --input-type=module -e $probe $appWindowJs
    $c = $out | ConvertFrom-Json
    if ($null -eq $c) { 'SKIP: no Edge, Chrome or Brave found (PasaBot then opens the default browser)'; return }
    if (-not ([string]$c[0]).ToLower().EndsWith('.exe')) { throw "not an .exe: $($c[0])" }
    if ([string]$c[1][0] -ne '--app=http://127.0.0.1:1/#/setup?token=abc&x=1') { throw 'the link was changed on the way' }
    "$([System.IO.Path]::GetFileName([string]$c[0])) --app=<link> --user-data-dir=<data folder>\app-window"
  }
  Try-Check 'App window opens and closes' {
    if (-not $url) { 'SKIP: no server'; return }
    $probe = "import('file:///' + process.argv[1].replace(/\\/g, '/')).then((m) => console.log(JSON.stringify(m.appWindowCommand('win32', process.argv[2], { home: process.argv[3], env: process.env }))))"
    $c = (& $node --input-type=module -e $probe $appWindowJs "$url/" $tmp) | ConvertFrom-Json
    if ($null -eq $c) { 'SKIP: no Chromium-family browser'; return }
    $argsLine = (@($c[1]) | ForEach-Object { Quote $_ }) -join ' '
    $p = Start-Process -FilePath ([string]$c[0]) -ArgumentList $argsLine -PassThru
    Start-Sleep -Seconds 6
    $alive = -not $p.HasExited
    $win = $false
    # only windows of the browser this check started (never the person's own browser windows)
    foreach ($x in Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension([string]$c[0])) -ErrorAction SilentlyContinue) {
      $mine = $false
      try { $mine = $x.StartTime -ge $p.StartTime.AddSeconds(-1) } catch {}
      if ($mine -and $x.MainWindowHandle -ne 0 -and $x.MainWindowTitle) { $win = $true }
    }
    Invoke-Quiet { & "$env:SystemRoot\System32\taskkill.exe" /PID $p.Id /T /F }
    Start-Sleep -Seconds 2
    if (-not $alive -and -not $win) { throw 'the browser exited at once' }
    if (-not $win) { 'SKIP: started, but no window title could be read (a locked or remote session?)'; return }
    'a PasaBot window opened in app mode and was closed'
  }
  Try-Check 'Second launch hands over (single instance)' {
    if (-not $L1) { 'SKIP: the first launch did not start'; return }
    $L2 = Start-Launcher @('--no-stdin')
    $e = Wait-Event $L2 { param($e) $e.event -eq 'already-running' } 60
    if (-not $L2.Proc.WaitForExit(30000)) { $L2.Proc.Kill(); throw 'the second copy did not quit' }
    if (-not $e) { throw ('no already-running event; ' + ($L2.Err.Result)) }
    'the second copy found the first and quit'
  }
  Try-Check 'Clean stop (nothing left running)' {
    if (-not $L1) { 'SKIP: nothing was started'; return }
    $L1.Proc.StandardInput.Close()
    if (-not $L1.Proc.WaitForExit(30000)) { throw 'the launcher did not quit within 30 s' }
    Start-Sleep -Seconds 1
    if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { throw "the server (pid $serverPid) is still running" }
    if (Test-Path -LiteralPath (Join-Path $tmp 'run\desktop.lock')) { throw 'the lock file was left behind' }
    'launcher and server are gone, the lock is released'
  }
} finally {
  foreach ($p in $started) { try { if (-not $p.HasExited) { $id = $p.Id; Invoke-Quiet { & "$env:SystemRoot\System32\taskkill.exe" /PID $id /T /F } } } catch {} }
  Start-Sleep -Seconds 1
  # a failed check: what the test launchers and server said, kept next to the report before the test folder goes
  # (codes hidden); a run with no failure leaves no such file behind
  try {
    if (@($results | Where-Object { $_.Result -eq 'FAIL' }).Count) {
      $parts = @('PasaBot check of this computer: what the test run logged (codes hidden)', $info, "stdin: $stdinNote")
      foreach ($l in $launchers) {
        $err = ''
        try { if ($l.Err.Wait(3000)) { $err = [string]$l.Err.Result } } catch {}
        $parts += @('', "== $($l.Name): events read: $(Seen-Since $l 0)", "== $($l.Name): error output", $err.TrimEnd())
      }
      foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $tmp 'logs') -File -ErrorAction SilentlyContinue)) {
        $parts += @('', "== logs\$($f.Name) (last 80 lines)")
        $parts += @(Get-Content -LiteralPath $f.FullName -Tail 80 -Encoding UTF8 -ErrorAction SilentlyContinue)
      }
      [System.IO.File]::WriteAllText($logsFile, (Hide-Codes ($parts -join "`r`n")) + "`r`n", $utf8)
    } elseif (Test-Path -LiteralPath $logsFile) {
      Remove-Item -LiteralPath $logsFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "Could not keep the logs of the test run: $($_.Exception.Message)"
  }
  # junction-safe delete of the test folder (rmdir never follows a link)
  Invoke-Quiet { & "$env:SystemRoot\System32\cmd.exe" /c rmdir /s /q "$tmp" }
}

$fail = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
$pass = @($results | Where-Object { $_.Result -eq 'PASS' }).Count
$skip = @($results | Where-Object { $_.Result -eq 'SKIP' }).Count
Write-Host ''
$summary = if ($fail -eq 0) { "ALL GOOD: $pass passed, $skip skipped" } else { "$fail FAILED, $pass passed, $skip skipped" }
Write-Host $summary -ForegroundColor ($(if ($fail -eq 0) { 'Green' } else { 'Red' }))
$lines = @("PasaBot check of this computer", $info, '', ($results | Format-Table -AutoSize -Wrap | Out-String -Width 160).TrimEnd(), '', $summary)
try {
  [System.IO.File]::WriteAllText($report, ($lines -join "`r`n") + "`r`n", $utf8)
  Write-Host "Report: $report"
  if ($fail -gt 0 -and (Test-Path -LiteralPath $logsFile)) { Write-Host "Logs of the test run: $logsFile" }
} catch {
  Write-Host "Could not write the report next to this script: $($_.Exception.Message)"
}
if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close.'; [void][Console]::ReadLine() }
if ($fail -gt 0) { exit 1 } else { exit 0 }
