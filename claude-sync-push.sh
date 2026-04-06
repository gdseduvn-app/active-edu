#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE SYNC — PUSH (máy hiện tại → Google Drive)          ║
# ║  Chạy sau mỗi buổi làm việc để lưu memory + plans          ║
# ║  Usage: bash claude-sync-push.sh                           ║
# ╚══════════════════════════════════════════════════════════════╝

set -e

# ── Paths ─────────────────────────────────────────────────────
DRIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_DIR="$DRIVE_DIR/.claude-sync"
CLAUDE_DIR="$HOME/.claude"

# Project key trong ~/.claude/projects/ (dùng path encode của Drive folder)
PROJECT_KEYS=(
  "-Users-TriHue-Library-CloudStorage-GoogleDrive-trihue-life-gmail-com-My-Drive-ActiveEdu"
  "-Users-$(whoami)-Library-CloudStorage-GoogleDrive-trihue-life-gmail-com-My-Drive-ActiveEdu"
)

# ── Colors ────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

echo -e "${BLUE}▶ Claude Sync — PUSH${NC}"
echo -e "  Từ: $CLAUDE_DIR"
echo -e "  Đến: $SYNC_DIR"
echo ""

mkdir -p "$SYNC_DIR/memory" "$SYNC_DIR/plans"

# ── 1. Sync memory files ──────────────────────────────────────
MEMORY_FOUND=0
for KEY in "${PROJECT_KEYS[@]}"; do
  MEMORY_SRC="$CLAUDE_DIR/projects/$KEY/memory"
  if [ -d "$MEMORY_SRC" ] && [ "$(ls -A "$MEMORY_SRC" 2>/dev/null)" ]; then
    rsync -av --delete "$MEMORY_SRC/" "$SYNC_DIR/memory/" 2>/dev/null
    echo -e "${GREEN}✓ Memory synced từ: $KEY${NC}"
    MEMORY_FOUND=1
    break
  fi
done

if [ $MEMORY_FOUND -eq 0 ]; then
  echo -e "${YELLOW}⚠ Không tìm thấy memory files (bình thường nếu chưa có)${NC}"
fi

# ── 2. Sync plans ─────────────────────────────────────────────
if [ -d "$CLAUDE_DIR/plans" ] && [ "$(ls -A "$CLAUDE_DIR/plans" 2>/dev/null)" ]; then
  rsync -av "$CLAUDE_DIR/plans/" "$SYNC_DIR/plans/" 2>/dev/null
  echo -e "${GREEN}✓ Plans synced${NC}"
fi

# ── 3. Sync settings (nếu có) ─────────────────────────────────
if [ -f "$CLAUDE_DIR/settings.json" ]; then
  cp "$CLAUDE_DIR/settings.json" "$SYNC_DIR/settings.json"
  echo -e "${GREEN}✓ settings.json synced${NC}"
fi

if [ -f "$CLAUDE_DIR/keybindings.json" ]; then
  cp "$CLAUDE_DIR/keybindings.json" "$SYNC_DIR/keybindings.json"
  echo -e "${GREEN}✓ keybindings.json synced${NC}"
fi

# ── 4. Lưu thông tin máy ──────────────────────────────────────
cat > "$SYNC_DIR/last-push.txt" << EOF
Machine: $(hostname)
User: $(whoami)
Date: $(date '+%Y-%m-%d %H:%M:%S')
macOS: $(sw_vers -productVersion 2>/dev/null || echo "unknown")
EOF

echo ""
echo -e "${GREEN}✅ Push hoàn thành!${NC}"
echo -e "   Files đã lưu vào: $SYNC_DIR"
echo -e "   Google Drive sẽ tự đồng bộ lên cloud."
