# Synapse-Integration-Hub — fix https://synapse.nalashaa.com 404 (run as Administrator)

**Symptom:** HTTPS returns 404 (HTTPAPI); HTTP shows default IIS page — hostname not bound to Synapse site.

**Physical path:** `C:\inetpub\wwwroot\synapse-fullstack\packages\frontend\dist`

# Synapse-Integration-Hub — quick IIS change (run as Administrator)

**Repo path:** `C:\inetpub\wwwroot\synapse-fullstack`  
**IIS physical path:** `C:\inetpub\wwwroot\synapse-fullstack\packages\frontend\dist`

## 1. One command (PowerShell as Admin)

```powershell
powershell -ExecutionPolicy Bypass -File C:\inetpub\wwwroot\synapse-fullstack\deploy\setup-iis-demo.ps1
```

## 2. Or IIS Manager (inetmgr)

1. Sites → **Synapse-Integration-Hub**
2. **Basic Settings** → Physical path:
   `C:\inetpub\wwwroot\synapse-fullstack\packages\frontend\dist`
3. **Bindings** → remove any **:4000** binding (Node needs port 4000)
4. Ensure **http** on port **80** (or your demo hostname)
5. Server node → **Application Request Routing** → **Server Proxy Settings** → **Enable proxy** → Apply

## 3. Backend (keep running for demo)

```bat
C:\inetpub\wwwroot\synapse-fullstack\deploy\start-backend.cmd
```

Or install as service (Admin):

```powershell
$nssm = 'C:\ProgramData\chocolatey\bin\nssm.exe'
$repo = 'C:\inetpub\wwwroot\synapse-fullstack'
& $nssm install SynapseBackend "$env:ComSpec" '/c C:\inetpub\wwwroot\synapse-fullstack\deploy\start-backend.cmd'
& $nssm set SynapseBackend Start SERVICE_AUTO_START
& $nssm start SynapseBackend
```

## 4. Verify

| URL | Expected |
|-----|----------|
| http://127.0.0.1:4000/health | `{"status":"ok"}` |
| http://localhost/health | same (via IIS proxy) |
| http://localhost/ | Synapse React UI |

If **Default Web Site** still answers on `localhost`, open the site by **host name** binding for Synapse-Integration-Hub, or stop Default Web Site on port 80.
