@echo off
rem Runs CLI Controller with a visible console (logs shown here). Ctrl+C to quit.
cd /d "%~dp0"
node server.js --keep-alive %*
