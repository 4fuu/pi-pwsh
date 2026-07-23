#requires -Version 7.0
# pi-pwsh persistent PTY helper functions. Loaded lazily by the pwsh tool.

. (Join-Path $PSScriptRoot 'rpc.ps1')

function ConvertTo-PiPtyObject($value) {
	if ($null -eq $value) { return $null }
	$o = [pscustomobject]@{
		Id               = [int]$value.id
		Name             = [string]$value.name
		State            = [string]$value.state
		HasMoreData      = [bool]$value.hasMoreData
		Pid              = [int]$value.pid
		ExitCode         = if ($null -eq $value.exitCode) { $null } else { [int]$value.exitCode }
		Location         = [string]$value.workingDirectory
		Columns          = [int]$value.columns
		Rows             = [int]$value.rows
		Command          = [string]$value.command
		StartedAt        = [string]$value.startedAt
	}
	$o.PSObject.TypeNames.Insert(0, 'PiPwsh.Pty')
	$display = [System.Management.Automation.PSPropertySet]::new(
		'DefaultDisplayPropertySet',
		[string[]]@('Id', 'Name', 'State', 'HasMoreData', 'Pid', 'ExitCode', 'Command')
	)
	$o | Add-Member -MemberType MemberSet -Name PSStandardMembers -Value ([System.Management.Automation.PSMemberInfo[]]@($display))
	$o
}

function ConvertTo-PiPtyRef($pty, $name, $id) {
	if ($null -ne $pty) {
		if ($pty -is [string]) { return @{ name = [string]$pty } }
		if ($pty.PSObject.Properties['Id']) { return @{ id = [int]$pty.Id } }
		if ($pty.PSObject.Properties['Name']) { return @{ name = [string]$pty.Name } }
		throw 'The pipeline object is not a pi-pwsh PTY object.'
	}
	if ($PSBoundParameters.ContainsKey('id') -or $null -ne $id) { return @{ id = [int]$id } }
	if (-not [string]::IsNullOrWhiteSpace([string]$name)) { return @{ name = [string]$name } }
	throw 'Specify a PTY with -Name, -Id, or pipeline input.'
}

function Start-Pty {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory = $true, Position = 0)]
		[string]$Command,
		[string]$Name,
		[string]$WorkingDirectory,
		[hashtable]$Environment,
		[int]$Columns,
		[int]$Rows
	)
	$params = @{ command = $Command }
	if ($Name) { $params.name = $Name }
	if ($WorkingDirectory) { $params.workingDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkingDirectory) }
	if ($Environment) { $params.environment = $Environment }
	if ($Columns -gt 0) { $params.columns = $Columns }
	if ($Rows -gt 0) { $params.rows = $Rows }
	ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.start' -Parameters $params)
}

function Get-Pty {
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
	$items = @(Invoke-PiPwshRpc -Method 'pty.list')
	if ($Name) {
		$items = @($items | Where-Object { $n = [string]$_.name; @($Name | Where-Object { $n -like $_ }).Count -gt 0 })
	}
	if ($Id) {
		$items = @($items | Where-Object { $i = [int]$_.id; @($Id | Where-Object { $i -eq $_ }).Count -gt 0 })
	}
	if ($State) { $items = @($items | Where-Object { $_.state -eq $State }) }
	if ($Newest -gt 0 -and $items.Count -gt $Newest) { $items = $items[-$Newest..-1] }
	$items | ForEach-Object { ConvertTo-PiPtyObject $_ }
}

function Receive-Pty {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int]$Id,
		[switch]$Keep,
		[int]$Tail
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			$params = @{} + $ref
			if ($Keep) { $params.keep = $true }
			if ($Tail -gt 0) { $params.tail = $Tail }
			$result = Invoke-PiPwshRpc -Method 'pty.receive' -Parameters $params
			if ($result.text) { ([string]$result.text).TrimEnd() -split "\r?\n" }
		}
	}
}

function Get-PtyScreen {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int]$Id
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			$result = Invoke-PiPwshRpc -Method 'pty.screen' -Parameters $ref
			@($result.lines) | ForEach-Object { [string]$_ }
			"[PTY screen: $($result.columns)x$($result.rows), cursor row $([int]$result.cursor.row + 1), column $([int]$result.cursor.column + 1), $($result.bufferType) buffer]"
		}
	}
}

function Send-PtyInput {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int]$Id,
		[string]$Text,
		[ValidateSet('Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'CtrlC', 'CtrlD', 'CtrlZ')]
		[string[]]$Key,
		[switch]$Enter
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			$params = @{} + $ref
			if ($PSBoundParameters.ContainsKey('Text')) { $params.text = $Text }
			if ($Key) { $params.keys = $Key }
			if ($Enter) { $params.enter = $true }
			ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.send' -Parameters $params)
		}
	}
}

function Wait-Pty {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int]$Id,
		[switch]$Exit,
		[int]$Timeout,
		[int]$IdleMilliseconds
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			$params = @{} + $ref
			$params.mode = if ($Exit) { 'exit' } else { 'idle' }
			if ($Timeout -gt 0) { $params.timeoutMs = $Timeout * 1000 }
			if ($IdleMilliseconds -gt 0) { $params.idleMs = $IdleMilliseconds }
			ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.wait' -Parameters $params)
		}
	}
}

function Resize-Pty {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')]
		[string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')]
		[int]$Id,
		[Parameter(Mandatory = $true)][int]$Columns,
		[Parameter(Mandatory = $true)][int]$Rows
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.resize' -Parameters (@{} + $ref + @{ columns = $Columns; rows = $Rows }))
		}
	}
}

function Stop-Pty {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')][string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')][int]$Id
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.stop' -Parameters $ref)
		}
	}
}

function Remove-Pty {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')][string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')][int]$Id,
		[switch]$Force
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiPtyRef $target $null $null }
			$params = @{} + $ref
			if ($Force) { $params.force = $true }
			ConvertTo-PiPtyObject (Invoke-PiPwshRpc -Method 'pty.remove' -Parameters $params)
		}
	}
}

function Get-PtyHelp {
	[CmdletBinding()]
	param()

	@'
pi-pwsh PTY sessions — full reference
=======================================

Persistent interactive processes backed by Windows ConPTY. PTYs survive pwsh
calls, but are closed on /reload, session replacement, or pi shutdown.

QUICK START
-----------
  Start-Pty -Command 'python' -Name py
  Get-PtyScreen -Name py
  Send-PtyInput -Name py -Text '1 + 1' -Enter
  Wait-Pty -Name py -IdleMilliseconds 300 | Receive-Pty
  Stop-Pty -Name py | Remove-Pty

STARTING
--------
Start-Pty -Command <string> [-Name <name>] [-WorkingDirectory <dir>]
          [-Environment @{NAME='value'}] [-Columns <n>] [-Rows <n>]
  - Starts pwsh under ConPTY and returns immediately with a PiPwsh.Pty object.
  - Names are unique per pi session and auto-allocated (Pty1, Pty2, ...) when
    -Name is omitted; reuse of an existing name is an error.

STATUS
------
Get-Pty [[-Name] <patterns>] [-Id <ids>] [-State <state>] [-Newest <n>]
  - -Name accepts wildcards: Get-Pty dev*
  - State: Running | Completed | Failed | Stopped.
  - ExitCode is on the object.
  - HasMoreData = there is unread output.

READING OUTPUT
--------------
Receive-Pty (pty | -Name | -Id) [-Keep] [-Tail <n>]
  - Reads cleaned incremental output. Default consumes (next read only returns
    new output); -Keep reads without consuming; -Tail peeks at the last N lines.
Get-PtyScreen (pty | -Name | -Id)
  - Returns the current emulated terminal viewport and cursor position. Use
    this for full-screen TUIs and programs that rewrite existing lines.

INPUT
-----
Send-PtyInput (pty | -Name | -Id) [-Text <text>] [-Key <keys>] [-Enter]
  - Supported keys: Enter, Escape, Tab, Backspace, Delete, arrows, Home, End,
    PageUp, PageDown, CtrlC, CtrlD, CtrlZ.
  - Text, keys, and -Enter are sent in that order.
  - Use Request-PiPtyInput for user-provided or secret input (see Get-PiRequestHelp).

WAITING
-------
Wait-Pty (pty | -Name | -Id) [-Exit] [-Timeout <seconds>]
         [-IdleMilliseconds <milliseconds>]
  - Default waits for output to become idle; -Exit waits for process termination.
  - A wait timeout returns current state and never kills the PTY. Keep waits bounded.

RESIZE / STOP / CLEANUP
------------------------
Resize-Pty (pty | -Name | -Id) -Columns <n> -Rows <n>
Stop-Pty (pty | -Name | -Id)
  - Kills the PTY process tree.
Remove-Pty (pty | -Name | -Id) [-Force]
  - Removes the PTY from the session; a running PTY requires -Force (kills it).
  - Stop-Pty and Remove-Pty emit the affected PTY objects for piping:
      Get-Pty | Stop-Pty | Remove-Pty

LIFECYCLE
---------
PTYs live in the current pi extension session only. Unlike background jobs
they do NOT survive /reload or pi restart. PTYs are cleaned up automatically
on session_shutdown. An aborted or timed-out pwsh call does NOT kill its
PTYs — only Stop-Pty does.

For user dialogs and secret injection, run Get-PiRequestHelp.

EXAMPLES
--------
  Start-Pty 'python' -Name py
  Send-PtyInput -Name py -Text 'print(6 * 7)' -Enter | Wait-Pty | Receive-Pty

  Start-Pty 'gh auth login' -Name login
  Get-PtyScreen login
  Send-PtyInput -Name login -Text '...' -Enter
  Get-PtyScreen login

  Start-Pty 'some-login' -Name login
  Request-PiPtyInput -Name login -Prompt 'Password' -Secret -Enter
'@
}
