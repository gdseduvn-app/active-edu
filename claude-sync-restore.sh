#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE SYNC — RESTORE (Google Drive → máy mới)            ║
# ║  Chạy 1 LẦN trên máy mới để khôi phục memory + plans      ║
# ║  Usage: bash claude-sync-restore.sh                        ║
# ╚══════════════════════════════════════════════════════════════╝

set -e

# ── Paths ─────────────────────────────────────────────────────
DRIVE_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_DIR="$DRIVE_DIR/.claude-sync"
CLAUDE_DIR="$HOME/.claude"
USERNAME="$(whoami)"

# Tự detect project key cho máy này
DRIVE_ESCAPED=$(echo "$DRIVE_DIR" | sed 's|/|-|g' | sed 's|^-||')
PROJECT_KEY="$DRIVE_ESCAPED"

# ── Colors ────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${BLUE}▶ Claude Sync — RESTORE${NC}"
echo -e "  Từ: $SYNC_DIR"
echo -e "  Đến: $CLAUDE_DIR"
echo -e "  Project key: $PROJECT_KEY"
echo ""

# ── Kiểm tra Google Drive đã sync ────────────────────────────
if [ ! -d "$SYNC_DIR" ]; then
  echo -e "${RED}✗ Không tìm thấy $SYNC_DIR${NC}"
  echo -e "  Đảm bảo Google Drive đã đồng bộ xong trước khi chạy script này."
  exit 1
fi

# ── 1. Tạo cấu trúc ~/.claude/ ────────────────────────────────
MEMORY_DEST="$CLAUDE_DIR/projects/$PROJECT_KEY/memory"
mkdir -p "$MEMORY_DEST"
mkdir -p "$CLAUDE_DIR/plans"

echo -e "  Thư mục memory: $MEMORY_DEST"
echo ""

# ── 2. Restore memory files ───────────────────────────────────
if [ -d "$SYNC_DIR/memory" ] && [ "$(ls -A "$SYNC_DIR/memory" 2>/dev/null)" ]; then
  rsync -av "$SYNC_DIR/memory/" "$MEMORY_DEST/" 2>/dev/null
  echo -e "${GREEN}✓ Memory restored ($(ls "$MEMORY_DEST" | wc -l | tr -d ' ') files)${NC}"
else
  echo -e "${YELLOW}⚠ Không có memory files để restore${NC}"
fi

# ── 3. Restore plans ─────────────────────────────────────────
if [ -d "$SYNC_DIR/plans" ] && [ "$(ls -A "$SYNC_DIR/plans" 2>/dev/null)" ]; then
  rsync -av "$SYNC_DIR/plans/" "$CLAUDE_DIR/plans/" 2>/dev/null
  echo -e "${GREEN}✓ Plans restored ($(ls "$CLAUDE_DIR/plans" | wc -l | tr -d ' ') files)${NC}"
fi

# ── 4. Restore settings (nếu có) ─────────────────────────────
if [ -f "$SYNC_DIR/settings.json" ] && [ ! -f "$CLAUDE_DIR/settings.json" ]; then
  cp "$SYNC_DIR/settings.json" "$CLAUDE_DIR/settings.json"
  echo -e "${GREEN}✓ settings.json restored${NC}"
fi

if [ -f "$SYNC_DIR/keybindings.json" ] && [ ! -f "$CLAUDE_DIR/keybindings.json" ]; then
  cp "$SYNC_DIR/keybindings.json" "$CLAUDE_DIR/keybindings.json"
  echo -e "${GREEN}✓ keybindings.json restored${NC}"
fi

# ── 5. Kiểm tra Claude Code đã cài chưa ──────────────────────
echo ""
if ! command -v claude &>/dev/null; then
  echo -e "${YELLOW}⚠ Claude Code chưa được cài trên máy này.${NC}"
  echo -e "  Cài đặt bằng lệnh:"
  echo -e "  ${BLUE}npm install -g @anthropic-ai/claude-code${NC}"
  echo ""
  echo -e "  Hoặc tải Claude Desktop App tại: https://claude.ai/download"
else
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
  echo -e "${GREEN}✓ Claude Code đã cài: $CLAUDE_VER${NC}"
fi

# ── 6. Hiển thị thông tin lần push gần nhất ──────────────────
if [ -f "$SYNC_DIR/last-push.txt" ]; then
  echo ""
  echo -e "${BLUE}ℹ Lần sync gần nhất:${NC}"
  cat "$SYNC_DIR/last-push.txt" | sed 's/^/  /'
fi

echo ""
echo -e "${GREEN}✅ Restore hoàn thành!${NC}"
echo ""
echo -e "  Bước tiếp theo — mở Claude Code:"
echo -e "  ${BLUE}cd \"$DRIVE_DIR\"${NC}"
echo -e "  ${BLUE}claude${NC}"
echo ""
echo -e "  Claude sẽ tự đọc memory và tiếp tục đúng ngữ cảnh dự án."
