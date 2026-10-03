@echo off
REM Wrapper for Task Scheduler: sets the working directory, then runs one check.
REM %~dp0 is this file's folder, so the project can live anywhere.
cd /d "%~dp0.."
node scripts\run-once.js --live
