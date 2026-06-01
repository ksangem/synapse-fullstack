@echo off
echo ==========================================
echo   Synapse Integration Hub - QA Server
echo ==========================================
echo.

:: Check Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Please install Node.js first.
    pause
    exit /b 1
)

echo [1/4] Installing dependencies...
cd /d "%~dp0"
call npm run install:all
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [2/4] Building frontend...
call npm run build:frontend
if %errorlevel% neq 0 (
    echo ERROR: Frontend build failed.
    pause
    exit /b 1
)

echo.
echo [3/4] Building backend...
cd /d "%~dp0packages\backend"
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Backend build failed.
    pause
    exit /b 1
)

echo.
echo [4/4] Starting server...
echo ==========================================
echo   Server running at http://localhost:4000
echo   Press Ctrl+C to stop
echo ==========================================
echo.
call npm start
pause
