@echo off
rem Argus on Windows without Docker: build and run the production server in the background, with a menu to
rem start, stop, restart and monitor it. Settings come from .env in this folder. Needs Node.js 24 and git.
setlocal EnableExtensions
set "EMPTY=0"
cd /d "%~dp0"
title Argus
set "LOGDIR=%~dp0logs"
set "LOG=%LOGDIR%\argus.log"
set "PIDFILE=%LOGDIR%\argus.pid"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

set "PORT=8080"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%~b"
set "URL=http://127.0.0.1:%PORT%"

:menu
call :isrunning
echo.
echo  ==================== Argus ====================
if "%RUNNING%"=="1" (echo   Status: running ^(process %PID%^), port %PORT%) else (echo   Status: stopped)
echo  -----------------------------------------------
echo   1  Start            build, then start
echo   2  Stop
echo   3  Restart          stop, build, start
echo   4  Status           health of database and worker
echo   5  Live log         Ctrl+C, then N, to return here
echo   6  Install          npm ci ^(after a git pull^)
echo   0  Exit             Argus keeps running
echo  ===============================================
set "CHOICE="
set /p "CHOICE=  Choose: "
if "%CHOICE%"=="1" call :start & goto menu
if "%CHOICE%"=="2" call :stop & goto menu
if "%CHOICE%"=="3" call :stop & call :start & goto menu
if "%CHOICE%"=="4" call :status & goto menu
if "%CHOICE%"=="5" call :logs & goto menu
if "%CHOICE%"=="6" call :install & goto menu
if "%CHOICE%"=="0" exit /b 0
rem Stop on end of input (e.g. run from a script) instead of redrawing the menu forever.
if not defined CHOICE set /a EMPTY+=1
if defined CHOICE set "EMPTY=0"
if %EMPTY% geq 5 exit /b 0
goto menu

:isrunning
set "RUNNING=0"
set "PID="
if not exist "%PIDFILE%" exit /b 0
set /p PID=<"%PIDFILE%"
if not defined PID exit /b 0
tasklist /FI "PID eq %PID%" /NH 2>nul | find " %PID% " >nul && set "RUNNING=1"
exit /b 0

:start
call :isrunning
if "%RUNNING%"=="1" (echo   Argus is already running ^(process %PID%^). & exit /b 0)
if not exist ".env" (echo   .env is missing: copy .env.example to .env and fill it in. & exit /b 1)
echo   Building...
call npm run build
if errorlevel 1 (echo   Build failed; Argus was not started. & exit /b 1)
if exist "%LOG%" move /y "%LOG%" "%LOGDIR%\argus.previous.log" >nul
rem Runs hidden and detached, so it keeps running after this window closes.
powershell -NoProfile -Command "$p = Start-Process -FilePath cmd.exe -ArgumentList '/d /c npm start -w @argus/server >> logs\argus.log 2>&1' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; $p.Id" > "%PIDFILE%"
call :isrunning
echo   Started ^(process %PID%^). Waiting for %URL%/readyz ...
powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-RestMethod '%URL%/readyz' -TimeoutSec 3; Write-Host ('  Ready: Argus ' + $r.version + ', database ' + $r.database.type + ' ok'); exit 0 } catch { Start-Sleep 2 } }; Write-Host '  Not ready after 2 minutes; check the log (option 5).'; exit 1"
exit /b 0

:stop
call :isrunning
if not "%RUNNING%"=="1" (echo   Argus is not running. & del "%PIDFILE%" 2>nul & exit /b 0)
echo   Stopping process %PID%...
taskkill /PID %PID% /T /F >nul 2>&1
del "%PIDFILE%" 2>nul
echo   Stopped.
exit /b 0

:status
call :isrunning
if "%RUNNING%"=="1" (echo   Process: running ^(%PID%^)) else (echo   Process: not started from this menu)
powershell -NoProfile -Command "try { $r = Invoke-RestMethod '%URL%/readyz' -TimeoutSec 5; $age = [int]((Get-Date) - [datetime]$r.worker.lastSeen).TotalSeconds; Write-Host ('  Version:  ' + $r.version + ' (' + $r.role + ')'); Write-Host ('  Database: ' + $r.database.type + ', ' + $(if ($r.database.ok) { 'ok' } else { 'NOT OK' })); Write-Host ('  Worker:   last seen ' + $age + 's ago on ' + $r.worker.host); Write-Host ('  Web:      %URL%') } catch { Write-Host ('  Not responding on %URL%: ' + $_.Exception.Message) }"
exit /b 0

:logs
if not exist "%LOG%" (echo   No log yet. & exit /b 0)
powershell -NoProfile -Command "$names = @{10='TRACE';20='DEBUG';30='INFO';40='WARN';50='ERROR';60='FATAL'}; Get-Content '%LOG%' -Tail 40 -Wait | ForEach-Object { $l = $_; try { $j = $l | ConvertFrom-Json -ErrorAction Stop; $m = $j.msg; if ($j.err) { $m += ' - ' + $j.err.message }; '{0} {1,-5} {2}' -f [DateTimeOffset]::FromUnixTimeMilliseconds([long]$j.time).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss'), $names[[int]$j.level], $m } catch { $l } }"
exit /b 0

:install
call npm ci
exit /b 0
