@echo off
rem Double-click to deploy to Cloudflare (Windows). See docs/DEPLOYMENT.md.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-windows.ps1"
