# Synapse — Windows VM (IIS) Hosting Guide

> **Version:** 2.4.1 · **Last updated:** 2026-06-03  
> **Goal:** Deploy Synapse (Express API + React/Vite + PostgreSQL + Redis) on a **Windows Server or Windows 11 VM**, fronted by **IIS** on ports 80/443.  
> **Tested on:** Windows 11 Pro (build 26200) — same steps apply to Windows Server 2019/2022.

---

## Table of contents

1. [Architecture](#1-architecture)
2. [VM requirements](#2-vm-requirements)
3. [Complete software & tools list](#3-complete-software--tools-list)
4. [Phase 1 — Install all prerequisites](#4-phase-1--install-all-prerequisites)
5. [Phase 2 — Database setup](#5-phase-2--database-setup)
6. [Phase 3 — Deploy the application](#6-phase-3--deploy-the-application)
7. [Phase 4 — Backend Windows service (NSSM)](#7-phase-4--backend-windows-service-nssm)
8. [Phase 5 — IIS site & frontend publish](#8-phase-5--iis-site--frontend-publish)
9. [Phase 6 — Firewall, HTTPS, verification](#9-phase-6--firewall-https-verification)
10. [Operations & updates](#10-operations--updates)
11. [Troubleshooting](#11-troubleshooting)
12. [Quick reference](#12-quick-reference)
13. [Appendices](#13-appendices)

---

## 1. Architecture

```
                    Intranet / LAN
                          │
                   HTTP :80 / HTTPS :443
                          │
                  ┌───────▼────────┐
                  │      IIS       │  URL Rewrite + ARR reverse proxy
                  │  Synapse site  │  Static files: C:\inetpub\synapse
                  └───┬────────┬───┘
         /api/* ──────┘        └────── /*  (React SPA from dist/)
             │
    ┌────────▼─────────┐
    │  Node backend    │  Windows Service "SynapseBackend" (NSSM)
    │  Express :4000   │  Listens on 127.0.0.1:4000 only
    └────────┬─────────┘
             │
    ┌────────┴────────┐
    │                 │
┌───▼────┐      ┌─────▼─────┐
│Postgres│      │  Memurai  │  (Redis-compatible, port 6379)
│ :5432  │      │  (Redis)  │
└────────┘      └───────────┘
```

**Important design choices (from production deployment):**

| Choice | Why |
|--------|-----|
| IIS serves **static** React build | Fast; only `/api` and `/health` proxy to Node |
| Node runs as **Windows Service** via NSSM | Survives reboot; not tied to an open terminal |
| **Wrapper `.cmd`** for NSSM | Paths with spaces (e.g. `AI Initiatives`) break direct `node.exe` args |
| **`setup-database.sql` before Drizzle** | Creates `app` + `jira_data` schemas; `drizzle-kit push` alone fails without them |
| **Memurai** instead of Redis | No official Redis for Windows |
| Ports **4000, 5432, 6379** stay localhost-only | Only 80/443 exposed on the firewall |

---

## 2. VM requirements

| Item | Minimum | Recommended |
|------|---------|-------------|
| OS | Windows Server 2019 **or** Windows 11 Pro | Windows Server 2022 |
| vCPU | 2 | 4 |
| RAM | 4 GB | 8 GB (Playwright + Postgres + Redis) |
| Disk | 40 GB | 80 GB SSD |
| Access | Local Administrator | RDP + local admin |
| Network | Outbound HTTPS (Jira, Microsoft Graph) | Inbound 80/443 for users |

**Security:** Synapse has **no built-in authentication**. Use VPN, IP allow-list, or an auth gateway before exposing beyond the intranet.

---

## 3. Complete software & tools list

Install **in this order**. Every item includes purpose, version, and how to install.

| # | Tool | Version | Purpose | Install method | Section |
|---|------|---------|---------|----------------|---------|
| 0 | **Chocolatey** | 2.x | Package manager for repeatable installs | PowerShell script | [§4.1](#41-install-chocolatey) |
| 1 | **Node.js LTS** | 20.x+ | Run Express backend; build Vite frontend | `choco install nodejs-lts` | [§4.2](#42-install-nodejs) |
| 2 | **Git** | latest | Clone the repository | `choco install git` | [§4.3](#43-install-git) |
| 3 | **PostgreSQL** | 16.x | Primary database (`synapse_db`) | EDB installer **or** binaries ZIP (fallback) | [§4.4](#44-install-postgresql-16) |
| 4 | **Memurai Developer** | 4.x | Redis-compatible queue/cache (BullMQ) | `choco install memurai-developer` | [§4.5](#45-install-memurai-redis) |
| 5 | **IIS + features** | built-in | Web server + static hosting | `Enable-WindowsOptionalFeature` | [§4.6](#46-enable-iis) |
| 6 | **URL Rewrite Module** | 2.1 | IIS rewrite rules | `choco install urlrewrite` | [§4.7](#47-url-rewrite--arr) |
| 7 | **Application Request Routing** | 3.0 | IIS reverse proxy to Node | `choco install iis-arr` | [§4.7](#47-url-rewrite--arr) |
| 8 | **NSSM** | 2.24+ | Run Node as a Windows Service | `choco install nssm` | [§4.8](#48-install-nssm) |
| 9 | **Visual C++ Build Tools** | 2022 | Optional; avoids native `npm` compile failures | `choco install visualstudio2022buildtools` | [§4.9](#49-visual-c-build-tools-optional) |
| 10 | **Playwright Chromium** | bundled | Jira SSO/MFA browser scraping (if used) | `npx playwright install chromium` | [§6.5](#65-playwright-optional) |

**Repo-bundled files (no download):**

| File | Purpose |
|------|---------|
| `setup-database.sql` | Creates role, database, `app` + `jira_data` schemas |
| `deploy/web.config` | IIS reverse-proxy + SPA fallback |
| `deploy/start-backend.cmd.template` | NSSM wrapper (edit `REPO_ROOT`) |
| `.env.example` | Template for backend environment variables |

---

## 4. Phase 1 — Install all prerequisites

> Run all commands in **PowerShell as Administrator**.

### 4.1 Install Chocolatey

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Refresh PATH in this session
$env:ChocolateyInstall = 'C:\ProgramData\chocolatey'
$env:Path = "$env:Path;C:\ProgramData\chocolatey\bin"
choco --version
```

**Verify:** prints `2.x.x`

---

### 4.2 Install Node.js

```powershell
choco install nodejs-lts -y
```

Open a **new** PowerShell window, then:

```powershell
node -v    # expect v20.x or v22.x
npm -v
```

**Manual alternative:** <https://nodejs.org/en/download> → Windows x64 MSI → check "Add to PATH".

---

### 4.3 Install Git

```powershell
choco install git -y
git --version
```

**Manual alternative:** <https://git-scm.com/download/win>

---

### 4.4 Install PostgreSQL 16

Two methods. Use **Method A** first; if the installer hangs, use **Method B** (proven on Windows 11).

#### Method A — EDB / Chocolatey installer (preferred on Server)

```powershell
choco install postgresql16 --params "/Password:YourStrongPostgresPassword /Port:5432" -y
```

- Default install path: `C:\Program Files\PostgreSQL\16`
- Service name is usually `postgresql-x64-16`
- Superuser: `postgres` / password you set above

> **Known issue:** The unattended EDB installer can hang at "Installing postgresql16..." with no progress for 10+ minutes. If that happens, kill the installer process and use **Method B**.

#### Method B — Binaries ZIP (reliable fallback)

```powershell
New-Item -ItemType Directory -Force -Path C:\PGsetup | Out-Null
cd C:\PGsetup

# Download official Windows binaries (~310 MB)
curl.exe -L -o pg16-binaries.zip `
  "https://get.enterprisedb.com/postgresql/postgresql-16.14-1-windows-x64-binaries.zip"

Expand-Archive pg16-binaries.zip -DestinationPath C:\PGsetup\extracted -Force
Move-Item C:\PGsetup\extracted\pgsql C:\PostgreSQL\16 -Force

# Initialize cluster
$pw = 'YourStrongPostgresPassword'
Set-Content C:\PGsetup\pwfile.txt $pw -NoNewline -Encoding ascii
& 'C:\PostgreSQL\16\bin\initdb.exe' -D 'C:\PostgreSQL\16\data' -U postgres `
  --auth-host=md5 --auth-local=md5 -E UTF8 --pwfile=C:\PGsetup\pwfile.txt
Remove-Item C:\PGsetup\pwfile.txt -Force

# Register and start Windows service
& 'C:\PostgreSQL\16\bin\pg_ctl.exe' register -N postgresql-16 -D 'C:\PostgreSQL\16\data' -S auto
Start-Service postgresql-16

# Add to system PATH
$p = [Environment]::GetEnvironmentVariable('Path','Machine')
if ($p -notlike '*PostgreSQL\16\bin*') {
  [Environment]::SetEnvironmentVariable('Path', "$p;C:\PostgreSQL\16\bin", 'Machine')
}
```

**Verify PostgreSQL:**

```powershell
Get-Service postgresql-16,postgresql-x64-16 -ErrorAction SilentlyContinue
& 'C:\PostgreSQL\16\bin\psql.exe' --version
# or: psql --version  (if on PATH)
(Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue).Count
# expect >= 1
```

---

### 4.5 Install Memurai (Redis)

Redis has **no official Windows build**. Memurai is a drop-in replacement.

```powershell
choco install memurai-developer -y
```

**Manual alternative:** <https://www.memurai.com/get-memurai> → Memurai Developer MSI.

**Verify:**

```powershell
Get-Service Memurai
& 'C:\Program Files\Memurai\memurai-cli.exe' ping
# expect: PONG
```

---

### 4.6 Enable IIS

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName `
  IIS-WebServerRole, IIS-WebServer, IIS-CommonHttpFeatures, `
  IIS-StaticContent, IIS-DefaultDocument, IIS-HttpErrors, `
  IIS-HttpRedirect, IIS-ApplicationDevelopment, IIS-RequestFiltering, `
  IIS-HttpCompressionStatic, IIS-ManagementConsole -All
```

**Verify:** browse `http://localhost/` — default IIS page appears.

---

### 4.7 URL Rewrite + ARR

Install **URL Rewrite first**, then ARR:

```powershell
choco install urlrewrite -y
choco install iis-arr -y
```

**Manual downloads:**
- URL Rewrite 2.1: <https://www.iis.net/downloads/microsoft/url-rewrite>
- ARR 3.0: <https://www.iis.net/downloads/microsoft/application-request-routing>

**Enable reverse proxy globally (required):**

```powershell
& "$env:windir\System32\inetsrv\appcmd.exe" set config `
  -section:system.webServer/proxy /enabled:"True" /commit:apphost
```

Or in **IIS Manager** (`inetmgr`) → server node → **Application Request Routing Cache** → **Server Proxy Settings** → check **Enable proxy** → Apply.

**Verify:**

```powershell
& "$env:windir\System32\inetsrv\appcmd.exe" list config -section:system.webServer/proxy
# expect: enabled="true"
```

---

### 4.8 Install NSSM

```powershell
choco install nssm -y
(Get-Command nssm).Source
# expect: C:\ProgramData\chocolatey\bin\nssm.exe
```

**Manual alternative:** <https://nssm.cc/download> → extract `win64\nssm.exe`.

---

### 4.9 Visual C++ Build Tools (optional)

Only needed if `npm install` fails on native modules:

```powershell
choco install visualstudio2022buildtools `
  --package-parameters "--add Microsoft.VisualStudio.Workload.VCTools" -y
```

---

## 5. Phase 2 — Database setup

> **Critical:** Run `setup-database.sql` **before** `drizzle-kit push`. Drizzle creates **tables** inside existing schemas; it does **not** create the `app` and `jira_data` schemas.

### 5.1 Run `setup-database.sql`

From the repo root (adjust `psql` path if PostgreSQL is in Program Files):

```powershell
cd C:\apps\synapse-fullstack   # or your clone path
$env:PGPASSWORD = 'YourStrongPostgresPassword'
& 'C:\PostgreSQL\16\bin\psql.exe' -U postgres -h localhost -f setup-database.sql
```

This script:
1. Creates role `synapse` (password `synapse` by default — **change in production**)
2. Creates database `synapse_db`
3. Creates schemas `app` and `jira_data` owned by `synapse`
4. Grants privileges

**Verify:**

```powershell
$env:PGPASSWORD = 'synapse'
psql -U synapse -h localhost -d synapse_db -c "\dn"
# expect: app, jira_data, public
```

---

## 6. Phase 3 — Deploy the application

### 6.1 Clone the repository

```powershell
New-Item -ItemType Directory -Force -Path C:\apps | Out-Null
cd C:\apps
git clone <your-repo-url> synapse-fullstack
cd synapse-fullstack
```

> **Tip:** Avoid spaces in the clone path if possible (e.g. `C:\apps\synapse-fullstack`). If the path contains spaces, you **must** use the NSSM wrapper script in [§7](#7-phase-4--backend-windows-service-nssm).

---

### 6.2 Install npm dependencies

```powershell
cd C:\apps\synapse-fullstack
npm install
npm run install:all
```

**Verify:** `packages\backend\node_modules` and `packages\frontend\node_modules` exist.

---

### 6.3 Configure backend `.env`

```powershell
$key = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
@"
DATABASE_URL=postgresql://synapse:synapse@localhost:5432/synapse_db
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=$key
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
"@ | Out-File -Encoding ascii packages\backend\.env
```

Add SharePoint / Jira credentials from `.env.example` if needed for your demo.

> **Record the `ENCRYPTION_KEY` securely.** Changing it later makes stored credentials unreadable.

---

### 6.4 Create database tables (Drizzle)

```powershell
cd packages\backend
npx drizzle-kit push --force
cd ..\..
```

**Verify tables:**

```powershell
$env:PGPASSWORD = 'synapse'
psql -U synapse -h localhost -d synapse_db -c "\dt app.*"
psql -U synapse -h localhost -d synapse_db -c "\dt jira_data.*"
```

If you see `schema "app" does not exist`, re-run [§5.1](#51-run-setup-databasesql).

---

### 6.5 Playwright (optional)

Only if using Jira Flatiron / browser MFA:

```powershell
cd packages\backend
npx playwright install chromium
cd ..\..
```

---

### 6.6 Build frontend and backend

The frontend must use **same-origin API calls** when served through IIS (port 80). The codebase defaults to same-origin in production builds (`import.meta.env.PROD ? '' : ...` in `packages/frontend/src/services/api.js`).

```powershell
cd C:\apps\synapse-fullstack

# Frontend → packages/frontend/dist
cd packages\frontend
npm run build
cd ..\..

# Backend → packages/backend/dist
cd packages\backend
npm run build
cd ..\..
```

**Verify:**

```powershell
Test-Path packages\frontend\dist\index.html    # True
Test-Path packages\backend\dist\index.js       # True
```

---

## 7. Phase 4 — Backend Windows service (NSSM)

### Why a wrapper script?

NSSM passes arguments to `node.exe` as a single string. If your repo path contains **spaces** (e.g. `d:\source-codes\AI Initiatives\...`), Node fails with:

```
Error: Cannot find module 'd:\source-codes\AI'
```

**Fix:** use a `.cmd` wrapper with quoted paths.

### 7.1 Create the wrapper

Edit `deploy/start-backend.cmd.template` or create `C:\synapse\start-backend.cmd`:

```bat
@echo off
set REPO_ROOT=C:\apps\synapse-fullstack
cd /d "%REPO_ROOT%\packages\backend"
"C:\Program Files\nodejs\node.exe" dist\index.js
```

Replace `REPO_ROOT` with your actual clone path.

```powershell
New-Item -ItemType Directory -Force -Path C:\synapse | Out-Null
Copy-Item deploy\start-backend.cmd.template C:\synapse\start-backend.cmd
notepad C:\synapse\start-backend.cmd   # edit REPO_ROOT
```

### 7.2 Register and start the service

```powershell
$repo  = 'C:\apps\synapse-fullstack'
$nssm  = 'C:\ProgramData\chocolatey\bin\nssm.exe'

New-Item -ItemType Directory -Force -Path "$repo\logs" | Out-Null

# Remove old service if re-installing
& $nssm stop SynapseBackend 2>$null
& $nssm remove SynapseBackend confirm 2>$null

# Install via cmd.exe wrapper (handles paths with spaces)
& $nssm install SynapseBackend "$env:ComSpec" '/c C:\synapse\start-backend.cmd'
& $nssm set SynapseBackend AppDirectory 'C:\synapse'
& $nssm set SynapseBackend AppStdout "$repo\logs\backend-out.log"
& $nssm set SynapseBackend AppStderr "$repo\logs\backend-err.log"
& $nssm set SynapseBackend Start SERVICE_AUTO_START
& $nssm start SynapseBackend
Start-Sleep 5
```

**Verify:**

```powershell
Get-Service SynapseBackend
# Status: Running

(Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue).Count
# expect >= 1

Invoke-WebRequest http://localhost:4000/health -UseBasicParsing
# expect: {"status":"ok"}
```

**If service is Paused or Stopped**, read the log:

```powershell
Get-Content "$repo\logs\backend-err.log" -Tail 30
```

**Quick demo fallback** (no service — keep terminal open):

```powershell
cd C:\apps\synapse-fullstack\packages\backend
npm run dev
```

---

## 8. Phase 5 — IIS site & frontend publish

> **Common mistake:** IIS shows a **placeholder page** if you never copy `packages/frontend/dist/*` to the site folder.

### 8.1 Create site folder and copy `web.config`

```powershell
$site = 'C:\inetpub\synapse'
New-Item -ItemType Directory -Force -Path $site | Out-Null
Copy-Item deploy\web.config "$site\web.config" -Force
```

The repo `deploy/web.config` contains:
- **ProxyApi** — forwards `/api/*` and `/health` to `http://127.0.0.1:4000`
- **SpaFallback** — serves `index.html` for React client-side routes

---

### 8.2 Publish the React build

```powershell
$repo = 'C:\apps\synapse-fullstack'
$site = 'C:\inetpub\synapse'

# Keep web.config; remove old static files
Get-ChildItem $site -Exclude 'web.config' | Remove-Item -Recurse -Force

# Copy fresh build
Copy-Item -Recurse -Force "$repo\packages\frontend\dist\*" $site
```

**Verify site contents:**

```powershell
Get-ChildItem C:\inetpub\synapse
# expect: assets\, index.html, favicon.svg, web.config
# NOT the old "Frontend build not yet deployed" placeholder text
```

---

### 8.3 Create the IIS website

```powershell
Import-Module WebAdministration

# Stop Default Web Site if it holds port 80
Stop-Website -Name 'Default Web Site' -ErrorAction SilentlyContinue

# Create Synapse site on port 80
if (-not (Get-Website -Name 'Synapse' -ErrorAction SilentlyContinue)) {
  New-Website -Name 'Synapse' -Port 80 -PhysicalPath 'C:\inetpub\synapse' -Force
}
Start-Website -Name 'Synapse'
```

> If other sites already use port 80 with host headers, bind Synapse to a free port (e.g. 8080) or use a dedicated hostname.

---

### 8.4 Verify through IIS

```powershell
# Health via reverse proxy
Invoke-WebRequest http://localhost/health -UseBasicParsing
# expect: {"status":"ok"}

# React app (not placeholder)
$r = Invoke-WebRequest http://localhost/ -UseBasicParsing
$r.Content -match 'assets/index'
# expect: True
```

Hard-refresh the browser: **Ctrl+F5** at `http://localhost/` (or `http://<vm-ip>/`).

---

## 9. Phase 6 — Firewall, HTTPS, verification

### 9.1 Firewall (open web ports only)

```powershell
New-NetFirewallRule -DisplayName 'Synapse HTTP'  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Synapse HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -ErrorAction SilentlyContinue
```

**Do NOT** open 4000, 5432, or 6379 to the network.

---

### 9.2 HTTPS (optional, intranet)

```powershell
$cert = New-SelfSignedCertificate -DnsName 'synapse.internal.local' -CertStoreLocation 'cert:\LocalMachine\My'
New-WebBinding -Name 'Synapse' -Protocol https -Port 443
$bind = Get-WebBinding -Name 'Synapse' -Protocol https
$bind.AddSslCertificate($cert.Thumbprint, 'My')
```

---

### 9.3 Full verification checklist

| Check | Command | Expected |
|-------|---------|----------|
| PostgreSQL | `Get-Service postgresql-16` | Running |
| Redis | `Get-Service Memurai` | Running |
| Backend service | `Get-Service SynapseBackend` | Running |
| Backend direct | `http://localhost:4000/health` | `{"status":"ok"}` |
| Backend via IIS | `http://localhost/health` | `{"status":"ok"}` |
| Frontend | `http://localhost/` | Synapse UI (not placeholder) |
| From LAN | `http://<vm-ip>/` | Same UI loads |

---

## 10. Operations & updates

### Service control

```powershell
Restart-Service SynapseBackend
Get-Content C:\apps\synapse-fullstack\logs\backend-err.log -Tail 50
```

### Deploy a new version

```powershell
cd C:\apps\synapse-fullstack
git pull
npm run install:all

cd packages\frontend
npm run build
cd ..\..

cd packages\backend
npm run build
npx drizzle-kit push --force
cd ..\..

# Refresh IIS static files (keep web.config)
$site = 'C:\inetpub\synapse'
Get-ChildItem $site -Exclude 'web.config' | Remove-Item -Recurse -Force
Copy-Item -Recurse -Force packages\frontend\dist\* $site

Restart-Service SynapseBackend
```

### Database backup

```powershell
$env:PGPASSWORD = 'synapse'
pg_dump -U synapse -h localhost -d synapse_db -F c -f "C:\backups\synapse_$(Get-Date -f yyyyMMdd).dump"
```

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Placeholder page ("Frontend build not yet deployed") | `dist` never copied to IIS | [§8.2](#82-publish-the-react-build) |
| `/health` → 502 Bad Gateway | Backend not running | `Get-Service SynapseBackend`; check `backend-err.log`; [§7](#7-phase-4--backend-windows-service-nssm) |
| `Cannot find module 'd:\source-codes\AI'` | NSSM + path with spaces | Use `C:\synapse\start-backend.cmd` wrapper [§7.1](#71-create-the-wrapper) |
| `schema "app" does not exist` | Skipped `setup-database.sql` | Run [§5.1](#51-run-setup-databasesql), then `drizzle-kit push` |
| Drizzle says "Changes applied" but 0 tables | Schemas missing | Same as above |
| `ECONNREFUSED 6379` | Memurai stopped | `Start-Service Memurai` |
| `password authentication failed` | Wrong DB password in `.env` | Match `DATABASE_URL` to `setup-database.sql` credentials |
| Frontend loads, API fails from remote PC | API calls go to `:4000` (firewall closed) | Rebuild frontend with prod same-origin logic; use IIS `/api` proxy |
| IIS 502.3 on `/api` | ARR proxy disabled | [§4.7](#47-url-rewrite--arr) enable proxy |
| SPA route 404 (e.g. `/wizard`) | Missing SpaFallback rule | Use `deploy/web.config` [§8.1](#81-create-site-folder-and-copy-webconfig) |
| Chocolatey PostgreSQL hangs | EDB unattended installer bug | Kill process; use binaries ZIP [§4.4 Method B](#method-b--binaries-zip-reliable-fallback) |
| Service status **Paused** | Node exited immediately | Read `backend-err.log` |

---

## 12. Quick reference

| Item | Value |
|------|-------|
| App source (example) | `C:\apps\synapse-fullstack` |
| Backend entry | `packages\backend\dist\index.js` |
| Backend (internal) | `http://127.0.0.1:4000` |
| Health check | `/health` → `{"status":"ok"}` |
| IIS site root | `C:\inetpub\synapse` |
| IIS site name | `Synapse` |
| NSSM wrapper | `C:\synapse\start-backend.cmd` |
| Backend service | `SynapseBackend` |
| Backend logs | `<repo>\logs\backend-out.log`, `backend-err.log` |
| PostgreSQL | `localhost:5432`, db `synapse_db`, user `synapse` |
| Postgres superuser | `postgres` (password set at install) |
| Redis (Memurai) | `localhost:6379` |
| Public ports | **80**, **443** only |
| Repo config files | `setup-database.sql`, `deploy/web.config`, `deploy/start-backend.cmd.template` |

---

## 13. Appendices

### Appendix A — One-shot Chocolatey install (all tools)

Run after Chocolatey is installed ([§4.1](#41-install-chocolatey)):

```powershell
choco install nodejs-lts git memurai-developer urlrewrite iis-arr nssm -y
# PostgreSQL separately — see §4.4 (installer may hang; have Method B ready)
```

Then run IIS enable + ARR proxy + database + app deploy sections above.

---

### Appendix B — PM2 alternative to NSSM

```powershell
npm install -g pm2 pm2-windows-service
pm2-service-install -n PM2
cd C:\apps\synapse-fullstack\packages\backend
pm2 start dist/index.js --name synapse-backend
pm2 save
```

---

### Appendix C — Redis alternatives

```powershell
# Docker Desktop
docker run -d --name synapse-redis -p 127.0.0.1:6379:6379 redis:7-alpine

# WSL2 Ubuntu
wsl --install
# inside WSL: sudo apt update && sudo apt install -y redis-server && sudo service redis-server start
```

---

### Appendix D — Share app on LAN (QA / demo)

On the VM:

```powershell
# Frontend dev (if not using IIS): npm run dev -- --host
# IIS already listens on :80 for all interfaces

# Open firewall (if not done)
New-NetFirewallRule -DisplayName 'Synapse HTTP' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow

# Find VM IP
ipconfig
```

Share with testers: `http://<vm-lan-ip>/`

See also `SHARE_WITH_QA.md` for Cloudflare tunnel fallback when Wi-Fi client isolation blocks LAN access.

---

### Appendix E — `iisnode` (not recommended)

Legacy approach where IIS hosts Node directly. Unmaintained and brittle with Express 5. Use **NSSM + ARR reverse proxy** instead ([§7](#7-phase-4--backend-windows-service-nssm), [§8](#8-phase-5--iis-site--frontend-publish)).

---

*Built by Nalashaa Healthcare Solutions · Synapse Integration Hub v2.4.1*
