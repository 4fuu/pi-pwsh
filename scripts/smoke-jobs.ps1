# Smoke test for the pi-pwsh job helpers (src/jobs.ps1).
# Every Invoke-Pwsh call is a fresh pwsh process — exactly like a pwsh tool call —
# so this verifies that jobs genuinely persist across calls via the file registry.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$prelude = Join-Path $PSScriptRoot '..' 'src' 'jobs.ps1'
$jobDir = Join-Path $env:TEMP 'pi-pwsh-jobs'

$script:pass = 0; $script:fail = 0
# Exercise the Node launcher path (the extension passes process.execPath the same way).
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($nodeExe) { $env:PIPWSH_NODE = $nodeExe }
$env:PIPWSH_SESSION_ID = 'pi-pwsh-smoke-session'
function Invoke-Pwsh([string]$cmd) {
    $q = "'" + ($prelude -replace "'", "''") + "'"
    $full = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false); `$OutputEncoding = [System.Text.UTF8Encoding]::new(`$false); if (`$null -ne `$PSStyle) { `$PSStyle.OutputRendering = 'PlainText' }; . $q; $cmd"
    $out = pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $full 2>&1 | Out-String
    return @{ Output = $out; ExitCode = $LASTEXITCODE }
}
function Assert([string]$label, [bool]$cond, [string]$detail = '') {
    if ($cond) { $script:pass++; Write-Host "PASS [$label]" }
    else { $script:fail++; Write-Host "FAIL [$label] $detail" }
}

# Clean slate.
Invoke-Pwsh 'Get-Job | Remove-Job -Force' | Out-Null

# --- 1. quick job: auto name, complete, consume semantics, Tail ---------------
$r = Invoke-Pwsh "Start-Job -ScriptBlock { Write-Output 'hello world' }"
Assert 'start-auto-name' ($r.Output -match 'Job1' -and $r.Output -match 'hello world') $r.Output
$r = Invoke-Pwsh "Wait-Job -Name Job1 | Out-Null; Get-Job -Name Job1"
Assert 'complete-exit0' ($r.Output -match 'Completed') $r.Output
$r = Invoke-Pwsh "Get-Job -Name Job1 | Select-Object -ExpandProperty ExitCode"
Assert 'exitcode-0' ($r.Output.Trim() -eq '0') $r.Output
$r = Invoke-Pwsh "Get-Job -Name Job1 | Select-Object -ExpandProperty HasMoreData"
Assert 'hasmoredata-true' ($r.Output.Trim() -eq 'True') $r.Output
$r = Invoke-Pwsh "Receive-Job -Name Job1"
Assert 'receive-content' ($r.Output -match 'hello world') $r.Output
$r = Invoke-Pwsh "Get-Job -Name Job1 | Select-Object -ExpandProperty HasMoreData"
Assert 'hasmoredata-consumed' ($r.Output.Trim() -eq 'False') $r.Output
$r = Invoke-Pwsh "Receive-Job -Name Job1"
Assert 'receive-consumed-empty' ($r.Output.Trim() -eq '') $r.Output
$r = Invoke-Pwsh "Receive-Job -Name Job1 -Tail 5"
Assert 'receive-tail-ignores-offset' ($r.Output -match 'hello world') $r.Output

# --- 2. exit code propagation: native 42, explicit exit 7 --------------------
Invoke-Pwsh "Start-Job { cmd /c exit 42 } -Name e42" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name e42 | Out-Null; Get-Job -Name e42 | Select-Object State, ExitCode | Out-String"
Assert 'failed-42' ($r.Output -match 'Failed' -and $r.Output -match '42') $r.Output
Invoke-Pwsh "Start-Job { Write-Output 'x'; exit 7 } -Name e7" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name e7 | Out-Null; Get-Job -Name e7 | Select-Object State, ExitCode | Out-String"
Assert 'failed-7' ($r.Output -match 'Failed' -and $r.Output -match '7') $r.Output
$r = Invoke-Pwsh "Receive-Job -Name e7"
Assert 'failed-7-keeps-log' ($r.Output -match 'x') $r.Output
# Cmdlet-only failure (no native call): must be Failed, not Completed/0.
Invoke-Pwsh "Start-Job { Get-Item C:\definitely-missing-pipwsh } -Name ecmdlet" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name ecmdlet | Out-Null; Get-Job -Name ecmdlet | Select-Object State, ExitCode | Out-String"
Assert 'failed-cmdlet' ($r.Output -match 'Failed' -and $r.Output -match '1') $r.Output
# A later successful command must beat a stale native failure code.
Invoke-Pwsh "Start-Job { cmd /c exit 9; Write-Output 'recovered' } -Name stale" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name stale | Out-Null; Get-Job -Name stale | Select-Object State, ExitCode | Out-String"
Assert 'stale-native-code-cleared' ($r.Output -match 'Completed' -and $r.Output -match '0') $r.Output

# --- 3. duplicate name, CJK, Get-Job filters ---------------------------------
Invoke-Pwsh "Start-Job { Write-Output 'keep-me-content' } -Name dup" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name dup | Out-Null; Receive-Job -Name dup -Keep; Write-Host '---'; Receive-Job -Name dup -Keep"
Assert 'receive-keep-rereads' (($r.Output -split '---')[0] -match 'keep-me-content' -and ($r.Output -split '---')[1] -match 'keep-me-content') $r.Output
$r = Invoke-Pwsh "Start-Job { 'dup2' } -Name dup"
Assert 'duplicate-name-errors' ($r.Output -match 'already exists') $r.Output
Invoke-Pwsh "Start-Job { Write-Output '中文输出测试' } -Name cjk" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name cjk | Out-Null; Receive-Job -Name cjk"
Assert 'cjk-utf8' ($r.Output -match '中文输出测试') $r.Output
$r = Invoke-Pwsh "Get-Job -Name 'e*' | Select-Object -ExpandProperty Name"
Assert 'wildcard-name' ($r.Output -match 'e42' -and $r.Output -match 'e7') $r.Output
$r = Invoke-Pwsh "Get-Job -State Failed | Select-Object -ExpandProperty Name"
Assert 'state-filter' ($r.Output -match 'e42' -and $r.Output -notmatch 'Job1') $r.Output

# --- 4. stop kills the tree; pipeline forms ----------------------------------
Invoke-Pwsh "Start-Job { Start-Sleep 300 } -Name sleeper" | Out-Null
Start-Sleep -Seconds 2
$r = Invoke-Pwsh "Get-Job -Name sleeper | Stop-Job"
Assert 'stop-job' ($r.Output -match 'Stopped') $r.Output
$r = Invoke-Pwsh "Get-Job -Name sleeper"
Assert 'stop-persists' ($r.Output -match 'Stopped') $r.Output
# The wrapper's whole tree must be dead: no leftover pwsh running our cmd file.
# (Jobs are launched detached via double-spawn, so check by command line, not parentage.)
$sleeperAlive = Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" |
	Where-Object { $_.CommandLine -match 'sleeper' }
Assert 'tree-killed' ($null -eq $sleeperAlive) ("alive: " + ($sleeperAlive | Out-String))

# --- 5. remove: running needs -Force; then clean everything -------------------
Invoke-Pwsh "Start-Job { Start-Sleep 300 } -Name running2" | Out-Null
Start-Sleep -Seconds 1
$r = Invoke-Pwsh "Remove-Job -Name running2"
Assert 'remove-running-needs-force' ($r.Output -match 'still running') $r.Output
$r = Invoke-Pwsh "Remove-Job -Name running2 -Force"
Assert 'remove-force' ($r.Output -match 'running2') $r.Output
$r = Invoke-Pwsh "Get-Job | Remove-Job -Force | Out-Null; Get-Job"
Assert 'remove-all' ($r.Output.Trim() -eq '') $r.Output
$leftover = Get-ChildItem $jobDir -Filter '*.meta.json' -ErrorAction SilentlyContinue
Assert 'no-leftover-files' ($null -eq $leftover) ($leftover | Out-String)

# --- 5b. env: full session inheritance + explicit -Environment override ------
# Session PATH changes (fnm/scoop shims) are inherited by the job.
Invoke-Pwsh "`$env:PATH = 'C:\pipwsh-mark;' + `$env:PATH; Start-Job { `$env:PATH } -Name envpath" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name envpath | Out-Null; Receive-Job -Name envpath"
Assert 'env-path-inherited' ($r.Output -match 'pipwsh-mark') $r.Output
# Arbitrary session variables (proxies, VIRTUAL_ENV, ...) are inherited too.
Invoke-Pwsh "`$env:PI_PWSH_MARK = 'session-val'; Start-Job { `$env:PI_PWSH_MARK } -Name envinh" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name envinh | Out-Null; Receive-Job -Name envinh"
Assert 'env-session-inherited' ($r.Output -match 'session-val') $r.Output
# -Environment overrides the inherited value.
Invoke-Pwsh "`$env:PI_PWSH_MARK = 'session-only'; Start-Job { `$env:PI_PWSH_MARK } -Name envexp -Environment @{ PI_PWSH_MARK = 'mark-123' }" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name envexp | Out-Null; Receive-Job -Name envexp"
Assert 'env-explicit-override' ($r.Output -match 'mark-123') $r.Output
$r = Invoke-Pwsh "Start-Job { 1 } -Name envbad -Environment @{ 'BAD-NAME' = 'x' }"
Assert 'env-invalid-name' ($r.Output -match 'invalid environment variable name') $r.Output

# --- 5c. abort survival: killing the starting call's tree must spare the job --
$rootScript = Join-Path $env:TEMP 'pi-pwsh-orphan-root.ps1'
$qPrelude = "'" + ($prelude -replace "'", "''") + "'"
[System.IO.File]::WriteAllText($rootScript, ". $qPrelude; Start-Job { Start-Sleep 120 } -Name orph | Out-Null; Start-Sleep 60", [System.Text.Encoding]::UTF8)
$root = Start-Process -FilePath pwsh -ArgumentList @('-NoProfile', '-File', $rootScript) -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(20)
$registered = $false
while ((Get-Date) -lt $deadline) {
	$r = Invoke-Pwsh "Get-Job -Name orph"
	if ($r.Output -match 'Running') { $registered = $true; break }
	Start-Sleep -Milliseconds 300
}
Assert 'orphan-job-started' $registered
& taskkill /PID $root.Id /T /F 2>$null | Out-Null
Start-Sleep 2
$r = Invoke-Pwsh "Get-Job -Name orph"
Assert 'orphan-survives-tree-kill' ($r.Output -match 'Running') $r.Output
Invoke-Pwsh "Remove-Job -Name orph -Force" | Out-Null
Remove-Item $rootScript -Force -ErrorAction SilentlyContinue

# --- 5d. pipe-handle leak: starting a long job must NOT block the call --------
# (A detached job must not inherit this call's stdout pipe; otherwise callers
# block until the job exits — and timeout kills don't unblock them.)
$t = Get-Date
Invoke-Pwsh "Start-Job { Start-Sleep 60 } -Name pipeleak" | Out-Null
$elapsed = [int]((Get-Date) - $t).TotalSeconds
Invoke-Pwsh "Remove-Job -Name pipeleak -Force" | Out-Null
Assert 'start-long-job-returns-fast' ($elapsed -lt 15) ("took ${elapsed}s")

# pwsh launcher fallback (PIPWSH_NODE unset) still launches jobs fine.
$r = Invoke-Pwsh "`$env:PIPWSH_NODE = ''; Start-Job { 'via-ps-launcher' } -Name psl | Out-Null; Wait-Job -Name psl | Out-Null; Receive-Job -Name psl"
Assert 'pwsh-launcher-fallback' ($r.Output -match 'via-ps-launcher') $r.Output

# --- 5e. readiness wait + durable notification metadata ----------------------
Invoke-Pwsh "Start-Job { Write-Output 'booting'; Start-Sleep -Milliseconds 300; Write-Output 'READY on 4321'; Start-Sleep 60 } -Name ready -NotifyOn 'READY on'" | Out-Null
$t = Get-Date
$r = Invoke-Pwsh "Wait-Job -Name ready -Pattern 'READY\s+on' -Timeout 10 | Out-Null; Get-Job -Name ready | Select-Object -ExpandProperty State"
$elapsed = ((Get-Date) - $t).TotalSeconds
Assert 'wait-pattern-releases-running-job' ($elapsed -lt 8 -and $r.Output -match 'Running') ("elapsed=${elapsed}s " + $r.Output)
$meta = Get-Content -LiteralPath (Join-Path $jobDir 'ready.meta.json') -Raw | ConvertFrom-Json
Assert 'notification-metadata' (
	$meta.SessionId -eq 'pi-pwsh-smoke-session' -and
	$meta.InstanceId -match '^[0-9a-f]{32}$' -and
	$meta.NotifyOn -eq 'READY on' -and
	$meta.NotifyOnExit -eq $true -and
	[System.IO.Path]::IsPathFullyQualified([string]$meta.PowerShell)
) ($meta | ConvertTo-Json -Compress)
Invoke-Pwsh "Remove-Job -Name ready -Force" | Out-Null
$boundaryCommand = "Write-Output (('x' * 65535) + '中文READY'); Start-Sleep 60"
Invoke-Pwsh "Start-Job { $boundaryCommand } -Name utf8boundary" | Out-Null
$t = Get-Date
$r = Invoke-Pwsh "Wait-Job -Name utf8boundary -Pattern '中文READY' -Timeout 10 | Out-Null; Get-Job -Name utf8boundary | Select-Object -ExpandProperty State"
$elapsed = ((Get-Date) - $t).TotalSeconds
Assert 'wait-pattern-utf8-chunk-boundary' ($elapsed -lt 8 -and $r.Output -match 'Running') ("elapsed=${elapsed}s " + $r.Output)
Invoke-Pwsh "Remove-Job -Name utf8boundary -Force" | Out-Null
$r = Invoke-Pwsh "Start-Job { 1 } -Name notifylong -NotifyOn '$('中' * 100)'"
Assert 'notify-pattern-byte-limit' ($r.Output -match '256 UTF-8 bytes') $r.Output

# --- 6. stubs, FilePath, Get-JobHelp ------------------------------------------
$r = Invoke-Pwsh "Suspend-Job"
Assert 'stub-suspend' ($r.Output -match 'not supported') $r.Output
$tmpScript = Join-Path $env:TEMP 'pi-pwsh-filepath-test.ps1'
[System.IO.File]::WriteAllText($tmpScript, "Write-Output 'from-file'", [System.Text.Encoding]::UTF8)
Invoke-Pwsh "Start-Job -FilePath '$tmpScript' -Name filejob" | Out-Null
$r = Invoke-Pwsh "Wait-Job -Name filejob | Out-Null; Receive-Job -Name filejob"
Assert 'start-filepath' ($r.Output -match 'from-file') $r.Output
Remove-Item $tmpScript -Force
$r = Invoke-Pwsh "Get-Job | Remove-Job -Force | Out-Null; (Get-JobHelp) -match 'QUICK START'"
Assert 'job-help' ($r.Output.Trim() -eq 'True') $r.Output
Invoke-Pwsh 'Get-Job | Remove-Job -Force' | Out-Null

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ==="
exit $(if ($script:fail -gt 0) { 1 } else { 0 })
