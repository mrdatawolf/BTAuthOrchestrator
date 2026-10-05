@echo off
rem Windows launcher: runs start.ps1 (pre-start checks, then the service).
setlocal
rem Rebuild Windows PowerShell module paths instead of inheriting PowerShell 7 paths.
rem setlocal keeps this change confined to the launcher and its child process.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
