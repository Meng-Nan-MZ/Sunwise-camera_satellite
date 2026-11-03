@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" %*
set "WEB_EXIT=%ERRORLEVEL%"
if not "%WEB_EXIT%"=="0" echo Web launcher failed. Read the error above.
pause
exit /b %WEB_EXIT%
