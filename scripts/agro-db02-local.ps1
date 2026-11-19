param(
    [ValidateSet('standalone', 'single-node-replica-set')][string]$Topology = 'single-node-replica-set',
    [ValidateRange(1024,65535)][int]$Port = 27029,
    [switch]$AuthorizeDisposable
)
$ErrorActionPreference = 'Stop'
if (-not $AuthorizeDisposable) { throw 'Explicit -AuthorizeDisposable is required. No resources created.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker unavailable. No server installation attempted.' }
if ($env:DOCKER_HOST -and $env:DOCKER_HOST -notin @('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock','unix:///run/docker.sock')) { throw 'Remote Docker endpoint forbidden' }
$context = docker context inspect | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $context.Endpoints.docker.Host -notin @('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock','unix:///run/docker.sock')) { throw 'Local Docker context required' }
docker info --format '{{.OSType}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine unavailable' }
$image = 'mongodb/mongodb-community-server:8.0-ubi8'
$runId = [guid]::NewGuid().ToString('N').Substring(0,24)
$resourceName = "agro-db02-$runId"
$networkCreated = $false
$imagePulled = $false
$containerId = $null
$saved = @{}
$keys = @('AGRO_DB02_ENABLE','AGRO_DB02_RUN_ID','AGRO_DB02_CONTAINER','AGRO_DB02_PORT','AGRO_DB02_TOPOLOGY')
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
$manifest = Join-Path $PSScriptRoot "..\..\integraciones\agro-db02-20261119\resources-$runId.json"
New-Item -ItemType Directory -Path (Split-Path $manifest) -Force | Out-Null
try {
    # Official image only. Pulling an image does not install Docker or a Windows service.
    docker pull $image
    if ($LASTEXITCODE -ne 0) { throw 'Official image unavailable; stop' }
    $imagePulled = $true
    docker network create --internal --label "agro.db02.run=$runId" $resourceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Dedicated network creation failed' }
    $networkCreated = $true
    @{runId=$runId;network=$resourceName;state='network-created';image=$image;port=$Port} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $manifest
    $arguments = @('create','--name',$resourceName,'--label',"agro.db02.run=$runId",'--network',$resourceName,
        '--publish',"127.0.0.1:${Port}:27017",'--memory','768m','--cpus','1',
        '--tmpfs','/data/db:rw,size=512m','--tmpfs','/data/configdb:rw,size=32m',$image,'--bind_ip_all')
    if ($Topology -eq 'single-node-replica-set') { $arguments += @('--replSet','agro_db02') }
    $createdId = docker @arguments
    if ($LASTEXITCODE -ne 0 -or $createdId -notmatch '^[a-f0-9]{64}$') { throw 'Container creation failed; inspect only this run label' }
    $containerId = $createdId.Trim()
    @{runId=$runId;container=$containerId;network=$resourceName;image=$image;port=$Port;topology=$Topology;state='created';createdAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $manifest
    docker start $containerId | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Owned container start failed' }
    $ready = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        docker exec $containerId mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)' *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'MongoDB readiness deadline exceeded' }
    if ($Topology -eq 'single-node-replica-set') {
        docker exec $containerId mongosh --quiet --eval "rs.initiate({_id:'agro_db02',members:[{_id:0,host:'localhost:27017'}]})" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Replica set initialization failed' }
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            docker exec $containerId mongosh --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)' *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Primary readiness deadline exceeded' }
    }
    $env:AGRO_DB02_ENABLE = 'AUTHORIZED_DISPOSABLE_DB02_ONLY'
    $env:AGRO_DB02_RUN_ID = $runId
    $env:AGRO_DB02_CONTAINER = $containerId
    $env:AGRO_DB02_PORT = [string]$Port
    $env:AGRO_DB02_TOPOLOGY = $Topology
    Push-Location (Join-Path $PSScriptRoot '..')
    try {
        node dist/scripts/audit-agro-db02-mongodb-local.js | Tee-Object -FilePath ($manifest -replace 'resources-','results-' -replace '\.json$','.jsonl')
        if ($LASTEXITCODE -ne 0) { throw 'DB02 suite failed; inspect sanitized results' }
    } finally { Pop-Location }
} finally {
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
    $cleanupOk = $true
    if ($containerId) {
        $owned = docker inspect $containerId | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $owned.Id -eq $containerId -and $owned.Config.Labels.'agro.db02.run' -eq $runId) {
            docker rm --force $containerId | Out-Null
            if ($LASTEXITCODE -ne 0) { $cleanupOk = $false }
        } else { $cleanupOk = $false }
    }
    if ($networkCreated) {
        $ownedNetwork = docker network inspect $resourceName | ConvertFrom-Json
        if ($LASTEXITCODE -eq 0 -and $ownedNetwork.Labels.'agro.db02.run' -eq $runId -and @($ownedNetwork.Containers.PSObject.Properties).Count -eq 0) {
            docker network rm $resourceName | Out-Null
            if ($LASTEXITCODE -ne 0) { $cleanupOk = $false }
        } else { $cleanupOk = $false }
    }
    @{runId=$runId;container=$containerId;network=$resourceName;networkWasCreated=$networkCreated;image=$image;imageWasPulled=$imagePulled;port=$Port;topology=$Topology;cleanupConfirmed=$cleanupOk;storage='tmpfs; no reused volumes'} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $manifest
    if (-not $cleanupOk) { throw 'Owned cleanup unconfirmed; preserve manifest and inspect only this run resources' }
}
