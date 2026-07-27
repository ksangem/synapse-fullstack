# Share Synapse with the QA team (in-office) — Runbook

> **Goal:** Make the locally-running Synapse app reachable by QA testers from their own machines.
> **Host machine LAN IP:** `192.168.6.98` (Wi-Fi adapter)
> **Frontend:** Vite dev server, port `5173`  ·  **Backend:** Express, port `4000`
> **Infra:** Postgres (docker, host port `5555`) + Redis (docker, `6379`)
>
> Follow Path A first. If QA still can't connect (corporate Wi-Fi often blocks device-to-device), switch to Path B.

---

## Prerequisite (already done — verify only)

`packages/frontend/src/services/api.js` line ~11 must read:

```js
const API = import.meta.env.VITE_API_URL || `http://${window.location.hostname}:4000`;
```

If it still says `const API = 'http://localhost:4000';`, replace it with the line above. This makes QA's browser call the backend on the **same host** they loaded the page from, with no per-machine config.

---

## Path A — LAN share (same office network)

### A1. Open the Windows firewall (run PowerShell **as Administrator**, once)

```powershell
New-NetFirewallRule -DisplayName "Synapse Frontend" -Direction Inbound -LocalPort 5173 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "Synapse Backend"  -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
```

### A2. Keep the laptop awake during testing

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
```

### A3. Start infra + both servers (3 terminals)

```powershell
# Terminal 1 — Postgres + Redis
docker compose up -d

# Terminal 2 — backend (binds 0.0.0.0:4000 automatically)
cd packages\backend
npm run dev

# Terminal 3 — frontend, bound to all interfaces (the --host is REQUIRED)
cd packages\frontend
npm run dev -- --host
```

### A4. Confirm Vite is reachable on the network

Terminal 3 **must** print a line like:

```
  ➜  Network: http://192.168.6.98:5173/
```

- If you see the `Network:` line → good, that URL is what QA uses.
- If you only see `Local: http://localhost:5173/` and **no** `Network:` line → the `--host` flag didn't take. Stop and fix before continuing.

### A5. Share with QA

Send testers: **`http://192.168.6.98:5173`**

---

## Diagnosis ladder (run if QA gets "can't reach this page")

Run these in order; each one tells you where the block is.

### D1. Is anything actually listening?

```powershell
Get-NetTCPConnection -LocalPort 5173,4000 -State Listen | Format-Table LocalAddress,LocalPort,OwningProcess
```

- Expect `LocalAddress = 0.0.0.0` (or `::`) for both ports.
- If `LocalAddress = 127.0.0.1` → server bound to localhost only. For frontend, ensure `--host`. For backend, it should already bind `0.0.0.0`.
- If **empty** → the servers are not running. Start them (A3).

### D2. Self-test from the host using the IP (not localhost)

Open in the host's own browser: `http://192.168.6.98:5173`

- **Works** → binding + firewall are fine. The block is the network → go to D3.
- **Fails** → local issue. Re-run A1 **as Administrator**; re-check the `--host` flag (A4).

### D3. Have a QA tester ping the host

On the QA machine:

```powershell
ping 192.168.6.98
```

- **Ping succeeds, browser still fails** → port-level firewall block. Re-run A1 as Administrator; confirm rules exist:
  `Get-NetFirewallRule -DisplayName "Synapse *" | Format-Table DisplayName,Enabled,Direction,Action`
- **Ping fails** → **Wi-Fi client isolation** or QA is on a different VLAN/subnet. This cannot be fixed from the laptop. Use **Path B**.

### D4. Confirm same subnet (optional)

Compare host `192.168.6.98` with QA's `ipconfig` IPv4. If QA is on a different range (e.g. `10.x` or `192.168.7.x`), they're on a separate network segment → use **Path B**.

---

## Path B — Cloudflare Tunnel (works regardless of Wi-Fi isolation)

Use this when D3 ping fails. Tunnels route **outbound** through the host's internet, so client isolation and VLAN splits don't matter. QA gets a public HTTPS URL from any network.

### B1. Install cloudflared (once)

```powershell
winget install --id Cloudflare.cloudflared
```

### B2. Start TWO tunnels (frontend + backend)

Keep the dev servers (A3) running, then in two more terminals:

```powershell
# Terminal 4 — backend tunnel
cloudflared tunnel --url http://localhost:4000
# Note the printed URL, e.g. https://api-xxxx.trycloudflare.com
```

```powershell
# Terminal 5 — frontend tunnel
cloudflared tunnel --url http://localhost:5173
# Note the printed URL, e.g. https://app-yyyy.trycloudflare.com
```

### B3. Point the frontend at the backend tunnel

The `window.location.hostname` fallback won't work across two different tunnel hostnames, so set `VITE_API_URL` explicitly.

Create `packages/frontend/.env.local`:

```env
VITE_API_URL=https://api-xxxx.trycloudflare.com
```

(Use the **backend** tunnel URL from Terminal 4.)

Then **restart the frontend dev server** (Vite reads env at startup):

```powershell
# in Terminal 3: Ctrl+C, then
npm run dev -- --host
```

Also restart the **frontend tunnel** (Terminal 5) if its URL changed.

### B4. Share with QA

Send testers the **frontend** tunnel URL from Terminal 5: `https://app-yyyy.trycloudflare.com`

---

## Notes & caveats

- **No authentication exists yet** in the app. Anyone with the URL has full access. Acceptable for internal QA over LAN or a short-lived tunnel; do **not** leave a tunnel running unattended or publish it widely.
- **Laptop must stay on and awake** for either path. For an always-on QA environment, host the stack on a dedicated in-office machine or small VM with `docker compose` (ask to expand `docker-compose.yml` with `frontend` + `backend` services).
- **Free Cloudflare quick tunnels get a new random URL each restart.** For a stable URL, set up a named tunnel with a Cloudflare account (extra one-time setup).
- **Postgres note:** docker maps Postgres to host port **5555** (not 5432). If the backend can't connect to the DB, ensure its `DATABASE_URL` points to `localhost:5555`, e.g.
  `DATABASE_URL=postgresql://synapse:synapse@localhost:5555/synapse_db`
- **Playwright / Flatiron-MFA** features need real browser binaries — they run fine on the host machine (both paths), unlike most serverless hosting.

---

## Quick reference

| What | Value |
|------|-------|
| Host LAN IP (Wi-Fi) | `192.168.6.98` |
| Frontend port | `5173` |
| Backend port | `4000` |
| Postgres (docker → host) | `5432 → 5555` |
| Redis | `6379` |
| LAN URL for QA | `http://192.168.6.98:5173` |
| Start frontend (networked) | `npm run dev -- --host` |
| Backend tunnel | `cloudflared tunnel --url http://localhost:4000` |
| Frontend tunnel | `cloudflared tunnel --url http://localhost:5173` |
