#requires -Version 7.0
<#
pi-pwsh background-job helpers — loaded lazily when a job cmdlet is used.

Overrides the PowerShell job cmdlets with implementations backed by REAL
detached OS processes. Native PowerShell jobs live inside the one-shot pwsh
process and die when the tool call ends; these persist across calls. Use the
functions below explicitly; the PowerShell background operator is unsupported.

Storage: $env:TEMP\pi-pwsh-jobs\ — one set of files per job:
  <name>.meta.json  registry entry (id, pid, command, paths, read offset)
  <name>.cmd.ps1    the user command, verbatim
  <name>.wrap.ps1   wrapper: redirects output to the log, records the exit code
  <name>.log        merged output (all streams + native stdout/stderr)
  <name>.exit       exit code (written when the job finishes; absent if killed)

This file is injected only for job-related commands and must produce NO output.
#>

$script:PiPwshJobDir = Join-Path $env:TEMP 'pi-pwsh-jobs'
$script:PiPwshJobObjects = @{}
$script:PiPwshJobSnapshots = @{}

# ---------------------------------------------------------------------------
# Formatting: native-like table view for job objects.
# ---------------------------------------------------------------------------
$script:PiPwshFormatFile = Join-Path $script:PiPwshJobDir 'PiPwsh.Job.Format.ps1xml'
if (-not (Test-Path -LiteralPath $script:PiPwshFormatFile)) {
	$null = New-Item -ItemType Directory -Path $script:PiPwshJobDir -Force
	[System.IO.File]::WriteAllText($script:PiPwshFormatFile, @'
<Configuration><ViewDefinitions><View>
<Name>PiPwsh.Job</Name><ViewSelectedBy><TypeName>PiPwsh.Job</TypeName></ViewSelectedBy>
<TableControl><TableHeaders>
<TableColumnHeader><Width>5</Width></TableColumnHeader>
<TableColumnHeader><Width>16</Width></TableColumnHeader>
<TableColumnHeader><Width>11</Width></TableColumnHeader>
<TableColumnHeader><Width>12</Width></TableColumnHeader>
<TableColumnHeader><Width>30</Width></TableColumnHeader>
<TableColumnHeader/>
</TableHeaders><TableRowEntries><TableRowEntry><TableColumnItems>
<TableColumnItem><PropertyName>Id</PropertyName></TableColumnItem>
<TableColumnItem><PropertyName>Name</PropertyName></TableColumnItem>
<TableColumnItem><PropertyName>State</PropertyName></TableColumnItem>
<TableColumnItem><PropertyName>HasMoreData</PropertyName></TableColumnItem>
<TableColumnItem><PropertyName>Location</PropertyName></TableColumnItem>
<TableColumnItem><PropertyName>Command</PropertyName></TableColumnItem>
</TableColumnItems></TableRowEntry></TableRowEntries></TableControl>
</View></ViewDefinitions></Configuration>
'@)
}
Update-FormatData -PrependPath $script:PiPwshFormatFile

# ---------------------------------------------------------------------------
# Job launcher: a short-lived helper that spawns the job wrapper and exits
# immediately, recording the job PID. The dead launcher breaks the
# ParentProcessId chain that taskkill /T walks, so killing the tree of the
# pwsh call that started a job cannot take the job down. As a side benefit
# the job inherits the launcher parent's FULL session environment (proxy
# vars, VIRTUAL_ENV, fnm PATH, ...) — no registry-environment surprises.
# Two launchers are written: Node (~3x faster to boot; pi itself runs on
# Node, so index.ts passes process.execPath as PIPWSH_NODE) and pwsh
# (fallback when PIPWSH_NODE is unset).
# ---------------------------------------------------------------------------
# Write helper: refresh content only when it differs (avoids breaking running
# launches with constant rewrites, but self-heals stale files after upgrades).
function PiPwshEnsureFile([string]$path, [string]$content) {
	if ((Test-Path -LiteralPath $path) -and ((Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue) -eq $content)) { return }
	try { [System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8) } catch { }
}

$script:PiPwshLauncher = Join-Path $script:PiPwshJobDir '_launcher.ps1'
PiPwshEnsureFile $script:PiPwshLauncher @'
param([string]$PowerShellExecutable, [string]$WrapFile, [string]$PidFile, [string]$PendingMetaFile, [string]$MetaFile, [string]$InstanceId, [string]$WorkingDirectory)
$p = Start-Process -FilePath $PowerShellExecutable -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $WrapFile + '"')) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
try {
	$meta = Get-Content -LiteralPath $PendingMetaFile -Raw -Encoding UTF8 | ConvertFrom-Json
	if ($meta.InstanceId -ne $InstanceId) { throw 'Job metadata instance changed during launch.' }
	$meta.Pid = $p.Id
	$meta.LaunchProcessId = $PID
	$temp = "$MetaFile.$PID.tmp"
	[System.IO.File]::WriteAllText($temp, ($meta | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
	[System.IO.File]::Move($temp, $MetaFile)
	Remove-Item -LiteralPath $PendingMetaFile -Force -ErrorAction SilentlyContinue
	[System.IO.File]::WriteAllText($PidFile, [string]$p.Id, [System.Text.Encoding]::ASCII)
} catch {
	& taskkill /pid $p.Id /T /F *> $null
	throw
}
'@
$script:PiPwshLauncherNode = Join-Path $script:PiPwshJobDir '_launcher.cjs'
PiPwshEnsureFile $script:PiPwshLauncherNode @'
// pi-pwsh job launcher: spawn the job, record its PID, exit.
// Env contract (set by Start-Job): PI_PWSH_L_EXE, PI_PWSH_L_ARGS (JSON
// array), PI_PWSH_L_WD, PI_PWSH_L_PID, PI_PWSH_L_PENDING_META,
// PI_PWSH_L_META, and PI_PWSH_L_INSTANCE. The child inherits THIS process env
// (= the calling pwsh session env) — full environment inheritance for jobs.
// NOTE: no `detached: true` — on Windows that creates the child with
// DETACHED_PROCESS (no console), and console apps like pwsh die instantly.
// Detachment from taskkill /T comes from THIS process exiting immediately
// after the spawn, which breaks the ParentProcessId chain.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.env.PI_PWSH_L_EXE, JSON.parse(process.env.PI_PWSH_L_ARGS), {
	cwd: process.env.PI_PWSH_L_WD,
	windowsHide: true,
	stdio: "ignore",
});
try {
	const meta = JSON.parse(fs.readFileSync(process.env.PI_PWSH_L_PENDING_META, "utf8"));
	if (meta.InstanceId !== process.env.PI_PWSH_L_INSTANCE) throw new Error("Job metadata instance changed during launch");
	meta.Pid = child.pid;
	meta.LaunchProcessId = process.pid;
	const temporary = `${process.env.PI_PWSH_L_META}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(meta), "utf8");
	fs.renameSync(temporary, process.env.PI_PWSH_L_META);
	fs.rmSync(process.env.PI_PWSH_L_PENDING_META, { force: true });
	fs.writeFileSync(process.env.PI_PWSH_L_PID, String(child.pid), "ascii");
} catch (error) {
	require("node:child_process").spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	throw error;
}
child.unref();
'@

# ---------------------------------------------------------------------------
# Internal helpers (PiPwsh* prefix — not part of the public surface).
# ---------------------------------------------------------------------------

function PiPwshQuote([string]$s) { "'" + ($s -replace "'", "''") + "'" }

function PiPwshReadMeta([string]$name) {
	$path = Join-Path $script:PiPwshJobDir "$name.meta.json"
	if (-not (Test-Path -LiteralPath $path)) { return $null }
	try { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
}

function PiPwshWriteJsonAtomic([string]$path, $value) {
	$temp = "$path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
	try {
		[System.IO.File]::WriteAllText($temp, ($value | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
		[System.IO.File]::Move($temp, $path, $true)
	} finally {
		Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
	}
}

function PiPwshWriteMeta($meta) {
	PiPwshWriteJsonAtomic (Join-Path $script:PiPwshJobDir ($meta.Name + '.meta.json')) $meta
}

function PiPwshMarkFinalOutputPresented($meta) {
	$instanceId = [string]$meta.InstanceId
	if ($instanceId -notmatch '^[0-9a-f]{32}$') { return }
	$path = Join-Path $script:PiPwshJobDir ("$instanceId.exit.presented")
	$stream = $null
	try {
		$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
	} catch [System.IO.IOException] {
		# Another final read already created the marker.
	} finally {
		if ($stream) { $stream.Dispose() }
	}
}

function PiPwshAllMeta() {
	if (-not (Test-Path -LiteralPath $script:PiPwshJobDir)) { return }
	Get-ChildItem -LiteralPath $script:PiPwshJobDir -Filter '*.meta.json' -File -ErrorAction SilentlyContinue |
		ForEach-Object { PiPwshReadMeta ($_.BaseName -replace '\.meta$', '') } |
		Where-Object { $null -ne $_ }
}

function PiPwshExitCode($meta) {
	if (-not (Test-Path -LiteralPath $meta.ExitFile)) { return $null }
	try {
		$raw = (Get-Content -LiteralPath $meta.ExitFile -Raw -Encoding UTF8).Trim()
		$code = 0
		if ([int]::TryParse($raw, [ref]$code)) { return $code }
	} catch { }
	return $null
}

function PiPwshState($meta) {
	$code = PiPwshExitCode $meta
	if ($null -ne $code) {
		return @{ State = ($(if ($code -eq 0) { 'Completed' } else { 'Failed' })); ExitCode = $code }
	}
	$alive = $false
	if ([int]$meta.Pid -gt 0) {
		$alive = $null -ne (Get-Process -Id ([int]$meta.Pid) -ErrorAction SilentlyContinue)
	}
	if ($alive) {
		if ($meta.LaunchPending -eq $true -and [int]$meta.LaunchProcessId -gt 0) {
			$launcherAlive = $null -ne (Get-Process -Id ([int]$meta.LaunchProcessId) -ErrorAction SilentlyContinue)
			if ($launcherAlive) { return @{ State = 'Starting'; ExitCode = $null } }
		}
		return @{ State = 'Running'; ExitCode = $null }
	}
	if ($meta.LaunchPending -eq $true -and [int]$meta.Pid -le 0 -and [int]$meta.LaunchProcessId -gt 0) {
		$launcherAlive = $null -ne (Get-Process -Id ([int]$meta.LaunchProcessId) -ErrorAction SilentlyContinue)
		if ($launcherAlive) { return @{ State = 'Starting'; ExitCode = $null } }
	}
	# Killed via Stop-Job: taskkill prevents the wrapper from writing the exit file.
	return @{ State = 'Stopped'; ExitCode = $null }
}

function PiPwshObjectKey($value) {
	$instanceId = [string]$value.InstanceId
	$compactId = $instanceId.Replace('-', '').ToLowerInvariant()
	if (-not [string]::IsNullOrWhiteSpace($instanceId) -and $compactId -ne ('0' * 32)) {
		return $compactId
	}
	return "legacy:$([string]$value.Name):$([string]$value.StartedAt)"
}

function PiPwshCreateSnapshot($meta) {
	$st = PiPwshState $meta
	$logLen = 0
	try { if (Test-Path -LiteralPath $meta.LogFile) { $logLen = (Get-Item -LiteralPath $meta.LogFile).Length } } catch { }
	[pscustomobject]@{
		State       = [string]$st.State
		HasMoreData = $logLen -gt [long]$meta.ReadOffset
		Pid         = [int]$meta.Pid
		ExitCode    = $st.ExitCode
	}
}

function PiPwshObjectSnapshot($job) {
	$key = PiPwshObjectKey $job
	$current = PiPwshReadMeta ([string]$job.Name)
	if ($current -and (PiPwshObjectKey $current) -eq $key) {
		$script:PiPwshJobSnapshots[$key] = PiPwshCreateSnapshot $current
	}
	if ($script:PiPwshJobSnapshots.ContainsKey($key)) {
		return $script:PiPwshJobSnapshots[$key]
	}
	return $null
}

function PiPwshToObject($meta) {
	$key = PiPwshObjectKey $meta
	$current = PiPwshReadMeta ([string]$meta.Name)
	if ($current -and (PiPwshObjectKey $current) -eq $key) {
		$script:PiPwshJobSnapshots[$key] = PiPwshCreateSnapshot $current
	} elseif (-not $script:PiPwshJobSnapshots.ContainsKey($key)) {
		$script:PiPwshJobSnapshots[$key] = PiPwshCreateSnapshot $meta
	}
	if ($script:PiPwshJobObjects.ContainsKey($key)) {
		return $script:PiPwshJobObjects[$key]
	}

	$instanceId = [guid]::Empty
	$null = [guid]::TryParse([string]$meta.InstanceId, [ref]$instanceId)
	$o = [pscustomobject]@{
		Id          = [int]$meta.Id
		Name        = [string]$meta.Name
		InstanceId  = $instanceId
		Location    = [string]$meta.WorkingDirectory
		Command     = [string]$meta.Command
		LogFile     = [string]$meta.LogFile
		StartedAt   = [string]$meta.StartedAt
	}
	$o | Add-Member -MemberType ScriptProperty -Name State -Value {
		$snapshot = PiPwshObjectSnapshot $this
		return $(if ($snapshot) { [string]$snapshot.State } else { 'Stopped' })
	}
	$o | Add-Member -MemberType ScriptProperty -Name JobStateInfo -Value {
		$name = if ([string]$this.State -eq 'Starting') { 'NotStarted' } else { [string]$this.State }
		$state = [System.Enum]::Parse([System.Management.Automation.JobState], $name)
		return [System.Management.Automation.JobStateInfo]::new($state)
	}
	$o | Add-Member -MemberType ScriptProperty -Name HasMoreData -Value {
		$snapshot = PiPwshObjectSnapshot $this
		return $null -ne $snapshot -and [bool]$snapshot.HasMoreData
	}
	$o | Add-Member -MemberType ScriptProperty -Name Pid -Value {
		$snapshot = PiPwshObjectSnapshot $this
		return $(if ($snapshot) { [int]$snapshot.Pid } else { 0 })
	}
	$o | Add-Member -MemberType ScriptProperty -Name ExitCode -Value {
		$snapshot = PiPwshObjectSnapshot $this
		return $(if ($snapshot) { $snapshot.ExitCode } else { $null })
	}
	$o.PSObject.TypeNames.Insert(0, 'PiPwsh.Job')
	$script:PiPwshJobObjects[$key] = $o
	$o
}

# Resolve -Job/-Name/-Id arguments to meta objects. Emits Write-Error for misses.
function PiPwshResolve($jobs, $names, $ids) {
	$found = @()
	foreach ($j in @($jobs)) {
		if ($null -eq $j) { continue }
		$m = $null
		if ($j -is [string]) {
			$m = PiPwshReadMeta $j
		} elseif ($j.PSObject.Properties['Name']) {
			$m = PiPwshReadMeta ([string]$j.Name)
			$instanceId = if ($j.PSObject.Properties['InstanceId']) { [string]$j.InstanceId } else { '' }
			$compactId = $instanceId.Replace('-', '')
			if ($m -and -not [string]::IsNullOrWhiteSpace($instanceId) -and $compactId -ne ('0' * 32) -and (PiPwshObjectKey $m) -ne (PiPwshObjectKey $j)) {
				$m = $null
			}
		}
		if ($m) { $found += $m } else { Write-Error "Job '$j' not found." }
	}
	foreach ($n in @($names)) {
		if ($null -eq $n) { continue }
		$matched = $false
		foreach ($m in @(PiPwshAllMeta)) {
			if ($m.Name -like $n) { $found += $m; $matched = $true }
		}
		if (-not $matched) { Write-Error "No job found matching name '$n'." }
	}
	foreach ($i in @($ids)) {
		if ($null -eq $i) { continue }
		$hit = $null
		foreach ($m in @(PiPwshAllMeta)) { if ([int]$m.Id -eq [int]$i) { $hit = $m; break } }
		if ($hit) { $found += $hit } else { Write-Error "No job found with Id $i." }
	}
	$found | Sort-Object -Property Name -Unique
}

function PiPwshReadLogText($meta, [long]$fromOffset) {
	# Returns @{ Text; Position } — Position is the stream offset actually read
	# up to (NOT the file length afterwards), so bytes appended concurrently by
	# a running job are picked up by the next read instead of being skipped.
	$result = @{ Text = ''; Position = $fromOffset }
	if (-not (Test-Path -LiteralPath $meta.LogFile)) { return $result }
	try {
		$fs = [System.IO.FileStream]::new($meta.LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
		try {
			if ($fromOffset -gt 0) { $null = $fs.Seek($fromOffset, [System.IO.SeekOrigin]::Begin) }
			$sr = [System.IO.StreamReader]::new($fs, [System.Text.Encoding]::UTF8)
			try {
				$result.Text = $sr.ReadToEnd()
				$result.Position = $fs.Position
			} finally { $sr.Dispose() }
		} finally { $fs.Dispose() }
	} catch { }
	return $result
}

function PiPwshReadLogChunk($meta, [long]$fromOffset, $decoder, [int]$maxBytes = 65536) {
	$result = @{ Text = ''; Position = $fromOffset; BytesRead = 0 }
	if (-not (Test-Path -LiteralPath $meta.LogFile)) { return $result }
	try {
		$fs = [System.IO.FileStream]::new($meta.LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
		try {
			if ($fromOffset -gt $fs.Length) { $fromOffset = 0 }
			$null = $fs.Seek($fromOffset, [System.IO.SeekOrigin]::Begin)
			$buffer = [byte[]]::new([Math]::Min([long]$maxBytes, $fs.Length - $fromOffset))
			$count = $fs.Read($buffer, 0, $buffer.Length)
			$result.Position = $fromOffset + $count
			$result.BytesRead = $count
			if ($count -gt 0) {
				$chars = [char[]]::new([System.Text.Encoding]::UTF8.GetMaxCharCount($count))
				$charCount = $decoder.GetChars($buffer, 0, $count, $chars, 0, $false)
				$result.Text = [string]::new($chars, 0, $charCount)
			}
		} finally { $fs.Dispose() }
	} catch { }
	return $result
}

function PiPwshWait($metas, [int]$timeoutSec, [string]$pattern) {
	$deadline = if ($timeoutSec -gt 0) { (Get-Date).AddSeconds($timeoutSec) } else { [DateTime]::MaxValue }
	$regex = $null
	$pending = @{}
	if ($pattern) {
		try {
			$regex = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::CultureInvariant, [TimeSpan]::FromMilliseconds(250))
		} catch { throw "Wait-Job: invalid -Pattern regex: $($_.Exception.Message)" }
		foreach ($m in $metas) {
			$pending[[string]$m.InstanceId] = @{
				Meta = $m
				Position = [long]0
				Window = ''
				Decoder = [System.Text.Encoding]::UTF8.GetDecoder()
			}
		}
	}
	while ($true) {
		$running = 0
		foreach ($m in $metas) {
			$state = (PiPwshState $m).State
			if ($state -eq 'Running') { $running++ }
			if (-not $regex) { continue }
			$key = [string]$m.InstanceId
			$scan = $pending[$key]
			if ($null -eq $scan) { continue }
			try {
				do {
					$chunk = PiPwshReadLogChunk $m ([long]$scan.Position) $scan.Decoder
					$scan.Position = $chunk.Position
					if ($chunk.Text) {
						$scan.Window = ($scan.Window + $chunk.Text)
						if ($scan.Window.Length -gt 65536) { $scan.Window = $scan.Window.Substring($scan.Window.Length - 65536) }
						if ($regex.IsMatch($scan.Window)) { $pending.Remove($key); break }
					}
				} while ($chunk.BytesRead -ge 65536)
			} catch [System.Text.RegularExpressions.RegexMatchTimeoutException] {
				throw 'Wait-Job: -Pattern evaluation timed out. Use a simpler regex.'
			}
			if ($state -ne 'Running') { $pending.Remove($key) }
		}
		if ($regex) {
			if ($pending.Count -eq 0) { return }
		} elseif ($running -eq 0) { return }
		if ((Get-Date) -ge $deadline) { return }
		Start-Sleep -Milliseconds 400
	}
}

function PiPwshKillTree([int]$procId) {
	if ($procId -le 0) { return }
	& taskkill /pid $procId /T /F *> $null
	Start-Sleep -Milliseconds 300
}

# ---------------------------------------------------------------------------
# Public job cmdlets (override the native ones; functions win precedence).
# ---------------------------------------------------------------------------

function Start-Job {
	[CmdletBinding(DefaultParameterSetName = 'ScriptBlock')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'ScriptBlock')]
		[scriptblock]$ScriptBlock,

		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'FilePath')]
		[string]$FilePath,

		[Parameter(Position = 1)]
		[string]$Name,

		[string]$WorkingDirectory,

		# Explicit env overrides/additions, written into the job's wrap script.
		# (The calling session's environment itself is inherited in memory via
		# the launcher — no need to re-inject PATH & friends.)
		[hashtable]$Environment,

		[ValidateLength(1, 256)]
		[string]$NotifyOn
	)

	$jobDir = $script:PiPwshJobDir
	$null = New-Item -ItemType Directory -Path $jobDir -Force

	$command = if ($PSCmdlet.ParameterSetName -eq 'FilePath') {
		$resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($FilePath)
		if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Start-Job: script file not found: $FilePath" }
		"& $(PiPwshQuote $resolved)"
	} else {
		$ScriptBlock.ToString().Trim()
	}
	if ([string]::IsNullOrWhiteSpace($command)) { throw 'Start-Job: empty command.' }
	if ($NotifyOn -and [System.Text.Encoding]::UTF8.GetByteCount($NotifyOn) -gt 256) {
		throw 'Start-Job: -NotifyOn must be at most 256 UTF-8 bytes.'
	}

	$wd = if ($WorkingDirectory) {
		$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkingDirectory)
	} else { $PWD.Path }
	if (-not (Test-Path -LiteralPath $wd -PathType Container)) { throw "Start-Job: working directory not found: $wd" }

	$mutex = [System.Threading.Mutex]::new($false, 'pi-pwsh-jobs-lock')
	$locked = $false
	try {
		try {
			$locked = $mutex.WaitOne(10000)
		} catch [System.Threading.AbandonedMutexException] {
			# Previous owner was killed while holding the lock (e.g. taskkill on
			# abort/timeout). The mutex is now owned by THIS wait despite the throw.
			$locked = $true
		}
		if (-not $locked) { throw 'Start-Job: timed out acquiring the job registry lock.' }

		$all = @(PiPwshAllMeta)
		if ($Name -and (PiPwshReadMeta $Name)) {
			throw "Start-Job: a job named '$Name' already exists. Remove it first (Remove-Job) or pick another name."
		}
		$maxId = 0
		foreach ($m in $all) { if ([int]$m.Id -gt $maxId) { $maxId = [int]$m.Id } }
		$id = $maxId + 1
		if (-not $Name) { $Name = "Job$id" }
		if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
			throw "Start-Job: invalid name '$Name'. Use letters, digits, '-', '_' and '.'."
		}
		Get-ChildItem -LiteralPath $jobDir -Filter "$Name.meta.pending.*.json" -File -ErrorAction SilentlyContinue |
			Remove-Item -Force -ErrorAction SilentlyContinue

		$innerFile = Join-Path $jobDir "$Name.cmd.ps1"
		$wrapFile  = Join-Path $jobDir "$Name.wrap.ps1"
		$logFile   = Join-Path $jobDir "$Name.log"
		$exitFile  = Join-Path $jobDir "$Name.exit"
		Remove-Item -LiteralPath $exitFile, $logFile -Force -ErrorAction SilentlyContinue

		# -Environment: explicit overrides/additions. The session environment
		# itself is inherited via the launcher; these win on conflict.
		$envLines = ''
		if ($Environment) {
			foreach ($k in $Environment.Keys) {
				if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Start-Job: invalid environment variable name '$k'. Use letters, digits and '_'." }
				$envLines += "`$env:$k = $(PiPwshQuote ([string]$Environment[$k]))`n"
			}
		}

		$utf8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); if ($null -ne $PSStyle) { $PSStyle.OutputRendering = "PlainText" };'
		# Capture the exact exit code, drain PowerShell's object formatter, then
		# exit. Exiting directly after the user command drops unformatted objects.
		# This mirrors wrapPowerShellCommand in src/spawn.ts.
		$strict = if ($env:PIPWSH_STOP_ON_ERROR -eq '1') { "`$ErrorActionPreference = 'Stop';`n" } else { '' }
		$inner = "$utf8`n$strict`$global:LASTEXITCODE = `$null`n`$global:__pipwsh_exit_code = 0`n. {`n$command`n; `$__pipwsh_ok = `$?; `$__pipwsh_native = `$global:LASTEXITCODE; if (`$__pipwsh_ok) { `$global:__pipwsh_exit_code = 0 } elseif (`$null -ne `$__pipwsh_native -and `$__pipwsh_native -ne 0) { `$global:__pipwsh_exit_code = `$__pipwsh_native } else { `$global:__pipwsh_exit_code = 1 }`n} | Out-Default`nexit `$global:__pipwsh_exit_code`n"
		$pwshExe = if ($env:PIPWSH_EXECUTABLE -and (Test-Path -LiteralPath $env:PIPWSH_EXECUTABLE -PathType Leaf)) { $env:PIPWSH_EXECUTABLE } else { Join-Path $PSHOME 'pwsh.exe' }
		$userArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass')
		if ($env:PIPWSH_USER_ARGS) {
			try {
				$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIPWSH_USER_ARGS))
				$parsedArgs = @($json | ConvertFrom-Json)
				if ($parsedArgs.Count -gt 0 -and @($parsedArgs | Where-Object { $_ -isnot [string] }).Count -eq 0) { $userArgs = [string[]]$parsedArgs }
			} catch { }
		}
		$innerArgsJson = (@($userArgs) + @('-File', $innerFile) | ConvertTo-Json -Compress)
		$wrap = @"
$utf8
$envLines`$ec = 1
try {
	Set-Location -LiteralPath $(PiPwshQuote $wd) -ErrorAction Stop
	`$__pipwsh_args = @($(PiPwshQuote $innerArgsJson) | ConvertFrom-Json)
	`$global:LASTEXITCODE = `$null
	& $(PiPwshQuote $pwshExe) @__pipwsh_args *> $(PiPwshQuote $logFile)
	`$__pipwsh_ok = `$?
	`$__pipwsh_native = `$global:LASTEXITCODE
	if (`$__pipwsh_ok) { `$ec = 0 } elseif (`$null -ne `$__pipwsh_native -and `$__pipwsh_native -ne 0) { `$ec = `$__pipwsh_native }
} catch {
	`$_ | Out-String | Add-Content -LiteralPath $(PiPwshQuote $logFile)
}
`$__pipwsh_exit_temp = $(PiPwshQuote $exitFile) + '.' + `$PID + '.tmp'
try {
	[System.IO.File]::WriteAllText(`$__pipwsh_exit_temp, [string]`$ec, [System.Text.Encoding]::ASCII)
	[System.IO.File]::Move(`$__pipwsh_exit_temp, $(PiPwshQuote $exitFile), `$true)
} finally {
	Remove-Item -LiteralPath `$__pipwsh_exit_temp -Force -ErrorAction SilentlyContinue
}
"@
		[System.IO.File]::WriteAllText($innerFile, $inner, [System.Text.Encoding]::UTF8)
		[System.IO.File]::WriteAllText($wrapFile, $wrap, [System.Text.Encoding]::UTF8)
		$instanceId = [guid]::NewGuid().ToString('N')
		$metaFile = Join-Path $jobDir "$Name.meta.json"
		$pendingMetaFile = Join-Path $jobDir "$Name.meta.pending.$instanceId.json"
		$meta = [ordered]@{
			Id               = $id
			Name             = $Name
			InstanceId       = $instanceId
			SessionId        = [string]$env:PIPWSH_SESSION_ID
			Pid              = 0
			LaunchPending    = $true
			LaunchProcessId  = $PID
			Command          = $command
			WorkingDirectory = $wd
			LogFile          = $logFile
			ExitFile         = $exitFile
			StartedAt        = [DateTime]::UtcNow.ToString('o')
			ReadOffset       = 0
			NotifyOnExit     = $true
			NotifyOn         = if ($NotifyOn) { $NotifyOn } else { $null }
			PowerShell       = $pwshExe
			PowerShellArgs   = $userArgs
		}
		# Stage the identity before launch. The short-lived launcher adds the PID
		# and atomically publishes the registry entry before it exits, so every
		# process that can become detached is already manageable if this call aborts.
		PiPwshWriteJsonAtomic $pendingMetaFile $meta

		# Launch DETACHED via double-spawn: a short-lived launcher (child of this
		# pwsh, so it inherits the FULL session environment) spawns the job and
		# exits immediately, recording the job PID. taskkill /T walks
		# ParentProcessId links at kill time — the dead launcher breaks the
		# chain, so abort/timeout of THIS call cannot kill the job.
		# Launcher preference: Node (fast boot, passed in as PIPWSH_NODE) →
		# pwsh launcher → direct Start-Process (child of this process — works,
		# but abort/timeout of this call CAN kill the job).
		$procId = 0
		$pidFile = Join-Path $jobDir "$Name.pid"
		Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
		try {
			if ($env:PIPWSH_NODE -and (Test-Path -LiteralPath $env:PIPWSH_NODE)) {
				$env:PI_PWSH_L_EXE = $pwshExe
				$env:PI_PWSH_L_ARGS = (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $wrapFile) | ConvertTo-Json -Compress)
				$env:PI_PWSH_L_WD = $wd
				$env:PI_PWSH_L_PID = $pidFile
				$env:PI_PWSH_L_PENDING_META = $pendingMetaFile
				$env:PI_PWSH_L_META = $metaFile
				$env:PI_PWSH_L_INSTANCE = $instanceId
				# Start-Process (ShellExecuteEx) is LOAD-BEARING here: it starts the
				# launcher WITHOUT inheriting handles from this process. A plain
				# `& node ...` child inherits EVERY inheritable handle — including the
				# write end of this call's stdout pipe — and libuv's spawn passes all
				# of node's inheritable handles on to the detached job (Windows handle
				# inheritance is all-or-nothing). The job would then keep that pipe
				# open for its whole lifetime, so any caller reading our stdout (pipe
				# consumers, the pwsh tool's close-event) blocks until the JOB exits —
				# even after the job's starting call was killed on timeout/abort.
				# (Redirecting the launcher to $null does NOT help: PowerShell still
				# captures native output through a pipe, and the leaked handle is this
				# call's own stdout pipe, not the launcher's.)
				try {
					$launcher = Start-Process -FilePath $env:PIPWSH_NODE -ArgumentList ('"' + $script:PiPwshLauncherNode + '"') -WindowStyle Hidden -PassThru
					if (-not $launcher.WaitForExit(5000)) { try { $launcher.Kill() } catch { } }
				} finally {
					Remove-Item Env:PI_PWSH_L_EXE, Env:PI_PWSH_L_ARGS, Env:PI_PWSH_L_WD, Env:PI_PWSH_L_PID, Env:PI_PWSH_L_PENDING_META, Env:PI_PWSH_L_META, Env:PI_PWSH_L_INSTANCE -ErrorAction SilentlyContinue
				}
			} else {
				& $pwshExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script:PiPwshLauncher -PowerShellExecutable $pwshExe -WrapFile $wrapFile -PidFile $pidFile -PendingMetaFile $pendingMetaFile -MetaFile $metaFile -InstanceId $instanceId -WorkingDirectory $wd *> $null
			}
			if (Test-Path -LiteralPath $pidFile) {
				$null = [int]::TryParse(((Get-Content -LiteralPath $pidFile -Raw).Trim()), [ref]$procId)
			}
		} catch { }
		Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
		if ($procId -le 0) {
			# Fallback: direct child of this process — abort/timeout of this call
			# CAN kill the job, but the job itself works.
			$p = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $wrapFile + '"')) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
			$procId = $p.Id
		}
		$meta.Pid = $procId
		$meta.LaunchPending = $false
		PiPwshWriteMeta $meta
		Remove-Item -LiteralPath $pendingMetaFile -Force -ErrorAction SilentlyContinue
	} finally {
		if ($locked) { $mutex.ReleaseMutex() }
		$mutex.Dispose()
	}

	PiPwshToObject (PiPwshReadMeta $Name)
}

function Get-Job {
	[CmdletBinding()]
	param(
		[Parameter(Position = 0)]
		[SupportsWildcards()]
		[string[]]$Name,

		[int[]]$Id,

		[ValidateSet('Starting', 'Running', 'Completed', 'Failed', 'Stopped')]
		[string]$State,

		[int]$Newest
	)

	$metas = @(PiPwshAllMeta)
	if ($Name) {
		$metas = @($metas | Where-Object { $n = $_.Name; @($Name | Where-Object { $n -like $_ }).Count -gt 0 })
	}
	if ($Id) {
		$metas = @($metas | Where-Object { $i = [int]$_.Id; @($Id | Where-Object { $i -eq $_ }).Count -gt 0 })
	}
	$objs = @($metas | Sort-Object Id | ForEach-Object { PiPwshToObject $_ })
	if ($State) { $objs = @($objs | Where-Object { $_.State -eq $State }) }
	if ($Newest -gt 0 -and $objs.Count -gt $Newest) { $objs = $objs[-$Newest..-1] }
	$objs
}

function Receive-Job {
	[CmdletBinding(DefaultParameterSetName = 'Job')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Job', ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
		[object[]]$Job,

		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[SupportsWildcards()]
		[string[]]$Name,

		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int[]]$Id,

		[switch]$Keep,
		[switch]$Wait,
		[int]$Tail
	)

	process {
		foreach ($m in @(PiPwshResolve $Job $Name $Id)) {
			if ($Wait) { PiPwshWait @($m) 0 }
			$finalBeforeRead = (PiPwshState $m).State -in 'Completed', 'Failed'

			if ($Tail -gt 0) {
				# Peek at the last N lines without touching the read offset.
				$all = (PiPwshReadLogText $m 0).Text.TrimEnd()
				if ($finalBeforeRead) { PiPwshMarkFinalOutputPresented $m }
				if (-not $all) { continue }
				$lines = $all -split "\r?\n"
				$skip = [Math]::Max(0, $lines.Count - $Tail)
				$lines[$skip..($lines.Count - 1)]
				continue
			}

			$r = PiPwshReadLogText $m ([long]$m.ReadOffset)
			if (-not $Keep) {
				$m.ReadOffset = $r.Position
				PiPwshWriteMeta $m
			}
			if ($finalBeforeRead) { PiPwshMarkFinalOutputPresented $m }
			if ($r.Text) {
				$r.Text.TrimEnd() -split "\r?\n"
			}
		}
	}
}

function Wait-Job {
	[CmdletBinding(DefaultParameterSetName = 'Job')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Job', ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
		[object[]]$Job,

		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[SupportsWildcards()]
		[string[]]$Name,

		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int[]]$Id,

		[ValidateRange(0, 86400)]
		[int]$Timeout,

		[ValidateLength(1, 1024)]
		[string]$Pattern
	)

	begin { $targets = @() }
	process { $targets += @(PiPwshResolve $Job $Name $Id) }
	end {
		$targets | ForEach-Object { $null = PiPwshToObject $_ }
		PiPwshWait $targets $Timeout $Pattern
		$targets | ForEach-Object { PiPwshToObject $_ }
	}
}

function Stop-Job {
	[CmdletBinding(DefaultParameterSetName = 'Job')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Job', ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
		[object[]]$Job,

		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[SupportsWildcards()]
		[string[]]$Name,

		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int[]]$Id
	)

	process {
		foreach ($m in @(PiPwshResolve $Job $Name $Id)) {
			$object = PiPwshToObject $m
			$state = (PiPwshState $m).State
			if ($state -in 'Starting', 'Running') {
				$killPid = if ($state -eq 'Starting') { [int]$m.LaunchProcessId } else { [int]$m.Pid }
				PiPwshKillTree $killPid
			}
			PiPwshToObject $m
		}
	}
}

function Remove-Job {
	[CmdletBinding(DefaultParameterSetName = 'Job')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Job', ValueFromPipeline = $true, ValueFromPipelineByPropertyName = $true)]
		[object[]]$Job,

		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[SupportsWildcards()]
		[string[]]$Name,

		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int[]]$Id,

		[switch]$Force
	)

	process {
		foreach ($m in @(PiPwshResolve $Job $Name $Id)) {
			$object = PiPwshToObject $m
			$state = (PiPwshState $m).State
			if ($state -in 'Starting', 'Running') {
				if (-not $Force) {
					Write-Error "Job '$($m.Name)' is still running. Use Stop-Job first or Remove-Job -Force."
					continue
				}
				$killPid = if ($state -eq 'Starting') { [int]$m.LaunchProcessId } else { [int]$m.Pid }
				PiPwshKillTree $killPid
				$object = PiPwshToObject $m
			}
			foreach ($suffix in '.meta.json', '.cmd.ps1', '.wrap.ps1', '.log', '.exit', '.pid') {
				Remove-Item -LiteralPath (Join-Path $script:PiPwshJobDir ($m.Name + $suffix)) -Force -ErrorAction SilentlyContinue
			}
			if ([string]$m.InstanceId -match '^[0-9a-f]{32}$') {
				foreach ($kind in 'ready', 'exit') {
					Remove-Item -LiteralPath (Join-Path $script:PiPwshJobDir ("$($m.InstanceId).$kind.notified")) -Force -ErrorAction SilentlyContinue
				}
				Remove-Item -LiteralPath (Join-Path $script:PiPwshJobDir ("$($m.InstanceId).exit.presented")) -Force -ErrorAction SilentlyContinue
			}
			$object
		}
	}
}

# ---------------------------------------------------------------------------
# Unsupported native cmdlets — fail with actionable guidance instead of
# confusing native errors (Suspend/Resume don't even exist on PS 7; Debug-Job
# would hang a headless agent).
# ---------------------------------------------------------------------------

function Suspend-Job { throw 'Suspend-Job is not supported here: pi-pwsh jobs are detached OS processes. Use Stop-Job to stop and Start-Job to restart.' }
function Resume-Job { throw 'Resume-Job is not supported here: pi-pwsh jobs are detached OS processes and cannot be paused.' }
function Debug-Job { throw 'Debug-Job is not supported here: jobs are headless detached processes; interactive debugging is unavailable.' }

# ---------------------------------------------------------------------------
# Self-serve reference.
# ---------------------------------------------------------------------------

function Get-JobHelp {
	[CmdletBinding()]
	param()

	@'
pi-pwsh background jobs — full reference
=========================================

OVERVIEW
--------
Every pwsh tool call is a fresh pwsh process. The job cmdlets in this shell
(Start-Job, Get-Job, Receive-Job, Stop-Job, Remove-Job, Wait-Job) are
OVERRIDDEN so jobs run as detached OS processes that persist across calls —
including across /reload and pi restarts. Do not assume native PowerShell
job semantics.

Use Start-Job for background work. Do not use PowerShell's background operator
(`command &`): it creates a native job owned by the current one-shot pwsh
process, so it does not persist across pwsh tool calls.

QUICK START
-----------
  Start-Job { npm run dev } -Name dev -NotifyOn 'Listening on'
  Get-Job                            # list jobs (Id, Name, State, HasMoreData, ...)
  Receive-Job -Name dev              # read NEW output since the last read
  Stop-Job -Name dev                 # kill the whole process tree
  Remove-Job -Name dev               # delete the job and its temp files

  Start-Job -ScriptBlock { npm run build } -Name build | Wait-Job | Receive-Job

STARTING JOBS
-------------
Start-Job -ScriptBlock <scriptblock> [-Name <name>] [-WorkingDirectory <dir>] [-Environment @{NAME='value'}] [-NotifyOn <literal>]
Start-Job -FilePath <script.ps1>    [-Name <name>] [-WorkingDirectory <dir>] [-Environment @{NAME='value'}] [-NotifyOn <literal>]
  - Returns immediately with a job object. Names are auto-allocated (Job1, Job2, ...)
    when -Name is omitted; reuse of an existing name is an error.
  - Jobs are separate OS processes: they do NOT share variables, functions, or
    session state with your pwsh call — but they DO inherit the session's
    full environment (PATH, proxies, VIRTUAL_ENV, ...). -Environment @{...}
    overrides or adds variables; do not pass secrets you would not put in
    the command itself.
  - All output streams (stdout, stderr, verbose, warnings, native output) are
    merged into one log: $env:TEMP\pi-pwsh-jobs\<name>.log

NOTIFICATIONS
-------------
  - Completion notifications are automatic; -NotifyOn is optional and is not
    required for completion reporting.
  - -NotifyOn adds an earlier one-time readiness notification when the log first
    contains its bounded, case-sensitive literal text. Use a stable server line
    such as "Listening on". The job continues running after the match.
  - Continue other work after starting a job. Use Wait-Job only when the next
    action depends on completion or readiness.
  - If Receive-Job returns a finished job's output before its completion
    notification is delivered, the notification is reduced to a status summary.
    A notification delivered first never consumes or limits later reads.

CHECKING STATUS
---------------
Get-Job [[-Name] <patterns>] [-Id <ints>] [-State <state>] [-Newest <n>]
  - -Name accepts wildcards: Get-Job dev*
  - State: Starting | Running | Completed | Failed | Stopped (killed).
  - Returned PiPwsh.Job objects refresh State, JobStateInfo, HasMoreData, Pid,
    and ExitCode from durable state while the current pwsh call remains alive.
  - ExitCode is on the object: Get-Job | Select-Object Name, State, ExitCode
    Completed = exit 0, Failed = exit code != 0.
  - HasMoreData = there is unread log output.
  - Returns nothing when no jobs exist.

READING OUTPUT
--------------
Receive-Job [-Job <jobs>] | -Name <patterns> | -Id <ints> [-Keep] [-Wait] [-Tail <n>]
  - Default: returns output captured SINCE THE LAST READ (consume semantics,
    like native Receive-Job). Polling repeatedly only shows new output.
  - -Keep: read without consuming (next read returns it again).
  - -Tail N: peek at the last N lines, ignores read offset.
  - -Wait: block until the job finishes, then read.
  - The complete merged log remains available at (Get-Job <name>).LogFile until
    Remove-Job. Read that file directly to inspect an arbitrary line range.
  - Keep model context bounded: prefer -Tail and Select-String over reading an
    entire large log. Output is plain text lines, so it composes:
      Receive-Job -Name dev | Select-Object -Last 20
      Receive-Job -Name dev | Select-String 'ERROR'

WAITING
-------
Wait-Job [-Job <jobs>] | -Name <patterns> | -Id <ints> [-Timeout <seconds>] [-Pattern <regex>]
  - Blocks until each job finishes, or until -Timeout expires.
  - With -Pattern, each job is also released when its output matches the regex.
    Matching uses a bounded rolling window and a regex evaluation timeout.
  - Set the pwsh tool timeout long enough to cover the requested wait.

STOPPING / CLEANUP
------------------
Stop-Job   (jobs | -Name | -Id)   # taskkill /T /F the whole process tree
Remove-Job (jobs | -Name | -Id) [-Force]
  - Remove-Job deletes the registry entry and all temp files; a running job
    requires -Force (kills it first).
  - Stop-Job and Remove-Job emit the affected job objects, so pipelines work:
      Get-Job | Stop-Job | Remove-Job
      Get-Job -State Completed | Remove-Job

UNSUPPORTED
-----------
Suspend-Job / Resume-Job / Debug-Job — these throw with guidance (jobs are
detached OS processes; interactive debugging is not available).
'@
}
