#requires -Version 7.0
# Internal JSON-lines RPC client shared by the PTY and user-request helpers.
# This file is dot-sourced lazily and must produce no output.

if (-not $script:PiPwshRpcPipe) { $script:PiPwshRpcPipe = [string]$env:PI_PWSH_RPC_PIPE }
if (-not $script:PiPwshRpcToken) { $script:PiPwshRpcToken = [string]$env:PI_PWSH_RPC_TOKEN }
Remove-Item Env:PI_PWSH_RPC_PIPE, Env:PI_PWSH_RPC_TOKEN -ErrorAction SilentlyContinue

function Invoke-PiPwshRpc {
	[CmdletBinding()]
	param(
		[Parameter(Mandatory = $true)]
		[string]$Method,

		[hashtable]$Parameters = @{},

		[int]$ConnectTimeout = 10000
	)

	if ([string]::IsNullOrWhiteSpace($script:PiPwshRpcPipe) -or [string]::IsNullOrWhiteSpace($script:PiPwshRpcToken)) {
		throw 'pi-pwsh interactive services are unavailable in this process. Run the helper through the pwsh tool.'
	}

	$id = [Guid]::NewGuid().ToString('N')
	$request = [ordered]@{
		version = 1
		token = $script:PiPwshRpcToken
		id = $id
		method = $Method
		params = $Parameters
	}
	$pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
		'.',
		$script:PiPwshRpcPipe,
		[System.IO.Pipes.PipeDirection]::InOut,
		[System.IO.Pipes.PipeOptions]::Asynchronous
	)
	try {
		$pipe.Connect($ConnectTimeout)
		$utf8 = [System.Text.UTF8Encoding]::new($false)
		$writer = [System.IO.StreamWriter]::new($pipe, $utf8, 4096, $true)
		$reader = [System.IO.StreamReader]::new($pipe, $utf8, $false, 4096, $true)
		try {
			$writer.AutoFlush = $true
			$writer.WriteLine(($request | ConvertTo-Json -Depth 12 -Compress))
			$line = $reader.ReadLine()
			if ($null -eq $line) { throw "pi-pwsh RPC connection closed before '$Method' completed." }
			$response = $line | ConvertFrom-Json -Depth 20
			if ([string]$response.id -ne $id) { throw "pi-pwsh RPC response id mismatch for '$Method'." }
			if (-not [bool]$response.ok) {
				$message = if ($response.error.message) { [string]$response.error.message } else { "pi-pwsh RPC method '$Method' failed." }
				if ($response.error.code) { $message += " [$($response.error.code)]" }
				throw $message
			}
			return $response.result
		} finally {
			$reader.Dispose()
			$writer.Dispose()
		}
	} catch [System.TimeoutException] {
		throw "Timed out connecting to pi-pwsh interactive services for '$Method'."
	} finally {
		$pipe.Dispose()
	}
}
