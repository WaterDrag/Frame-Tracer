@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8080
  node server.js
) else (
  start "" "%~dp0index.html"
)
