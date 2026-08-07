#requires -Version 7.0
<#
Compatibility entrypoint for earlier pi-pwsh releases.
Background-job helpers live in powershell/jobs.ps1 and are loaded lazily by the tool.
#>
. (Join-Path $PSScriptRoot 'powershell' 'jobs.ps1')
