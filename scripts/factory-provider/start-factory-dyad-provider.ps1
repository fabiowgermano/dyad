<#
.SYNOPSIS
  Starts the Factory/Dyad provider service on Windows. Holds no secret.

.DESCRIPTION
  The bearer token is read by the service from -TokenFile (never from an
  environment variable or from this script). The service refuses to start when
  FACTORY_DYAD_TOKEN is set.

  The build provenance (version, commit) is baked into the dist by
  scripts\build-factory-provider.mjs (dist\factory-dyad-provider\build-info.json)
  and /healthz reports it. This script refuses to start when that build info is
  missing, was built from a dirty tree, does not match service.cjs, or names a
  commit other than the checkout's HEAD (git pull without a rebuild).

.EXAMPLE
  .\scripts\factory-provider\start-factory-dyad-provider.ps1 `
    -ModelRegistry C:\Users\netco\.factory-dyad\models.json `
    -BindHost 10.77.0.2 -Port 18788 -PreviewAllowedPeers 10.77.0.4
#>
param(
  [Parameter(Mandatory)] [string] $ModelRegistry,
  [string] $TokenFile = (Join-Path $env:USERPROFILE '.factory-dyad\service.token'),
  [string] $BindHost = '127.0.0.1',
  [int] $Port = 8787,
  # Private address that serves the preview of a finished prototype; empty keeps it on loopback.
  [string] $PreviewBindHost = $BindHost,
  # Peers allowed to open the preview (the Core host / the operator's machine).
  [string[]] $PreviewAllowedPeers = @(),
  [int] $PreviewPortFirst = 49152,
  [int] $PreviewPortLast = 49300,
  [string] $DataDir = (Join-Path $env:LOCALAPPDATA 'FactoryDyadProvider')
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo

$status = git status --porcelain
if ($status) { throw "The checkout is not clean; refusing to start a service whose build commit would not describe it." }
$commit = (git rev-parse HEAD).Trim()
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$rebuild = 'run node scripts\build-factory-provider.mjs'
$service = 'dist\factory-dyad-provider\service.cjs'
$buildInfoFile = 'dist\factory-dyad-provider\build-info.json'
if (-not (Test-Path $service)) { throw "Build first: node scripts\build-factory-provider.mjs" }
if (-not (Test-Path $buildInfoFile)) { throw "$buildInfoFile is missing (build predates build provenance): $rebuild" }
$buildInfo = Get-Content $buildInfoFile -Raw | ConvertFrom-Json
if ($buildInfo.dirty -ne $false) { throw "dist was built from a dirty checkout: $rebuild from a clean checkout" }
if ($buildInfo.commit -ne $commit) { throw "dist was built from $($buildInfo.commit), checkout is ${commit}: $rebuild" }
if ($buildInfo.version -ne $version) { throw "dist was built as version $($buildInfo.version), checkout is ${version}: $rebuild" }
$serviceSha = (Get-FileHash -Algorithm SHA256 $service).Hash.ToLowerInvariant()
if ($serviceSha -ne $buildInfo.serviceSha256) { throw "$service sha256 $serviceSha does not match build-info $($buildInfo.serviceSha256): $rebuild" }

Remove-Item Env:FACTORY_DYAD_TOKEN -ErrorAction SilentlyContinue
$env:FACTORY_DYAD_TOKEN_FILE = $TokenFile
$env:FACTORY_DYAD_MODEL_REGISTRY_FILE = $ModelRegistry
$env:FACTORY_DYAD_BIND = $BindHost
$env:FACTORY_DYAD_PORT = "$Port"
$env:FACTORY_DYAD_DATA_DIR = $DataDir
# The service reports the baked build info; these only let it re-check the
# checkout against the dist and refuse on mismatch.
$env:FACTORY_DYAD_BUILD_VERSION = $version
$env:FACTORY_DYAD_BUILD_COMMIT = $commit
if ($PreviewAllowedPeers.Count -gt 0) {
  $env:FACTORY_DYAD_PREVIEW_BIND = $PreviewBindHost
  $env:FACTORY_DYAD_PREVIEW_ALLOWED_PEERS = ($PreviewAllowedPeers -join ',')
  $env:FACTORY_DYAD_PREVIEW_PORTS = "$PreviewPortFirst-$PreviewPortLast"
}
node dist\factory-dyad-provider\service.cjs
