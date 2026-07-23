#requires -Version 7.0
<#
Compatibility entrypoint for earlier pi-pwsh releases.
Background-job helpers now live in jobs.ps1 and are loaded lazily by the tool.
#>
. (Join-Path $PSScriptRoot 'jobs.ps1')
