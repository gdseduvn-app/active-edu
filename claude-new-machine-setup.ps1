# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE CODE — SETUP MÁY MỚI WINDOWS (chạy 1 lần)         ║
# ║  Tự động cài Node.js + Claude Code + restore config        ║
# ║  Usage: .\claude-new-machine-setup.ps1                     ║
# ║                                                            ║
# ║  AN TOÀN ĐỂ CHẠY LẠI NHIỀU LẦN nếu bị gián đoạn          ║
# ╚══════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param($n, $msg) Write-Host "" ; Write-Host "[$n/4] $msg" -ForegroundColor Blue }
function Write-Ok   { param($msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   AURA LMS — Claude Code Setup       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Script này an toàn để chạy lại nếu bị gián đoạn." -ForegroundColor Gray
Write-Host ""

# ── BƯỚC 1: Kiểm tra / cài Node.js ───────────────────────────
Write-Step 1 "Kiểm tra Node.js..."

$nodeOk = $false
try {
    $nodeVer = node --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nodeVer) {
        Write-Ok "Node.js $nodeVer"
        $nodeOk = $true
    }
} catch {}

if (-not $nodeOk) {
    Write-Warn "Node.js chưa cài. Đang cài qua winget..."

    # Thử winget (Windows 10 1709+ đã có sẵn)
    $wingetOk = $false
    try {
        winget --version 2>$null | Out-Null
        $wingetOk = ($LASTEXITCODE -eq 0)
    } catch {}

    if ($wingetOk) {
        Write-Host "  Đang chạy: winget install OpenJS.NodeJS.LTS ..." -ForegroundColor Gray
        winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        # Refresh PATH để node có thể dùng ngay
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH", "User")
        try {
            $nodeVer = node --version 2>$null
            if ($nodeVer) { Write-Ok "Node.js $nodeVer đã cài" }
        } catch {
            Write-Warn "Node.js đã cài nhưng cần mở lại terminal để dùng được."
            Write-Warn "Hãy đóng PowerShell này, mở lại, rồi chạy lại script."
            exit 0
        }
    } else {
        Write-Fail "Không tìm thấy winget."
        Write-Host ""
        Write-Host "  Cài Node.js thủ công tại: https://nodejs.org/en/download" -ForegroundColor Cyan
        Write-Host "  Sau khi cài xong, chạy lại script này." -ForegroundColor Cyan
        exit 1
    }
}

# ── BƯỚC 2: Kiểm tra npm ──────────────────────────────────────
Write-Step 2 "Kiểm tra npm..."
try {
    $npmVer = npm --version 2>$null
    if ($npmVer) { Write-Ok "npm $npmVer" }
} catch {
    Write-Fail "npm không tìm thấy — thử mở lại terminal sau khi cài Node.js."
    exit 1
}

# ── BƯỚC 3: Kiểm tra / cài Claude Code ───────────────────────
Write-Step 3 "Kiểm tra Claude Code..."

$claudeOk = $false
try {
    $claudeVer = claude --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $claudeVer) {
        Write-Ok "Claude Code $claudeVer"
        $claudeOk = $true
    }
} catch {}

if (-not $claudeOk) {
    Write-Warn "Claude Code chưa cài. Đang cài qua npm..."
    npm install -g @anthropic-ai/claude-code
    if ($LASTEXITCODE -eq 0) {
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH", "User")
        try {
            $claudeVer = claude --version 2>$null
            Write-Ok "Claude Code $claudeVer đã cài"
        } catch {
            Write-Ok "Claude Code đã cài (mở lại terminal nếu lệnh 'claude' chưa nhận ra)"
        }
    } else {
        Write-Fail "npm install thất bại. Thử chạy lại với quyền Admin."
        exit 1
    }
}

# ── BƯỚC 4: Restore config từ Google Drive ───────────────────
Write-Step 4 "Restore Claude config từ Google Drive..."

$restoreScript = Join-Path $ScriptDir "claude-sync-restore.ps1"
if (Test-Path $restoreScript) {
    & $restoreScript
} else {
    Write-Warn "Không tìm thấy claude-sync-restore.ps1 — bỏ qua bước restore."
    Write-Host "  Chạy thủ công: .\claude-sync-restore.ps1" -ForegroundColor Cyan
}

# ── HOÀN THÀNH ────────────────────────────────────────────────
Write-Host ""
Write-Host "✅ Setup hoàn thành!" -ForegroundColor Green
Write-Host ""
Write-Host "  Để bắt đầu làm việc:" -ForegroundColor White
Write-Host "  cd `"$ScriptDir`"" -ForegroundColor Cyan
Write-Host "  claude" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Sau mỗi buổi làm việc, lưu config:" -ForegroundColor White
Write-Host "  .\claude-sync-push.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Nếu script bị gián đoạn giữa chừng (cúp điện, v.v.):" -ForegroundColor Gray
Write-Host "  Chạy lại script này — an toàn để chạy nhiều lần." -ForegroundColor Gray
Write-Host ""
