@echo off
echo ==========================================
echo   Synapse Integration Hub - Server Setup
echo ==========================================
echo.
echo Prerequisites: Node.js, PostgreSQL, Redis
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download from: https://nodejs.org
    pause
    exit /b 1
)

:: Check PostgreSQL
where psql >nul 2>nul
if %errorlevel% neq 0 (
    echo WARNING: PostgreSQL CLI (psql) not found in PATH.
    echo Download from: https://www.postgresql.org/download/windows/
    echo Make sure to add PostgreSQL bin folder to your PATH.
    echo.
)

:: ── Step 1: Create database ──
echo [1/5] Setting up PostgreSQL database...
echo.
echo Run these commands in psql (or pgAdmin):
echo.
echo   CREATE USER synapse WITH PASSWORD 'synapse';
echo   CREATE DATABASE synapse_db OWNER synapse;
echo   \c synapse_db
echo   CREATE SCHEMA app AUTHORIZATION synapse;
echo   CREATE SCHEMA jira_data AUTHORIZATION synapse;
echo.
echo Press any key after database is created...
pause >nul

:: ── Step 2: Copy env file ──
echo.
echo [2/5] Setting up environment...
cd /d "%~dp0"
if not exist "packages\backend\.env" (
    copy .env.example packages\backend\.env
    echo Created packages\backend\.env from .env.example
    echo IMPORTANT: Edit packages\backend\.env with your credentials!
    echo.
    notepad packages\backend\.env
    echo Press any key after saving .env...
    pause >nul
) else (
    echo packages\backend\.env already exists - skipping
)

if not exist ".env" (
    copy .env.example .env
    echo Created root .env from .env.example
) else (
    echo Root .env already exists - skipping
)

:: ── Step 3: Install dependencies ──
echo.
echo [3/5] Installing dependencies...
call npm run install:all
if %errorlevel% neq 0 (
    echo ERROR: Failed to install dependencies.
    pause
    exit /b 1
)

:: ── Step 4: Push DB schema ──
echo.
echo [4/5] Pushing database schema via Drizzle...
cd /d "%~dp0packages\backend"
call npx drizzle-kit push
if %errorlevel% neq 0 (
    echo ERROR: Database schema push failed.
    echo Make sure PostgreSQL is running and .env DATABASE_URL is correct.
    pause
    exit /b 1
)

:: ── Step 5: Build ──
echo.
echo [5/5] Building application...
cd /d "%~dp0"
call npm run build:frontend
cd /d "%~dp0packages\backend"
call npm run build
if %errorlevel% neq 0 (
    echo ERROR: Build failed.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo   Setup Complete!
echo ==========================================
echo.
echo To start the server, double-click: start-qa.bat
echo Server will be available at: http://localhost:4000
echo.
pause
