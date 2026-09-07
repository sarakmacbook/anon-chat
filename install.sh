#!/bin/bash
set -e

# ────────────────────────────────────────────────────────────────────────────
#  Anon Chat — one-click installer (fetched & run straight from GitHub)
#
#  One-click install:
#      curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash
#
#  Optional environment overrides (no prompts needed):
#      ANON_CHAT_REPO_URL   git URL to install from  (default: this GitHub repo)
#      ANON_CHAT_DIR        install folder           (default: $HOME/anon-chat)
#      ANON_CHAT_DATA       data folder              (default: $HOME/anon-chat-data)
# ────────────────────────────────────────────────────────────────────────────

REPO_URL="${ANON_CHAT_REPO_URL:-https://github.com/sarakmacbook/anon-chat.git}"
APP_DIR="${ANON_CHAT_DIR:-$HOME/anon-chat}"
DATA_DIR="${ANON_CHAT_DATA:-$HOME/anon-chat-data}"

echo "🚀 Installing Anon Chat..."
echo "   Repo: $REPO_URL"
echo "   App:  $APP_DIR"
echo "   Data: $DATA_DIR"
echo ""

# --- Auto-detect OS ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  echo "📋 Detected OS: $OS $VERSION_ID"
else
  echo "❌ Cannot detect OS. Manual install required."
  exit 1
fi

# --- Update package index ---
case "$OS" in
  ubuntu|debian)   apt-get update -qq ;;
  centos|rhel|rocky|alma|ol|amzn) yum makecache -q ;;
  fedora)          dnf makecache -q ;;
  *) echo "⚠️ Skipping package update for $OS" ;;
esac

# --- Install prerequisites (curl, git, ca-certs, gnupg) ---
install_deps() {
  case "$OS" in
    ubuntu|debian)
      apt-get update -qq
      apt-get install -y ca-certificates curl git gnupg lsb-release
      ;;
    centos|rhel|rocky|alma|ol|amzn)
      yum install -y ca-certificates curl git gnupg2
      ;;
    fedora)
      dnf install -y ca-certificates curl git gnupg2
      ;;
    arch)
      pacman -Sy --noconfirm ca-certificates curl git gnupg
      ;;
    alpine)
      apk add --no-cache ca-certificates curl git gnupg
      ;;
    *)
      echo "⚠️ Unknown OS ($OS), trying apt..."
      apt-get update -qq && apt-get install -y ca-certificates curl git gnupg
      ;;
  esac
}

# --- Install Docker (if missing) ---
install_docker() {
  if command -v docker &> /dev/null; then
    echo "✅ Docker already installed: $(docker --version)"
    return
  fi

  echo "📦 Installing Docker..."
  case "$OS" in
    ubuntu|debian)
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$OS/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    centos|rhel|rocky|alma|ol|amzn)
      yum install -y yum-utils
      yum-config-manager --add-repo https://download.docker.com/linux/$OS/docker-ce.repo
      yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    fedora)
      dnf install -y dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/$OS/docker-ce.repo
      dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    arch)
      pacman -S --noconfirm docker docker-compose
      ;;
    alpine)
      apk add --no-cache docker docker-compose
      ;;
    *)
      echo "Trying Docker convenience script..."
      curl -fsSL https://get.docker.com | sh || {
        echo "❌ Docker install failed for $OS"
        exit 1
      }
      ;;
  esac

  # Start Docker now (so it doesn't require a reboot)
  systemctl enable --now docker 2>/dev/null || true
  service docker start 2>/dev/null || true
  echo "✅ Docker installed: $(docker --version)"
}

# --- Detect docker compose command (plugin v2 or legacy binary) ---
detect_compose() {
  if docker compose version &> /dev/null; then
    COMPOSE=(docker compose)
  elif command -v docker-compose &> /dev/null; then
    COMPOSE=(docker-compose)
  else
    echo "❌ Docker Compose not found. Install manually then re-run."
    exit 1
  fi
  echo "🔧 Using: ${COMPOSE[*]}"
}

# --- Fetch / update the app source ---
fetch_source() {
  if [ ! -d "$APP_DIR/.git" ]; then
    echo "📦 Cloning Anon Chat into $APP_DIR ..."
    mkdir -p "$APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  else
    echo "🔄 Updating existing install in $APP_DIR ..."
    git -C "$APP_DIR" pull --ff-only || true
  fi
  cd "$APP_DIR"
}

# --- Ask for data folder (only when running in an interactive terminal) ---
if [ -t 0 ] && [ -z "$ANON_CHAT_DATA" ]; then
  read -rp "Data folder [Enter to keep $DATA_DIR]: " ans
  DATA_DIR="${ans:-$DATA_DIR}"
fi

# --- Main ---
install_deps
install_docker
fetch_source
detect_compose

# Make sure data folders exist
mkdir -p "$DATA_DIR/uploads"
echo "📁 Data will be stored in: $DATA_DIR"
echo ""

# Write a self-contained compose file that bind-mounts the chosen data folder.
cat > docker-compose.deploy.yml << YAMLEOF
services:
  anon-chat:
    build: .
    container_name: anon-chat
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - "${DATA_DIR}:/app/Data"
      - "${DATA_DIR}/uploads:/tmp/chat-uploads"
YAMLEOF

echo "🏗️  Building image (this can take a minute on first run)..."
"${COMPOSE[@]}" -f docker-compose.deploy.yml down --remove-orphans 2>/dev/null || true
"${COMPOSE[@]}" -f docker-compose.deploy.yml build
"${COMPOSE[@]}" -f docker-compose.deploy.yml up -d

# --- Verify ---
sleep 5
STATUS=$(docker ps --filter "name=anon-chat" --format "{{.Status}}")
echo ""
if echo "$STATUS" | grep -q "Up"; then
  PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  echo "✅ Anon Chat is running!"
  echo "🌐 http://${PUBLIC_IP:-localhost}:3000"
  echo ""
  echo "📁 Data location: $DATA_DIR"
  echo "   (messages.json + uploads/ live here — back this folder up)"
  echo ""
  echo "🔒 Add HTTPS so Web Push notifications and passkeys work"
  echo "   (WebAuthn requires a secure context, e.g. behind Caddy/Nginx/Cloudflare)."
  echo ""
  echo "💡 Re-run the same command any time to update to the latest version."
else
  echo "❌ Failed to start. Logs:"
  docker logs anon-chat 2>&1 | tail -20
  exit 1
fi
