@echo off
REM Wrapper for Task Scheduler / Startup: keeps the local image service running.
REM %~dp0 is this file's folder, so the project can live anywhere.
cd /d "%~dp0.."
node local-image\server.js
