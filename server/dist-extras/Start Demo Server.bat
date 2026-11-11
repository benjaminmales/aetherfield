@echo off
rem Starts the Aetherfield Demo Server. Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS installer from https://nodejs.org, then try again.
  pause
  exit /b 1
)
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
pause
