param([ValidateRange(1024,65535)][int]$Port=27059,[switch]$AuthorizeDisposable)
$ErrorActionPreference='Stop'
if(-not $AuthorizeDisposable){throw 'Explicit -AuthorizeDisposable is required'}
if(-not (Get-Command docker -ErrorAction SilentlyContinue)){throw 'Docker unavailable'}
if($env:DOCKER_HOST -and $env:DOCKER_HOST -notin @('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock','unix:///run/docker.sock')){throw 'Remote Docker endpoint forbidden'}
$context=docker context inspect|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $context.Endpoints.docker.Host -notin @('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock','unix:///run/docker.sock')){throw 'Local Docker context required'}
if((docker info --format '{{.OSType}}') -ne 'linux'){throw 'Linux containers required'}
$image='mongodb/mongodb-community-server:8.0-ubi8';$runId=[guid]::NewGuid().ToString('N').Substring(0,24);$resource="agro-be11-$runId";$containerId=$null;$networkCreated=$false;$launcherStage='initialize'
$repositoryRoot=Resolve-Path (Join-Path $PSScriptRoot '..');$evidenceDirectory=Join-Path $repositoryRoot '.local-evidence';New-Item -ItemType Directory -Path $evidenceDirectory -Force|Out-Null
$runLog=Join-Path $evidenceDirectory "be11-launcher-$runId.log";$launcherEvidence=Join-Path $evidenceDirectory "be11-launcher-$runId.json"
$keys=@('AGRO_DB02_ENABLE','AGRO_DB02_RUN_ID','AGRO_DB02_CONTAINER','AGRO_DB02_PORT','AGRO_DB02_TOPOLOGY');$saved=@{};foreach($key in $keys){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
try{
  $launcherStage='pull-official-image'
  docker pull $image|Out-Null;if($LASTEXITCODE -ne 0){throw 'Official MongoDB image unavailable'}
  $launcherStage='create-exclusive-network'
  docker network create --driver bridge --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 --opt com.docker.network.bridge.enable_ip_masquerade=false --label "agro.db02.run=$runId" $resource|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Dedicated network creation failed'};$networkCreated=$true
  $launcherStage='create-exclusive-container';$created=docker create --name $resource --label "agro.db02.run=$runId" --network $resource --publish "127.0.0.1:${Port}:27017" --memory 1536m --cpus 1 --tmpfs /data/db:rw,size=1024m,mode=1777 --tmpfs /data/configdb:rw,size=32m,mode=1777 $image --bind_ip_all --replSet agro_db02
  if($LASTEXITCODE -ne 0 -or $created -notmatch '^[a-f0-9]{64}$'){throw 'Container creation failed'};$containerId=$created.Trim();docker start $containerId|Out-Null
  $launcherStage='wait-mongodb';$ready=$false;for($i=0;$i-lt 45;$i++){docker exec $containerId mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok===1?0:1)' *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'MongoDB readiness deadline'}
  $launcherStage='initialize-replica-set'
  docker exec $containerId mongosh --quiet --eval "rs.initiate({_id:'agro_db02',members:[{_id:0,host:'localhost:27017'}]})"|Out-Null;if($LASTEXITCODE -ne 0){throw 'Replica set initialization failed'}
  $launcherStage='wait-primary';$ready=$false;for($i=0;$i-lt 30;$i++){docker exec $containerId mongosh --quiet --eval 'quit(db.hello().isWritablePrimary?0:1)' *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Primary readiness deadline'}
  $env:AGRO_DB02_ENABLE='AUTHORIZED_DISPOSABLE_DB02_ONLY';$env:AGRO_DB02_RUN_ID=$runId;$env:AGRO_DB02_CONTAINER=$containerId;$env:AGRO_DB02_PORT=[string]$Port;$env:AGRO_DB02_TOPOLOGY='single-node-replica-set'
  $launcherStage='execute-be11-suite';Push-Location $repositoryRoot;try{& node dist/scripts/audit-be11-mongodb-local.js 2>&1|Tee-Object -FilePath $runLog;$nodeExit=$LASTEXITCODE;if($nodeExit -ne 0){throw 'BE11 MongoDB suite failed'}}finally{Pop-Location}
  $launcherStage='suite-complete'
}catch{
  @{runId=$runId;stage=$launcherStage;status='failed';errorClass=$_.Exception.GetType().Name;log=$runLog}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $launcherEvidence
  throw
}finally{
  foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')};$cleanup=$true
  if($containerId){$owned=docker inspect $containerId|ConvertFrom-Json;if($LASTEXITCODE -eq 0 -and $owned.Id -eq $containerId -and $owned.Config.Labels.'agro.db02.run' -eq $runId){docker rm --force $containerId|Out-Null;if($LASTEXITCODE -ne 0){$cleanup=$false}}else{$cleanup=$false}}
  if($networkCreated){$network=docker network inspect $resource|ConvertFrom-Json;if($LASTEXITCODE -eq 0 -and $network.Labels.'agro.db02.run' -eq $runId -and @($network.Containers.PSObject.Properties).Count -eq 0){docker network rm $resource|Out-Null;if($LASTEXITCODE -ne 0){$cleanup=$false}}else{$cleanup=$false}}
  if(-not $cleanup){throw 'Owned resource cleanup unconfirmed'}
  if(-not (Test-Path -LiteralPath $launcherEvidence)){@{runId=$runId;stage=$launcherStage;status='completed';log=$runLog;cleanupConfirmed=$true}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $launcherEvidence}
}
