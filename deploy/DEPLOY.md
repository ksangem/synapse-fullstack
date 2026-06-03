# Synapse CI/CD — Deploy to local VM

**CI/CD runs on the fork (you are owner):** [ranjanpradyot/synapse-fullstack](https://github.com/ranjanpradyot/synapse-fullstack)  
**Upstream (read-only for you):** [ksangem/synapse-fullstack](https://github.com/ksangem/synapse-fullstack)

```powershell
# One-time: point git at your fork
.\deploy\use-fork-remotes.ps1
```

## Dashboard (builds, logs, success/failure)

| View | URL |
|------|-----|
| **All pipeline runs** | https://github.com/ranjanpradyot/synapse-fullstack/actions |
| **CI/CD Dashboard** (summary table) | Actions → **CI/CD Dashboard** → Run workflow |
| **Production deployments** | https://github.com/ranjanpradyot/synapse-fullstack/deployments |
| **Frontend CI** | Actions → **Frontend CI** |
| **Backend CI** | Actions → **Backend CI** |
| **Frontend Deploy** | Actions → **Frontend Deploy** |
| **Backend Deploy** | Actions → **Backend Deploy** |

Each run has a **Summary** tab (pass/fail, links, deploy target). Failed steps show red logs with the exact error.

---

## How GitHub deploys to your VM

GitHub cloud runners **build and test** only. **Deploy** runs on a **self-hosted runner** installed on the same Windows VM as IIS/Node:

```
Push to main → Frontend CI / Backend CI (Ubuntu) → artifact
                    ↓ success
              Frontend Deploy / Backend Deploy (your VM runner)
                    ↓
              IIS dist folder + restart Node service
```

---

## One-time VM setup

### 1. App stack (if not done)

- Node 20+, PostgreSQL, Redis/Memurai, IIS + URL Rewrite + ARR  
- See [HOSTING_IIS_GUIDE.md](../HOSTING_IIS_GUIDE.md)

### 2. Clone and configure

```powershell
cd C:\inetpub\wwwroot
git clone https://github.com/ksangem/synapse-fullstack.git
cd synapse-fullstack
# DB: setup-database.sql, drizzle push, deploy\seed-default-org.sql
copy .env.example packages\backend\.env
# Edit packages\backend\.env (secrets stay on VM only)
```

### 3. Install GitHub Actions runner (Administrator)

```powershell
cd C:\inetpub\wwwroot\synapse-fullstack
.\deploy\setup-github-runner.ps1
```

Get a token from: **https://github.com/ranjanpradyot/synapse-fullstack/settings/actions/runners/new**

Runner must show labels: `self-hosted`, `Windows`, `synapse`  
(Register on the **fork**, not `ksangem/synapse-fullstack`.)

### 4. GitHub repo settings

**Settings → Environments → New environment:** `production`  
(Optional) Required reviewers for deploy approval.

**Settings → Secrets and variables → Actions → Variables** (optional overrides):

| Variable | Default |
|----------|---------|
| `DEPLOY_FRONTEND_PATH` | `C:\inetpub\wwwroot\synapse-fullstack\packages\frontend\dist` |
| `DEPLOY_BACKEND_PATH` | `C:\inetpub\wwwroot\synapse-fullstack\packages\backend` |
| `IIS_SITE_NAME` | `Synapse-Integration-Hub` |
| `BACKEND_SERVICE_NAME` | `SynapseBackend` |

### 5. Push workflows to GitHub

From your dev machine or VM:

```powershell
cd C:\inetpub\wwwroot\synapse-fullstack
git add .github deploy docs
git commit -m "Add CI/CD pipelines for frontend and backend"
git push origin main
```

---

## Daily use

| Action | How |
|--------|-----|
| **Run tests on PR** | Automatic — Frontend CI + Backend CI |
| **Deploy UI only** | Actions → **Frontend Deploy** → Run workflow |
| **Deploy API only** | Actions → **Backend Deploy** → Run workflow |
| **Status overview** | Actions → **CI/CD Dashboard** → Run workflow |
| **After merge to main** | CI runs; Deploy runs automatically if runner is online |

### Manual deploy (no runner)

1. Download artifact from a green **Frontend CI** / **Backend CI** run.  
2. On the VM:

```powershell
cd C:\inetpub\wwwroot\synapse-fullstack
.\deploy\deploy-frontend.ps1
.\deploy\deploy-backend.ps1
```

---

## Pipelines

| Workflow | Runs on | Purpose |
|----------|---------|---------|
| `frontend-ci.yml` | GitHub Ubuntu | Lint, Vite build, upload `synapse-frontend-dist` |
| `backend-ci.yml` | GitHub Ubuntu | Tests, `tsc` build, upload `synapse-backend-release` |
| `frontend-deploy.yml` | VM runner | Copy build to IIS + `web.config` |
| `backend-deploy.yml` | VM runner | Update `dist` + `node_modules`, restart service, health check |
| `ci-dashboard.yml` | GitHub Ubuntu | Markdown table of last run per pipeline |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Deploy job queued forever | Install/start self-hosted runner; check labels `synapse` |
| 500.19 on site | Install URL Rewrite + ARR — `deploy\install-iis-modules.ps1` |
| API 404 from browser | Ensure `web.config` proxies `/api` to port 4000 |
| Credentials insert fails | Run `deploy\seed-default-org.sql` |
| Deploy cannot overwrite `.env` | `.env` is preserved by `deploy-backend.ps1` |
