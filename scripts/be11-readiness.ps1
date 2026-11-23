function Invoke-Be11DockerQuiet {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @Arguments 1>$null 2>$null
        return [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Get-Be11ContainerState {
    param([Parameter(Mandatory = $true)][string]$ContainerId)

    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $stateText = & docker inspect --format '{{.State.Running}}|{{.State.ExitCode}}|{{.State.Status}}' $ContainerId 2>$null
        $inspectExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($inspectExit -ne 0 -or $stateText -notmatch '^(true|false)\|(-?\d+)\|([a-z]+)$') {
        throw 'Owned container state inspection failed'
    }
    return [pscustomobject]@{
        Running = $Matches[1] -eq 'true'
        ExitCode = [int]$Matches[2]
        Status = $Matches[3]
    }
}

function Wait-Be11MongoProbe {
    param(
        [Parameter(Mandatory = $true)][string]$ContainerId,
        [Parameter(Mandatory = $true)][string]$JavaScript,
        [Parameter(Mandatory = $true)][string]$DeadlineMessage,
        [ValidateRange(1, 300)][int]$MaximumAttempts,
        [ValidateRange(0, 5000)][int]$IntervalMilliseconds = 1000
    )

    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
        $state = Get-Be11ContainerState -ContainerId $ContainerId
        if (-not $state.Running) {
            throw "Owned MongoDB container stopped before readiness (status=$($state.Status), exit=$($state.ExitCode))"
        }
        $probeExit = Invoke-Be11DockerQuiet -Arguments @('exec', $ContainerId, 'mongosh', '--quiet', '--eval', $JavaScript)
        if ($probeExit -eq 0) {
            return $attempt
        }
        if ($attempt -lt $MaximumAttempts -and $IntervalMilliseconds -gt 0) {
            Start-Sleep -Milliseconds $IntervalMilliseconds
        }
    }
    throw $DeadlineMessage
}
