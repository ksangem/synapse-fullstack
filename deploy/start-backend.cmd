@echo off
set REPO_ROOT=C:\inetpub\wwwroot\synapse-fullstack
cd /d "%REPO_ROOT%\packages\backend"
"C:\Program Files\nodejs\node.exe" dist\index.js
