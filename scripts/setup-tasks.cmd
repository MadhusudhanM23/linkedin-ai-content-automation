@echo off
REM One-shot setup for a new machine (or after moving the project folder).
REM
REM   scripts\setup-tasks.cmd            register the per-minute task + startup entry
REM   scripts\setup-tasks.cmd remove     unregister both
REM
REM Needs no administrator rights.

setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%"
set "ROOT=%CD%"
popd

if /I "%~1"=="remove" goto :remove

echo Project: %ROOT%
where node >nul 2>&1 || (echo ERROR: node is not on PATH. Install Node.js 18+ first. & exit /b 1)

schtasks /Create /TN "LinkedInAutomation-Run" /TR "%ROOT%\scripts\run-task.vbs" /SC MINUTE /MO 1 /F
if errorlevel 1 (echo ERROR: could not register the scheduled task. & exit /b 1)

REM Start the image service at logon via the Startup folder - no admin needed.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\LinkedInAutomation-Image.vbs" echo Set sh = CreateObject("WScript.Shell")
>> "%STARTUP%\LinkedInAutomation-Image.vbs" echo sh.Run """%ROOT%\scripts\image-task.cmd""", 0, False

echo.
echo Done.
echo   per-minute check : LinkedInAutomation-Run
echo   image service    : starts at logon
echo   log              : %ROOT%\run.log
echo.
echo Starting the image service now...
start "" wscript.exe "%STARTUP%\LinkedInAutomation-Image.vbs"
exit /b 0

:remove
schtasks /Delete /TN "LinkedInAutomation-Run" /F
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LinkedInAutomation-Image.vbs" 2>nul
echo Removed. Nothing will post from this machine any more.
exit /b 0
