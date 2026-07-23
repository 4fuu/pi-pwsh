#requires -Version 7.0
# pi-pwsh user-request helper functions. Loaded lazily by the pwsh tool.

. (Join-Path $PSScriptRoot 'rpc.ps1')

function ConvertTo-PiRequestPtyRef($pty, $name, $id) {
	if ($null -ne $pty) {
		if ($pty -is [string]) { return @{ name = [string]$pty } }
		if ($pty.PSObject.Properties['Id']) { return @{ id = [int]$pty.Id } }
		if ($pty.PSObject.Properties['Name']) { return @{ name = [string]$pty.Name } }
		throw 'The pipeline object is not a pi-pwsh PTY object.'
	}
	if ($null -ne $id) { return @{ id = [int]$id } }
	if (-not [string]::IsNullOrWhiteSpace([string]$name)) { return @{ name = [string]$name } }
	throw 'Specify a PTY with -Name, -Id, or pipeline input.'
}

function Request-PiInput {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory = $true)][string]$Title,
		[Parameter(Mandatory = $true)][string]$Prompt,
		[switch]$Secret
	)
	Invoke-PiPwshRpc -Method 'user.input' -Parameters @{
		title = $Title
		prompt = $Prompt
		secret = [bool]$Secret
	}
}

function Request-PiConfirmation {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory = $true)][string]$Title,
		[Parameter(Mandatory = $true)][string]$Message
	)
	[bool](Invoke-PiPwshRpc -Method 'user.confirm' -Parameters @{ title = $Title; message = $Message })
}

function Request-PiSelection {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory = $true)][string]$Title,
		[Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string[]]$Options
	)
	[string](Invoke-PiPwshRpc -Method 'user.select' -Parameters @{ title = $Title; options = $Options })
}

function Request-PiPtyInput {
	[CmdletBinding(DefaultParameterSetName = 'Pty')]
	param(
		[Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Pty', ValueFromPipeline = $true)]
		[object[]]$Pty,
		[Parameter(Mandatory = $true, ParameterSetName = 'Name')][string]$Name,
		[Parameter(Mandatory = $true, ParameterSetName = 'Id')][int]$Id,
		[string]$Title = 'PTY input requested',
		[Parameter(Mandatory = $true)][string]$Prompt,
		[switch]$Secret,
		[switch]$Enter
	)
	process {
		$targets = if ($PSCmdlet.ParameterSetName -eq 'Pty') { @($Pty) } else { @(0) }
		foreach ($target in $targets) {
			$ref = if ($PSCmdlet.ParameterSetName -eq 'Name') { @{ name = $Name } } elseif ($PSCmdlet.ParameterSetName -eq 'Id') { @{ id = $Id } } else { ConvertTo-PiRequestPtyRef $target $null $null }
			$params = @{} + $ref
			$params.title = $Title
			$params.prompt = $Prompt
			$params.secret = [bool]$Secret
			$params.enter = [bool]$Enter
			$null = Invoke-PiPwshRpc -Method 'user.ptyInput' -Parameters $params
			[pscustomobject]@{ Pty = $(if ($ref.name) { $ref.name } else { "Id $($ref.id)" }); Submitted = $true; Secret = [bool]$Secret }
		}
	}
}

function Get-PiRequestHelp {
	[CmdletBinding()]
	param()

	@'
pi-pwsh user requests — full reference
========================================

Ask the user for input, confirmation, or selection while the current pwsh call
waits. User input can also be written directly to a PTY.

QUICK START
-----------
  $name = Request-PiInput -Title 'Setup' -Prompt 'Display name'
  Request-PiConfirmation -Title 'Deploy' -Message 'Continue?'
  Request-PiSelection -Title 'Region' -Options @('cn', 'us', 'eu')
  Request-PiPtyInput -Name login -Prompt 'Password' -Secret -Enter

GENERAL REQUESTS
----------------
Request-PiInput -Title <title> -Prompt <prompt> [-Secret]
Request-PiConfirmation -Title <title> -Message <message>
Request-PiSelection -Title <title> -Options <strings>
  - Input and selection cancellation throws and stops the current command.
  - A negative confirmation returns $false.
  - Always assign returned values to variables so they are not accidentally
    emitted to tool output.
  - Request-PiInput -Secret uses a masked TUI editor but returns plaintext
    to the PowerShell process — assign it immediately and never print it.

PTY-TARGETED REQUESTS
---------------------
Request-PiPtyInput (pty | -Name | -Id) -Prompt <prompt> [-Title <title>]
                   [-Secret] [-Enter]
  - Collects one user value and writes it directly to the PTY. The value is
    NOT returned to PowerShell or the model — only an acknowledgement.
  - -Secret is safer than Request-PiInput -Secret for terminal logins: the
    extension writes the password directly into the PTY.

SECURITY
--------
  - User responses never appear in tool output unless a command explicitly
    emits them.
  - Prefer Request-PiPtyInput -Secret over returning a secret to PowerShell.
  - The RPC pipe is authenticated per pi session; its credentials are removed
    from the environment after helper initialization. Programs launched later
    do not inherit those credentials.
  - Secret dialogs require TUI mode.

For PTY lifecycle and model-driven input, run Get-PtyHelp.

EXAMPLES
--------
  $ok = Request-PiConfirmation -Title 'Publish' -Message 'Publish now?'
  if (-not $ok) { throw 'User declined publication.' }

  Start-Pty 'some-login-command' -Name login
  Get-PtyScreen login
  Request-PiPtyInput -Name login -Prompt 'Password' -Secret -Enter
  Wait-Pty -Name login | Get-PtyScreen
'@
}
