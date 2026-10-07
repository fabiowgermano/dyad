<#
.SYNOPSIS
  Allows ONE peer (the Factory Core host) to reach the provider API and the
  preview range. Run elevated. Remove the rule when the Core moves.

.EXAMPLE
  # laboratory: the Core runs on the Mac (WireGuard peer 10.77.0.4)
  .\configure-firewall.ps1 -ApiPort 18788 -Peer 10.77.0.4 -PreviewPortFirst 49152 -PreviewPortLast 49300
  # production: the Core runs on the VM (10.77.0.1) -> run Remove, then Add with -Peer 10.77.0.1
  .\configure-firewall.ps1 -Remove -Peer 10.77.0.4
#>
param(
  [Parameter(Mandatory)] [string] $Peer,
  [int] $ApiPort = 8787,
  [int] $PreviewPortFirst = 49152,
  [int] $PreviewPortLast = 49300,
  [switch] $Remove
)
$ErrorActionPreference = 'Stop'
$name = "Factory Dyad provider from $Peer"
Get-NetFirewallRule -DisplayName "$name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { Write-Output "removed: $name"; return }
New-NetFirewallRule -DisplayName "$name (API)" -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $ApiPort -RemoteAddress $Peer -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "$name (preview)" -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort "$PreviewPortFirst-$PreviewPortLast" -RemoteAddress $Peer -Profile Any | Out-Null
Write-Output "allowed $Peer -> tcp/$ApiPort and tcp/$PreviewPortFirst-$PreviewPortLast"
