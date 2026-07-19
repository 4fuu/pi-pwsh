# Smoke test for the pi-pwsh job prelude (src/prelude.ps1).
# Every Invoke-Pwsh call is a fresh pwsh process — exactly like a pwsh tool call —
# so this verifies that jobs genuinely persist across calls via the file registry.
$ErrorActionPreference = 'Stop'
$prelude = Join-Path $PSScriptRoot '..' 'src' 'prelude.ps1'
$jobDir = Join-Path $env:TEMP 'pi-pwsh-jobs'

$script:pass = 0; $script:fail = 0
function Invoke-Pwsh([string]$cmd) {
    $q = "'" + ($prelude -replace "'", "''") + "'"
    $full = ". $q; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; `$OutputEncoding = [System.Text.Encoding]::UTF8; $cmd"
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
$sleeperAlive = Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sleeper' }
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
