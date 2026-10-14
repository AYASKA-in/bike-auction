# Windows helper for scripts/deploy.mjs: asks for the Turnstile keys (secret typed hidden), then deploys.
# Run by double-clicking deploy-windows.cmd in the repo root, or: powershell -ExecutionPolicy Bypass -File scripts\deploy-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host "`n=== Bike Auction: deploy to Cloudflare (free plan, no R2) ===`n"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 22+ is required: https://nodejs.org (LTS), then run this again." -ForegroundColor Red
  Read-Host "Press Enter to close"; exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "Enabling pnpm via corepack..."
  corepack enable
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm install -g pnpm@10 }
}
pnpm install
if ($LASTEXITCODE -ne 0) { Read-Host "pnpm install failed. Press Enter to close"; exit 1 }

$site = Read-Host "Turnstile SITE key (starts with 0x)"
$secretSecure = Read-Host "Turnstile SECRET key (hidden)" -AsSecureString
$secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure))

node scripts/deploy.mjs --turnstile-site-key $site --turnstile-secret-key $secret
$code = $LASTEXITCODE
$secret = $null
if ($code -eq 0) { Write-Host "`nDeploy finished. The URL is printed above." -ForegroundColor Green }
else { Write-Host "`nDeploy failed (exit $code). Scroll up for the error." -ForegroundColor Red }
Read-Host "Press Enter to close"
