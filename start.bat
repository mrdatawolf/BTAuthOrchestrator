@echo off
rem Windows launcher: runs start.ps1 (pre-start checks, then the service).
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
