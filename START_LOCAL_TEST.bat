@echo off
cd /d "%~dp0"
if not exist config.js (
  echo ERROR: Copy config.example.js as config.js and add your Supabase details.
  pause
  exit /b 1
)
start "" http://127.0.0.1:8080
py -m http.server 8080
pause
