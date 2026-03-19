param([string]$Command = "help")

$ROOT          = $PSScriptRoot
$BACKEND       = Join-Path $ROOT "backend"
$FRONTEND      = Join-Path $ROOT "frontend"
$PYTHON        = Join-Path $BACKEND "venv\Scripts\python.exe"
$COMPOSE_DEV   = Join-Path $ROOT "docker-compose.dev.yml"
$BACKEND_PORT  = 8008
$FRONTEND_PORT = 3008
$PORTS         = @($BACKEND_PORT, $FRONTEND_PORT)

function Get-PidsOnPort($port) {
    try {
        return (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess |
               Where-Object { $_ -gt 0 } | Sort-Object -Unique
    } catch { return @() }
}

function Start-Infra {
    Write-Host "  [INFRA]    Starting Docker services (PostgreSQL:5433, Redis:6379, Qdrant:6333)..." -ForegroundColor Cyan
    $result = & docker compose -f $COMPOSE_DEV up -d 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [INFRA]    Waiting for PostgreSQL to be healthy..." -ForegroundColor Gray
        $attempts = 0
        do {
            Start-Sleep -Seconds 2
            $attempts++
            $health = (& docker inspect sf2d_postgres --format "{{.State.Health.Status}}" 2>$null)
        } while ($health -ne "healthy" -and $attempts -lt 15)

        if ($health -eq "healthy") {
            Write-Host "  [INFRA]    PostgreSQL  healthy  (localhost:5433)" -ForegroundColor Green
        } else {
            Write-Host "  [INFRA]    PostgreSQL  still starting - check: docker logs sf2d_postgres" -ForegroundColor Yellow
        }
        Write-Host "  [INFRA]    Redis       ready    (localhost:6379)" -ForegroundColor Green
        Write-Host "  [INFRA]    Qdrant      ready    (localhost:6333)" -ForegroundColor Green
    } else {
        Write-Host "  [INFRA]    Docker failed. Is Docker Desktop running?" -ForegroundColor Red
        Write-Host $result -ForegroundColor Red
    }
}

function Stop-Infra {
    Write-Host "  [INFRA]    Stopping Docker services..." -ForegroundColor Yellow
    & docker compose -f $COMPOSE_DEV down 2>&1 | Out-Null
    Write-Host "  [INFRA]    Docker services stopped. (Data volumes preserved)" -ForegroundColor Green
}

function Stop-Services {
    Write-Host ""
    Write-Host "  [STOP] Stopping backend + frontend..." -ForegroundColor Yellow
    $killed = 0
    foreach ($port in $PORTS) {
        $pids = Get-PidsOnPort $port
        foreach ($p in $pids) {
            try {
                Stop-Process -Id $p -Force -ErrorAction Stop
                Write-Host "         Killed PID $p (port $port)" -ForegroundColor Gray
                $killed++
            } catch {
                Write-Host "         Cannot kill PID $p on port $port - close its terminal manually" -ForegroundColor Red
            }
        }
    }
    if ($killed -eq 0) {
        Write-Host "         Nothing was running on ports $($PORTS -join ', ')." -ForegroundColor Gray
    }
    Start-Sleep -Seconds 2
    Write-Host "  [STOP] Done." -ForegroundColor Green
}

function Kill-Port($port) {
    $pids = Get-PidsOnPort $port
    foreach ($p in $pids) {
        try {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            Write-Host "         Killed PID $p (port $port)" -ForegroundColor Gray
        } catch {}
    }
    if ($pids.Count -gt 0) { Start-Sleep -Seconds 1 }
}

function Start-Services {
    Write-Host ""

    # Always use fixed ports - kill anything already on them
    Kill-Port $BACKEND_PORT
    Kill-Port $FRONTEND_PORT

    # Ensure frontend .env always points to fixed backend port
    $envFile = Join-Path $FRONTEND ".env"
    Set-Content -Path $envFile -Value "REACT_APP_API_URL=http://localhost:$BACKEND_PORT"
    Write-Host "  [CONFIG]   Frontend .env -> http://localhost:$BACKEND_PORT" -ForegroundColor Gray

    Write-Host "  [BACKEND]  Starting on http://localhost:$BACKEND_PORT ..." -ForegroundColor Cyan
    $backendCmd = "cd '$BACKEND'; Write-Host '[Backend] http://localhost:$BACKEND_PORT' -ForegroundColor Cyan; & '$PYTHON' -m uvicorn app.main:app --host 0.0.0.0 --port $BACKEND_PORT --reload"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd -WindowStyle Normal
    Start-Sleep -Seconds 3
    Write-Host "  [BACKEND]  Started." -ForegroundColor Green

    Write-Host "  [FRONTEND] Starting on http://localhost:$FRONTEND_PORT ..." -ForegroundColor Cyan
    $frontendCmd = "cd '$FRONTEND'; Write-Host '[Frontend] http://localhost:$FRONTEND_PORT' -ForegroundColor Cyan; `$env:PORT='$FRONTEND_PORT'; npm start"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd -WindowStyle Normal
    Write-Host "  [FRONTEND] Started (opens in ~15s)." -ForegroundColor Green

    Write-Host ""
    Write-Host "  Backend  : http://localhost:$BACKEND_PORT" -ForegroundColor White
    Write-Host "  Frontend : http://localhost:$FRONTEND_PORT" -ForegroundColor White
    Write-Host ""
}

function Show-Status {
    Write-Host ""
    Write-Host "  [STATUS]" -ForegroundColor Cyan

    # Docker services
    $containers = @(
        @{ name = "sf2d_postgres"; label = "PostgreSQL  port 5433" },
        @{ name = "sf2d_redis";    label = "Redis       port 6379" },
        @{ name = "sf2d_qdrant";   label = "Qdrant      port 6333" }
    )
    foreach ($c in $containers) {
        $state = (& docker inspect $c.name --format "{{.State.Status}}" 2>$null)
        if ($state -eq "running") {
            $health = (& docker inspect $c.name --format "{{.State.Health.Status}}" 2>$null)
            $tag = if ($health -eq "healthy") { "RUNNING (healthy)" } elseif ($health) { "RUNNING ($health)" } else { "RUNNING" }
            Write-Host "  $($c.label)  $tag" -ForegroundColor Green
        } else {
            Write-Host "  $($c.label)  STOPPED" -ForegroundColor Red
        }
    }

    Write-Host ""

    # App processes
    foreach ($port in $PORTS) {
        $label = if ($port -eq $BACKEND_PORT) { "Backend    port $BACKEND_PORT" } else { "Frontend   port $FRONTEND_PORT" }
        $pids  = Get-PidsOnPort $port
        if ($pids.Count -gt 0) {
            Write-Host "  $label  RUNNING (PID $($pids -join ', '))" -ForegroundColor Green
        } else {
            Write-Host "  $label  STOPPED" -ForegroundColor Red
        }
    }
    Write-Host ""
}

Write-Host ""
Write-Host "  SF2Dynamics Manager" -ForegroundColor Cyan

switch ($Command.ToLower()) {
    "start" {
        Start-Infra
        Start-Services
    }
    "stop" {
        Stop-Services
        Write-Host ""
        $stopInfra = Read-Host "  Stop Docker infra too? (PostgreSQL/Redis/Qdrant) [y/N]"
        if ($stopInfra -eq "y" -or $stopInfra -eq "Y") {
            Stop-Infra
        } else {
            Write-Host "  [INFRA]    Docker services left running." -ForegroundColor Gray
        }
    }
    "stop-all" {
        Stop-Services
        Write-Host ""
        Stop-Infra
    }
    "restart" {
        Stop-Services
        Start-Sleep -Seconds 2
        Start-Infra
        Start-Services
    }
    "infra-start" {
        Start-Infra
    }
    "infra-stop" {
        Stop-Infra
    }
    "status" {
        Show-Status
    }
    default {
        Write-Host ""
        Write-Host "  Usage: .\manage.bat [command]" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  COMMON COMMANDS" -ForegroundColor Cyan
        Write-Host "    start       Start infra (Docker) + backend + frontend" -ForegroundColor White
        Write-Host "    stop        Stop backend + frontend  (ask about infra)" -ForegroundColor White
        Write-Host "    stop-all    Stop everything including Docker infra" -ForegroundColor White
        Write-Host "    restart     Full restart (infra + backend + frontend)" -ForegroundColor White
        Write-Host "    status      Show what is running" -ForegroundColor White
        Write-Host ""
        Write-Host "  INFRA ONLY" -ForegroundColor Cyan
        Write-Host "    infra-start  Start PostgreSQL + Redis + Qdrant (Docker)" -ForegroundColor White
        Write-Host "    infra-stop   Stop Docker infra (data is preserved)" -ForegroundColor White
        Write-Host ""
        Write-Host "  PORTS" -ForegroundColor Cyan
        Write-Host "    Backend   http://localhost:$BACKEND_PORT" -ForegroundColor White
        Write-Host "    Frontend  http://localhost:$FRONTEND_PORT" -ForegroundColor White
        Write-Host "    PG        localhost:5433  (Docker - avoids conflict with local PG on 5432)" -ForegroundColor White
        Write-Host "    Redis     localhost:6379" -ForegroundColor White
        Write-Host "    Qdrant    localhost:6333" -ForegroundColor White
        Write-Host ""
    }
}
