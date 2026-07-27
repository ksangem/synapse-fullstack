@echo off
REM Double-click this file to run the SFTP setup (it launches the .ps1 for you).
REM Keep it in the SAME folder as Setup-SynapseFileShare.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-SynapseFileShare.ps1"
