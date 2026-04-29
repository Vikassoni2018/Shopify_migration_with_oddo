@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process node -ArgumentList 'shopify_sync_server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 2 >nul
start "" "http://127.0.0.1:3456"
