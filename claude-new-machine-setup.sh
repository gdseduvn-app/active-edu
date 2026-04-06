#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║  CLAUDE CODE — SETUP MÁY MỚI (chạy 1 lần)                 ║
# ║  Tự động cài đặt Claude Code + restore config              ║
# ║  Usage: bash claude-new-machine-setup.sh                   ║
# ╚══════════════════════════════════════════════════════════════╝

set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   AURA LMS — Claude Code Setup       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ──────────────────────────────────────────────────────────────
# BƯỚC 1: Kiểm tra Homebrew
# ──────────────────────────────────────────────────────────────
echo -e "${BLUE}[1/4] Kiểm tra Homebrew...${NC}"
if ! command -v brew &>/dev/null; then
  echo -e "  ${YELLOW}Homebrew chưa cài. Đang cài...${NC}"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add to PATH for Apple Silicon
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  fi
else
  echo -e "  ${GREEN}✓ Homebrew $(brew --version | head -1)${NC}"
fi

# ──────────────────────────────────────────────────────────────
# BƯỚC 2: Kiểm tra / cài Node.js
# ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/4] Kiểm tra Node.js...${NC}"
if ! command -v node &>/dev/null; then
  echo -e "  ${YELLOW}Node.js chưa cài. Đang cài qua nvm...${NC}"
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  echo -e "  ${GREEN}✓ Node.js $(node --version) đã cài${NC}"
else
  echo -e "  ${GREEN}✓ Node.js $(node --version)${NC}"
fi

# ──────────────────────────────────────────────────────────────
# BƯỚC 3: Kiểm tra / cài Claude Code
# ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[3/4] Kiểm tra Claude Code...${NC}"

# Load nvm nếu cần
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if ! command -v claude &>/dev/null; then
  echo -e "  ${YELLOW}Claude Code chưa cài. Đang cài...${NC}"
  npm install -g @anthropic-ai/claude-code
  echo -e "  ${GREEN}✓ Claude Code đã cài$(NC}"
else
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "")
  echo -e "  ${GREEN}✓ Claude Code $CLAUDE_VER${NC}"
fi

# ──────────────────────────────────────────────────────────────
# BƯỚC 4: Restore config từ Drive
# ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[4/4] Restore Claude config từ Google Drive...${NC}"

if [ -f "$SCRIPT_DIR/claude-sync-restore.sh" ]; then
  bash "$SCRIPT_DIR/claude-sync-restore.sh"
else
  echo -e "  ${YELLOW}⚠ Không tìm thấy claude-sync-restore.sh${NC}"
fi

# ──────────────────────────────────────────────────────────────
# HOÀN THÀNH
# ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✅ Setup hoàn thành!${NC}"
echo ""
echo -e "  ${BOLD}Để bắt đầu làm việc:${NC}"
echo -e "  ${BLUE}cd \"$SCRIPT_DIR\"${NC}"
echo -e "  ${BLUE}claude${NC}"
echo ""
echo -e "  ${BOLD}Sau mỗi buổi làm việc, lưu config:${NC}"
echo -e "  ${BLUE}bash \"$SCRIPT_DIR/claude-sync-push.sh\"${NC}"
echo ""
