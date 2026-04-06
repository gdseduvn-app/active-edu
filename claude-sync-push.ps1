# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE SYNC — PUSH (máy hiện tại → Google Drive)          ║
# ║  Chạy sau mỗi buổi làm việc để lưu memory + plans          ║
# ║  Usage: .\claude-sync-push.ps1                             ║
# ╚══════════════════════════════════════════════════════════════╝

$ErrorActionPreference = "Stop"

# ── Detect Google Drive path ──────────────────────────────────
function Find-GoogleDrive {
    $candidates = @(
        "$env:USERPROFILE\My Drive",
        "$env:USERPROFILE\Google Drive",
        "G:\My Drive",
        "H:\My Drive",
        "D:\My Drive",
        "$env:USERPROFILE\GoogleDrive",
        (Get-ItemProperty "HKCU:\Software\Google\DriveFS" -Name "PerAccountPreferences" -ErrorAction SilentlyContinue)
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    # Registry fallback for Google Drive for Desktop
    try {
        $reg = Get-ItemProperty "HKCU:\Software\Google\Drive" -Name "Path" -ErrorAction SilentlyContinue
        if ($reg.Path -and (Test-Path $reg.Path)) { return $reg.Path }
    } catch {}
    return $null
}

# ── Paths ─────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$SyncDir    = Join-Path $ScriptDir ".claude-sync"
$ClaudeDir  = Join-Path $env:USERPROFILE ".claude"
$Username   = $env:USERNAME

Write-Host ""
Write-Host "▶ Claude Sync — PUSH" -ForegroundColor Blue
Write-Host "  Từ : $ClaudeDir"
Write-Host "  Đến: $SyncDir"
Write-Host ""

# Tạo thư mục sync
New-Item -ItemType Directory -Force -Path "$SyncDir\memory" | Out-Null
New-Item -ItemType Directory -Force -Path "$SyncDir\plans"  | Out-Null

# ── 1. Sync memory files ──────────────────────────────────────
$projectKeys = @(
    "-Users-TriHue-Library-CloudStorage-GoogleDrive-trihue-life-gmail-com-My-Drive-ActiveEdu",
    "-Users-$Username-Library-CloudStorage-GoogleDrive-trihue-life-gmail-com-My-Drive-ActiveEdu"
)

# Windows project key (path dùng dấu gạch ngang thay dấu backslash)
$drivePath = $ScriptDir -replace '\\', '-' -replace '^-+', ''
$drivePath = $drivePath -replace ':', ''
$projectKeys += $drivePath

$memoryFound = $false
foreach ($key in $projectKeys) {
    $memorySrc = Join-Path $ClaudeDir "projects\$key\memory"
    if (Test-Path $memorySrc) {
        $files = Get-ChildItem $memorySrc -ErrorAction SilentlyContinue
        if ($files.Count -gt 0) {
            Write-Host "  Sync memory từ: $key" -ForegroundColor Gray
            robocopy "$memorySrc" "$SyncDir\memory" /MIR /NJH /NJS /NFL /NDL 2>$null
            Write-Host "✓ Memory synced ($($files.Count) files)" -ForegroundColor Green
            $memoryFound = $true
            break
        }
    }
}
if (-not $memoryFound) {
    Write-Host "⚠ Không tìm thấy memory files (bình thường nếu chưa có)" -ForegroundColor Yellow
}

# ── 2. Sync plans ─────────────────────────────────────────────
$plansDir = Join-Path $ClaudeDir "plans"
if (Test-Path $plansDir) {
    $planFiles = Get-ChildItem $plansDir -ErrorAction SilentlyContinue
    if ($planFiles.Count -gt 0) {
        robocopy "$plansDir" "$SyncDir\plans" /MIR /NJH /NJS /NFL /NDL 2>$null
        Write-Host "✓ Plans synced ($($planFiles.Count) files)" -ForegroundColor Green
    }
}

# ── 3. Sync settings ──────────────────────────────────────────
foreach ($f in @("settings.json", "keybindings.json")) {
    $src = Join-Path $ClaudeDir $f
    if (Test-Path $src) {
        Copy-Item $src "$SyncDir\$f" -Force
        Write-Host "✓ $f synced" -ForegroundColor Green
    }
}

# ── 4. Lưu thông tin máy ──────────────────────────────────────
@"
Machine : $env:COMPUTERNAME
User    : $env:USERNAME
OS      : Windows $(([System.Environment]::OSVersion).Version)
Date    : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
"@ | Set-Content "$SyncDir\last-push.txt" -Encoding UTF8

Write-Host ""
Write-Host "✅ Push hoàn thành!" -ForegroundColor Green
Write-Host "   Files đã lưu vào: $SyncDir"
Write-Host "   Google Drive sẽ tự đồng bộ lên cloud."
Write-Host ""
