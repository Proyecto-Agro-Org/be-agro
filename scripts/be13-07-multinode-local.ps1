param([ValidateRange(1024,65000)][int]$BasePort=27071,[switch]$AuthorizeDisposable,[ValidateSet('be13-07','be13-08','be13-09','be13-10b','be13-11a','be13-11b','be13-11c','be13-11d','be13-11e','be13-11f','be13-11l')][string]$Suite='be13-07')
# BE13-07 — disposable LOCAL 3-node MongoDB replica set for the resilience campaign.
# Same guards as be11-local.ps1 (local Docker context, Linux containers, exclusive
# bridge network bound to 127.0.0.1, ownership labels, tmpfs, no privileges,
# confirmed cleanup). A "holder" container owns the network namespace and
# publishes ONLY 127.0.0.1:<BasePort..BasePort+2>; the three mongod containers
# share that namespace so members are named 127.0.0.1:<port> both inside and
# from the host. Never connects to Atlas, never reuses an existing server.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'be11-readiness.ps1')
if(-not $AuthorizeDisposable){throw 'Explicit -AuthorizeDisposable is required'}
if(-not (Get-Command docker -ErrorAction SilentlyContinue)){throw 'Docker unavailable'}
$localEndpoints=@('npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine','unix:///var/run/docker.sock','unix:///run/docker.sock')
if($env:DOCKER_HOST -and $env:DOCKER_HOST -notin $localEndpoints){throw 'Remote Docker endpoint forbidden'}
$context=docker context inspect|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $context.Endpoints.docker.Host -notin $localEndpoints){throw 'Local Docker context required'}
if((docker info --format '{{.OSType}}') -ne 'linux'){throw 'Linux containers required'}
$ports=@($BasePort,($BasePort+1),($BasePort+2))
foreach($p in $ports){if(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue){throw "Port $p already in use"}}
$image='mongodb/mongodb-community-server:8.0-ubi8';$runId=[guid]::NewGuid().ToString('N').Substring(0,24);$resource="agro-mn-$runId"
$holderId=$null;$nodeIds=@();$networkCreated=$false;$stage='initialize'
$repositoryRoot=Resolve-Path (Join-Path $PSScriptRoot '..');$evidenceDirectory=Join-Path $repositoryRoot '.local-evidence';New-Item -ItemType Directory -Path $evidenceDirectory -Force|Out-Null
$runLog=Join-Path $evidenceDirectory "be13-07-launcher-$runId.log";$launcherEvidence=Join-Path $evidenceDirectory "be13-07-launcher-$runId.json"
$keys=@('AGRO_MN_ENABLE','AGRO_MN_RUN_ID','AGRO_MN_HOLDER','AGRO_MN_NODES','AGRO_MN_BASE_PORT');$saved=@{};foreach($key in $keys){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
function Wait-MnProbe([string]$Id,[int]$Port,[string]$JavaScript,[int]$Attempts,[string]$Message){
  for($i=1;$i -le $Attempts;$i++){
    $exit=Invoke-Be11DockerQuiet -Arguments @('exec',$Id,'mongosh','--port',[string]$Port,'--quiet','--eval',$JavaScript)
    if($exit -eq 0){return $i};Start-Sleep -Milliseconds 1000
  }
  throw $Message
}
try{
  $stage='pull-official-image';docker pull $image|Out-Null;if($LASTEXITCODE -ne 0){throw 'Official MongoDB image unavailable'}
  $stage='create-exclusive-network'
  docker network create --driver bridge --opt com.docker.network.bridge.gateway_mode_ipv4=nat --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 --opt com.docker.network.bridge.enable_ip_masquerade=false --label "agro.mn.run=$runId" $resource|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Dedicated network creation failed'};$networkCreated=$true
  $stage='create-namespace-holder'
  $publish=@();foreach($p in $ports){$publish+=@('--publish',"127.0.0.1:${p}:${p}")}
  $created=docker create --name "$resource-net" --label "agro.mn.run=$runId" --label 'agro.mn.role=holder' --network $resource @publish --memory 64m --cpus 0.25 --entrypoint sleep $image infinity
  if($LASTEXITCODE -ne 0 -or $created -notmatch '^[a-f0-9]{64}$'){throw 'Holder creation failed'};$holderId=$created.Trim();docker start $holderId|Out-Null;if($LASTEXITCODE -ne 0){throw 'Holder start failed'}
  for($i=0;$i -lt 3;$i++){
    $stage="create-node-$($i+1)";$p=$ports[$i]
    $created=docker create --name "$resource-n$($i+1)" --label "agro.mn.run=$runId" --label "agro.mn.role=node$($i+1)" --network "container:$holderId" --memory 1280m --cpus 1 --tmpfs /data/db:rw,size=1024m,mode=1777 --tmpfs /data/configdb:rw,size=32m,mode=1777 $image --replSet agro_mn --port $p --bind_ip_all
    if($LASTEXITCODE -ne 0 -or $created -notmatch '^[a-f0-9]{64}$'){throw 'Node creation failed'};$nodeIds+=$created.Trim();docker start $created.Trim()|Out-Null;if($LASTEXITCODE -ne 0){throw 'Node start failed'}
  }
  for($i=0;$i -lt 3;$i++){$stage="wait-node-$($i+1)";$null=Wait-MnProbe $nodeIds[$i] $ports[$i] 'quit(db.adminCommand({ping:1}).ok===1?0:1)' 45 'Node readiness deadline'}
  $stage='initiate-replica-set'
  $config="rs.initiate({_id:'agro_mn',members:[{_id:0,host:'127.0.0.1:$($ports[0])',priority:1},{_id:1,host:'127.0.0.1:$($ports[1])',priority:1},{_id:2,host:'127.0.0.1:$($ports[2])',priority:1}]})"
  if((Invoke-Be11DockerQuiet -Arguments @('exec',$nodeIds[0],'mongosh','--port',[string]$ports[0],'--quiet','--eval',$config)) -ne 0){throw 'Replica set initialization failed'}
  $stage='wait-topology'
  $null=Wait-MnProbe $nodeIds[0] $ports[0] "const s=rs.status();quit(s.members.filter(m=>m.stateStr==='PRIMARY').length===1&&s.members.filter(m=>m.stateStr==='SECONDARY').length===2?0:1)" 60 'Topology readiness deadline'
  $env:AGRO_MN_ENABLE='AUTHORIZED_DISPOSABLE_MULTINODE_ONLY';$env:AGRO_MN_RUN_ID=$runId;$env:AGRO_MN_HOLDER=$holderId;$env:AGRO_MN_NODES=($nodeIds -join ',');$env:AGRO_MN_BASE_PORT=[string]$BasePort
  $runner=switch($Suite){'be13-08'{'dist/scripts/audit-be13-08-multinode-local.js'}'be13-09'{'dist/scripts/audit-be13-09-multinode-local.js'}'be13-10b'{'dist/scripts/audit-be13-10b-multinode-local.js'}'be13-11a'{'dist/scripts/audit-be13-11a-multinode-local.js'}'be13-11b'{'dist/scripts/audit-be13-11b-multinode-local.js'}'be13-11c'{'dist/scripts/audit-be13-11c-multinode-local.js'}'be13-11d'{'dist/scripts/audit-be13-11d-emqx-local.js'}'be13-11e'{'dist/scripts/audit-be13-11e-emqx-bench.js'}'be13-11f'{'dist/scripts/audit-be13-11f-emqx-durability.js'}'be13-11l'{'dist/scripts/audit-be13-11l-inbox-index.js'}default{'dist/scripts/audit-be13-07-multinode-local.js'}}
  $stage="execute-$Suite-suite";Push-Location $repositoryRoot;try{& node $runner 2>&1|Tee-Object -FilePath $runLog;if($LASTEXITCODE -ne 0){throw "$Suite multi-node suite failed"}}finally{Pop-Location}
  $stage='suite-complete'
}catch{
  @{runId=$runId;stage=$stage;status='failed';errorClass=$_.Exception.GetType().Name;log=$runLog}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $launcherEvidence
  throw
}finally{
  foreach($key in $keys){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')};$cleanup=$true
  foreach($id in @($nodeIds+@($holderId))){if(-not $id){continue}
    $owned=docker inspect $id|ConvertFrom-Json
    if($LASTEXITCODE -eq 0 -and $owned.Id -eq $id -and $owned.Config.Labels.'agro.mn.run' -eq $runId){docker rm --force --volumes $id|Out-Null;if($LASTEXITCODE -ne 0){$cleanup=$false}}else{$cleanup=$false}}
  if($networkCreated){$network=docker network inspect $resource|ConvertFrom-Json;if($LASTEXITCODE -eq 0 -and $network.Labels.'agro.mn.run' -eq $runId -and @($network.Containers.PSObject.Properties).Count -eq 0){docker network rm $resource|Out-Null;if($LASTEXITCODE -ne 0){$cleanup=$false}}else{$cleanup=$false}}
  $left=@(docker ps -a --filter "label=agro.mn.run=$runId" -q);if($left.Count -gt 0){$cleanup=$false}
  if(-not $cleanup){throw 'Owned resource cleanup unconfirmed'}
  if(-not (Test-Path -LiteralPath $launcherEvidence)){@{runId=$runId;stage=$stage;status='completed';log=$runLog;cleanupConfirmed=$true}|ConvertTo-Json|Set-Content -Encoding UTF8 -LiteralPath $launcherEvidence}
}
