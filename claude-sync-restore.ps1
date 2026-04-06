# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE SYNC — RESTORE (Google Drive → máy Windows)        ║
# ║  Chạy 1 lần sau khi cài Claude Code trên máy mới           ║
# ║  Usage: .\claude-sync-restore.ps1                          ║
# ╚══════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "Continue"

# ── Paths ─────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SyncDir   = Join-Path $ScriptDir ".claude-sync"
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"

# Tự build project key từ path thực tế của script
# Windows: C:\Users\UserName\My Drive\ActiveEdu → chuyển thành key dạng -C-Users-UserName-...
$rawKey = $ScriptDir -replace ':\\', '-' -replace '\\', '-' -replace ' ', '-' -replace '--+', '-'
$ProjectKey = $rawKey.TrimStart('-')

Write-Host ""
Write-Host "▶ Claude Sync — RESTORE" -ForegroundColor Blue
Write-Host "  Từ : $SyncDir"
Write-Host "  Đến: $ClaudeDir"
Write-Host "  Key: $ProjectKey"
Write-Host ""

# ── Kiểm tra .claude-sync tồn tại ────────────────────────────
if (-not (Test-Path $SyncDir)) {
    Write-Host "✗ Không tìm thấy .claude-sync trong thư mục Drive." -ForegroundColor Red
    Write-Host "  Hãy chắc chắn Google Drive đã sync xong."
    Write-Host "  Hoặc chạy claude-sync-push.ps1 trên máy Mac trước."
    exit 1
}

# ── 1. Restore memory ─────────────────────────────────────────
$memoryDest = Join-Path $ClaudeDir "projects\$ProjectKey\memory"
New-Item -ItemType Directory -Force -Path $memoryDest | Out-Null
New-Item -ItemType Directory -Force -Path "$ClaudeDir\plans" | Out-Null

$memorySrc = Join-Path $SyncDir "memory"
if (Test-Path $memorySrc) {
    $files = Get-ChildItem $memorySrc -ErrorAction SilentlyContinue
    if ($files.Count -gt 0) {
        robocopy "$memorySrc" "$memoryDest" /MIR /NJH /NJS /NFL /NDL 2>$null
        Write-Host "✓ Memory restored ($($files.Count) files)" -ForegroundColor Green
    } else {
        Write-Host "⚠ Không có memory files để restore" -ForegroundColor Yellow
    }
} else {
    Write-Host "⚠ Thư mục memory chưa có" -ForegroundColor Yellow
}

# ── 2. Restore plans ──────────────────────────────────────────
$plansSrc = Join-Path $SyncDir "plans"
if (Test-Path $plansSrc) {
    $files = Get-ChildItem $plansSrc -ErrorAction SilentlyContinue
    if ($files.Count -gt 0) {
        robocopy "$plansSrc" "$ClaudeDir\plans" /MIR /NJH /NJS /NFL /NDL 2>$null
        Write-Host "✓ Plans restored ($($files.Count) files)" -ForegroundColor Green
    }
}

# ── 3. Restore settings ───────────────────────────────────────
foreach ($f in @("settings.json", "keybindings.json")) {
    $src  = Join-Path $SyncDir $f
    $dest = Join-Path $ClaudeDir $f
    if ((Test-Path $src) -and (-not (Test-Path $dest))) {
        Copy-Item $src $dest -Force
        Write-Host "✓ $f restored" -ForegroundColor Green
    }
}

# ── 4. Hiện thông tin lần push gần nhất ──────────────────────
$lastPush = Join-Path $SyncDir "last-push.txt"
if (Test-Path $lastPush) {
    Write-Host ""
    Write-Host "ℹ Lần sync gần nhất:" -ForegroundColor Blue
    Get-Content $lastPush | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "✅ Restore hoàn thành!" -ForegroundColor Green
Write-Host ""
Write-Host "  Bước tiếp theo:" -ForegroundColor White
Write-Host "  cd `"$ScriptDir`"" -ForegroundColor Cyan
Write-Host "  claude" -ForegroundColor Cyan
Write-Host ""
