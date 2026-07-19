#requires -Version 7.0
<#
pi-pwsh prelude — dot-sourced into every pwsh tool call.

Overrides the PowerShell job cmdlets with implementations backed by REAL
detached OS processes. Native PowerShell jobs (Start-Job, the `&` background
operator) live inside the one-shot pwsh process and die when the tool call
ends; these persist across calls.

Storage: $env:TEMP\pi-pwsh-jobs\ — one set of files per job:
  <name>.meta.json  registry entry (id, pid, command, paths, read offset)
  <name>.cmd.ps1    the user command, verbatim
  <name>.wrap.ps1   wrapper: redirects output to the log, records the exit code
  <name>.log        merged output (all streams + native stdout/stderr)
  <name>.exit       exit code (written when the job finishes; absent if killed)

This file is injected on EVERY call: it must be FAST and produce NO output.
#>

$script:PiPwshJobDir = Join-Path $env:TEMP 'pi-pwsh-jobs'

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
# Internal helpers (PiPwsh* prefix — not part of the public surface).
# ---------------------------------------------------------------------------

function PiPwshQuote([string]$s) { "'" + ($s -replace "'", "''") + "'" }

function PiPwshReadMeta([string]$name) {
	$path = Join-Path $script:PiPwshJobDir "$name.meta.json"
	if (-not (Test-Path -LiteralPath $path)) { return $null }
	try { Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
}

function PiPwshWriteMeta($meta) {
	$path = Join-Path $script:PiPwshJobDir ($meta.Name + '.meta.json')
	[System.IO.File]::WriteAllText($path, ($meta | ConvertTo-Json), [System.Text.Encoding]::UTF8)
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
	if ($alive) { return @{ State = 'Running'; ExitCode = $null } }
	# Killed via Stop-Job: taskkill prevents the wrapper from writing the exit file.
	return @{ State = 'Stopped'; ExitCode = $null }
}

function PiPwshToObject($meta) {
	$st = PiPwshState $meta
	$logLen = 0
	try { if (Test-Path -LiteralPath $meta.LogFile) { $logLen = (Get-Item -LiteralPath $meta.LogFile).Length } } catch { }
	$o = [pscustomobject]@{
		Id          = [int]$meta.Id
		Name        = [string]$meta.Name
		State       = $st.State
		HasMoreData = ($logLen -gt [long]$meta.ReadOffset)
		Location    = [string]$meta.WorkingDirectory
		Command     = [string]$meta.Command
		Pid         = [int]$meta.Pid
		ExitCode    = $st.ExitCode
		LogFile     = [string]$meta.LogFile
		StartedAt   = [string]$meta.StartedAt
	}
	$o.PSObject.TypeNames.Insert(0, 'PiPwsh.Job')
	$o
}

# Resolve -Job/-Name/-Id arguments to meta objects. Emits Write-Error for misses.
function PiPwshResolve($jobs, $names, $ids) {
	$found = @()
	foreach ($j in @($jobs)) {
		if ($null -eq $j) { continue }
		$m = $null
		if ($j -is [string]) { $m = PiPwshReadMeta $j }
		elseif ($j.PSObject.Properties['Name']) { $m = PiPwshReadMeta ([string]$j.Name) }
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

function PiPwshWait($metas, [int]$timeoutSec) {
	$deadline = if ($timeoutSec -gt 0) { (Get-Date).AddSeconds($timeoutSec) } else { [DateTime]::MaxValue }
	while ($true) {
		$running = 0
		foreach ($m in $metas) { if ((PiPwshState $m).State -eq 'Running') { $running++ } }
		if ($running -eq 0) { return }
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

		# Explicit env injection: WMI-created processes get the registry (logon)
		# environment, not this session's. PATH is re-injected automatically;
		# use -Environment for anything else. Values are stored in the job's
		# wrap script under %TEMP%\pi-pwsh-jobs until Remove-Job.
		[hashtable]$Environment
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

		$innerFile = Join-Path $jobDir "$Name.cmd.ps1"
		$wrapFile  = Join-Path $jobDir "$Name.wrap.ps1"
		$logFile   = Join-Path $jobDir "$Name.log"
		$exitFile  = Join-Path $jobDir "$Name.exit"
		Remove-Item -LiteralPath $exitFile, $logFile -Force -ErrorAction SilentlyContinue

		# Env re-injection: PATH from this session (fnm/scoop/shim setups modify
		# it per-session) plus anything passed via -Environment (wins on conflict).
		$envMap = @{ PATH = $env:PATH }
		if ($Environment) { foreach ($k in $Environment.Keys) { $envMap[$k] = [string]$Environment[$k] } }
		$envLines = ''
		foreach ($k in $envMap.Keys) {
			if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "Start-Job: invalid environment variable name '$k'. Use letters, digits and '_'." }
			$envLines += "`$env:$k = $(PiPwshQuote ([string]$envMap[$k]))`n"
		}

		$utf8 = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;'
		# Exit-code epilogue: preserve the real native exit code (pwsh flattens it
		# to 0/1 otherwise); $? covers cmdlet-only failures. Mirrors the epilogue
		# the pwsh tool appends to foreground commands (src/spawn.ts).
		$inner = "$utf8`n$command`n; `$__pipwsh_ok = `$?; if (`$null -ne `$global:LASTEXITCODE) { exit `$global:LASTEXITCODE } else { exit (`$__pipwsh_ok ? 0 : 1) }`n"
		$wrap = @"
$utf8
$envLines`$ec = 1
try {
	Set-Location -LiteralPath $(PiPwshQuote $wd) -ErrorAction Stop
	pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $(PiPwshQuote $innerFile) *> $(PiPwshQuote $logFile)
	if (`$null -ne `$global:LASTEXITCODE) { `$ec = `$global:LASTEXITCODE } else { `$ec = 0 }
} catch {
	`$_ | Out-String | Add-Content -LiteralPath $(PiPwshQuote $logFile)
}
Set-Content -LiteralPath $(PiPwshQuote $exitFile) -Value `$ec -NoNewline
"@
		[System.IO.File]::WriteAllText($innerFile, $inner, [System.Text.Encoding]::UTF8)
		[System.IO.File]::WriteAllText($wrapFile, $wrap, [System.Text.Encoding]::UTF8)

		# Launch DETACHED via WMI: the new process is parented to the WMI provider
		# host, NOT to this pwsh — so taskkill /T on this call's tree (abort/
		# timeout of the tool call that started the job) cannot take it down.
		# Trade-off: WMI-created processes get the registry (logon) environment,
		# not $env: changes made in this session. Falls back to Start-Process
		# (child of this process) if WMI is unavailable.
		# Note: use the full pwsh path — WmiPrvSE resolves names against the
		# SYSTEM PATH, which may not include a per-user pwsh install (scoop).
		$pwshExe = Join-Path $PSHOME 'pwsh.exe'
		$argLine = '"' + $pwshExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapFile + '"'
		$procId = 0
		try {
			$startupInfo = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -ClientOnly
			$startupInfo.ShowWindow = 0 # SW_HIDE
			$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
				CommandLine               = $argLine
				CurrentDirectory          = $wd
				ProcessStartupInformation = $startupInfo
			}
			if ($created.ReturnValue -eq 0) { $procId = [int]$created.ProcessId }
		} catch { }
		if ($procId -le 0) {
			$p = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $wrapFile + '"')) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
			$procId = $p.Id
		}

		$meta = [ordered]@{
			Id               = $id
			Name             = $Name
			Pid              = $procId
			Command          = $command
			WorkingDirectory = $wd
			LogFile          = $logFile
			ExitFile         = $exitFile
			StartedAt        = [DateTime]::UtcNow.ToString('o')
			ReadOffset       = 0
		}
		[System.IO.File]::WriteAllText((Join-Path $jobDir "$Name.meta.json"), ($meta | ConvertTo-Json), [System.Text.Encoding]::UTF8)
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

		[ValidateSet('Running', 'Completed', 'Failed', 'Stopped')]
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

			if ($Tail -gt 0) {
				# Peek at the last N lines without touching the read offset.
				$all = (PiPwshReadLogText $m 0).Text.TrimEnd()
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

		[int]$Timeout
	)

	begin { $targets = @() }
	process { $targets += @(PiPwshResolve $Job $Name $Id) }
	end {
		PiPwshWait $targets $Timeout
		$targets | ForEach-Object { PiPwshToObject (PiPwshReadMeta $_.Name) }
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
			if ((PiPwshState $m).State -eq 'Running') {
				PiPwshKillTree ([int]$m.Pid)
			}
			PiPwshToObject (PiPwshReadMeta $m.Name)
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
			if ((PiPwshState $m).State -eq 'Running') {
				if (-not $Force) {
					Write-Error "Job '$($m.Name)' is still running. Use Stop-Job first or Remove-Job -Force."
					continue
				}
				PiPwshKillTree ([int]$m.Pid)
			}
			foreach ($suffix in '.meta.json', '.cmd.ps1', '.wrap.ps1', '.log', '.exit') {
				Remove-Item -LiteralPath (Join-Path $script:PiPwshJobDir ($m.Name + $suffix)) -Force -ErrorAction SilentlyContinue
			}
			PiPwshToObject $m
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

WHY: every pwsh tool call is a fresh pwsh process. Native PowerShell jobs
(Start-Job, the & background operator) die when that process exits. The job
cmdlets in this shell are OVERRIDDEN with implementations backed by real
detached OS processes that persist across pwsh calls.

QUICK START
-----------
  npm run dev &                      # trailing & is auto-converted to Start-Job
  Get-Job                            # list jobs (Id, Name, State, HasMoreData, ...)
  Receive-Job -Name Job1             # read NEW output since the last read
  Stop-Job -Name Job1                # kill the whole process tree
  Remove-Job -Name Job1              # delete the job and its temp files

  Start-Job -ScriptBlock { npm run build } -Name build | Wait-Job | Receive-Job

STARTING JOBS
-------------
Start-Job -ScriptBlock <scriptblock> [-Name <name>] [-WorkingDirectory <dir>] [-Environment @{NAME='value'}]
Start-Job -FilePath <script.ps1>    [-Name <name>] [-WorkingDirectory <dir>] [-Environment @{NAME='value'}]
  - Returns immediately with a job object. Names are auto-allocated (Job1, Job2, ...)
    when -Name is omitted; reuse of an existing name is an error.
  - Appending ` &` to any single-pipeline command is rewritten to Start-Job
    automatically (bash-style). Multi-statement scripts with `&` in the middle
    are NOT intercepted.
  - Jobs are launched DETACHED via WMI (Win32_Process.Create), not as children
    of the calling pwsh: aborting or timing out the pwsh call that started a
    job does NOT kill it.
  - Jobs are separate OS processes: they do NOT share variables, functions, or
    session state with your pwsh call. Environment: jobs get the registry
    (logon) environment, EXCEPT PATH (re-injected from your session) and any
    variables passed via -Environment. Values land in the job's wrap script
    under %TEMP%\pi-pwsh-jobs until Remove-Job — do not inject secrets you
    would not put in the command itself.
  - All output streams (stdout, stderr, verbose, warnings, native output) are
    merged into one log: $env:TEMP\pi-pwsh-jobs\<name>.log

CHECKING STATUS
---------------
Get-Job [[-Name] <patterns>] [-Id <ints>] [-State <state>] [-Newest <n>]
  - -Name accepts wildcards: Get-Job dev*
  - State: Running | Completed | Failed | Stopped (killed).
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
  - Output is plain text lines, so it composes:
      Receive-Job -Name dev | Select-Object -Last 20
      Receive-Job -Name dev | Select-String 'ERROR'

WAITING
-------
Wait-Job [-Job <jobs>] | -Name <patterns> | -Id <ints> [-Timeout <seconds>]
  - Blocks the current pwsh call until the jobs finish (or timeout).
    Prefer polling with Get-Job / Receive-Job when possible; if you do wait,
    set the pwsh tool's timeout accordingly.

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

STORAGE LAYOUT ($env:TEMP\pi-pwsh-jobs\)
----------------------------------------
  <name>.meta.json  registry entry  |  <name>.log   merged output
  <name>.exit       exit code       |  <name>.cmd.ps1 / .wrap.ps1  scripts
The registry survives pi restarts and /reload; Remove-Job cleans up.
'@
}
