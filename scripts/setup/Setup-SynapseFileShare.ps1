#Requires -Version 5.1
<#
  Setup-SynapseFileShare.ps1
  ---------------------------------------------------------------------------
  Share this file with your friend. They run it once (right-click ->
  "Run with PowerShell", or double-click the .cmd launcher next to it).

  It turns their Windows PC into an SFTP file server so Synapse's "File Share"
  connector can pull CSV / Excel files from it, and then prints the exact
  connection details to type into the connector.
  ---------------------------------------------------------------------------
#>

# --- 1. Elevate to Administrator (installing the SFTP server needs admin) ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting Administrator rights (please approve the prompt)..." -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -Verb RunAs `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    exit
}

$Host.UI.RawUI.WindowTitle = 'Synapse File Share - SFTP Setup'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    [!] $m"  -ForegroundColor Yellow }

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Synapse File Share  -  one-click SFTP setup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# --- 2. Install OpenSSH Server (the SFTP service) ---
Step "Checking the SFTP (OpenSSH) server..."
try {
    $cap = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'OpenSSH.Server*' } | Select-Object -First 1
    if ($cap -and $cap.State -ne 'Installed') {
        Warn "Installing OpenSSH Server (needs internet, ~1 minute)..."
        Add-WindowsCapability -Online -Name $cap.Name | Out-Null
        Ok "OpenSSH Server installed."
    } else {
        Ok "OpenSSH Server already installed."
    }
} catch {
    Warn "Could not auto-install: $($_.Exception.Message)"
    Warn "Install manually: Settings > Apps > Optional Features > Add a feature > OpenSSH Server."
}

# --- 3. Start the service and set it to run automatically ---
Step "Starting the SFTP service..."
try {
    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    Start-Service -Name sshd -ErrorAction Stop
    Ok "SFTP service (sshd) is running and will auto-start on boot."
} catch {
    Warn "Could not start sshd: $($_.Exception.Message)"
}

# --- 4. Open the firewall for SFTP (port 22) ---
Step "Opening the firewall for port 22..."
try {
    if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' `
            -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
        Ok "Firewall now allows port 22."
    } else {
        Ok "Firewall already allows port 22."
    }
} catch {
    Warn "Could not set the firewall rule: $($_.Exception.Message)"
}

# --- 5. Create the shared folder for the files ---
Step "Preparing the shared folder..."
$share = Join-Path $env:USERPROFILE 'SynapseShare'
if (-not (Test-Path $share)) { New-Item -ItemType Directory -Path $share | Out-Null }
Ok "Folder ready: $share"
Write-Host "    >> Put the CSV / Excel files you want to send into that folder. <<" -ForegroundColor Gray

# --- 6. Gather the connection details ---
$user = $env:USERNAME
$remotePath = '/' + ($share -replace '\\','/')
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Sort-Object InterfaceMetric |
    Select-Object -ExpandProperty IPAddress)
if (-not $ips) { $ips = @('(could not detect - run "ipconfig" and read IPv4 Address)') }

# --- 7. Show everything the Synapse operator needs ---
Write-Host "`n============================================================" -ForegroundColor Green
Write-Host "   SETUP COMPLETE - send these details to your Synapse operator" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host ("   SFTP Host (IP) : " + ($ips -join '   OR   ')) -ForegroundColor White
Write-Host  "   Port           : 22" -ForegroundColor White
Write-Host ("   Username       : " + $user) -ForegroundColor White
Write-Host  "   Password       : your Windows sign-in password" -ForegroundColor White
Write-Host ("   Remote Path    : " + $remotePath) -ForegroundColor White
Write-Host  "   File Types     : CSV, XLSX" -ForegroundColor White
Write-Host ""
Write-Host "   In Synapse:  File Share connector  ->  Provider = SFTP  ->  paste the above." -ForegroundColor Gray
Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "   Notes:" -ForegroundColor Gray
Write-Host "    - Keep this PC ON and awake while a transfer runs." -ForegroundColor Gray
Write-Host "    - Same Wi-Fi / office network?  The IP above works as-is." -ForegroundColor Gray
Write-Host "    - Different networks (over the internet)?  A 192.168.x /" -ForegroundColor Gray
Write-Host "      10.x address will NOT reach you. Easiest fix: install" -ForegroundColor Gray
Write-Host "      Tailscale on BOTH PCs and use the Tailscale IP instead." -ForegroundColor Gray
Write-Host ""

# Open the shared folder so they can drop files in.
try { Start-Process explorer.exe $share } catch { }

Write-Host ""
Read-Host "Press Enter to close this window"
