#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
#  Anon Chat — one-click installer (fetched & run straight from GitHub)
#
#  One-click install:
#      curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash
#
#  Optional environment overrides (no prompts needed):
#      ANON_CHAT_REPO_URL    git URL to install from   (default: this GitHub repo)
#      ANON_CHAT_DIR         install folder            (default: $HOME/anon-chat)
#      ANON_CHAT_DATA        data folder               (default: $HOME/anon-chat-data)
#      ANON_CHAT_PORT        public TCP port           (installer asks; default: 3000)
#      PRIVATE_PASSWORD      #Private room password    (default: built-in password)
#
#  Re-running the same command updates the install in place.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  cat <<'EOF'
Anon Chat — one-click installer

One-click install (fetched from GitHub):
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash

Run a local copy:
  bash install.sh [--help]

Environment overrides (all optional):
  ANON_CHAT_REPO_URL   git URL to install from   (default: https://github.com/sarakmacbook/anon-chat.git)
  ANON_CHAT_DIR        install folder            (default: $HOME/anon-chat)
  ANON_CHAT_DATA       data folder               (default: $HOME/anon-chat-data)
  ANON_CHAT_PORT       public TCP port           (installer asks; default: 3000)
  PRIVATE_PASSWORD     #Private room password    (default: built-in password)
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

die() { echo ""; echo "❌ $*"; exit 1; }

REPO_URL="${ANON_CHAT_REPO_URL:-https://github.com/sarakmacbook/anon-chat.git}"
APP_DIR="${ANON_CHAT_DIR:-$HOME/anon-chat}"
DATA_DIR="${ANON_CHAT_DATA:-$HOME/anon-chat-data}"
HOST_PORT="${ANON_CHAT_PORT:-3000}"

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Read from the controlling terminal so this also works with `curl ... | bash`.
# ANON_CHAT_PORT remains available for unattended installations.
if [ -z "${ANON_CHAT_PORT:-}" ] && [ -r /dev/tty ]; then
  while true; do
    if ! read -rp "Public port [${HOST_PORT}]: " answer </dev/tty; then
      echo "⚠️  No interactive terminal available; using port ${HOST_PORT}."
      break
    fi
    candidate="${answer:-$HOST_PORT}"
    if valid_port "$candidate"; then
      HOST_PORT="$candidate"
      break
    fi
    echo "Please enter a port from 1 to 65535." >/dev/tty
  done
fi

valid_port "$HOST_PORT" || die "ANON_CHAT_PORT must be a number from 1 to 65535 (got: '$HOST_PORT')."

if [ -n "${PRIVATE_PASSWORD:-}" ]; then
  case "$PRIVATE_PASSWORD" in
    *'"'*|*$'\n'*|*$'\t'*) die "PRIVATE_PASSWORD may not contain double quotes, tabs or newlines." ;;
  esac
fi

echo "🚀 Installing Anon Chat..."
echo "   Repo:  $REPO_URL"
echo "   App:   $APP_DIR"
echo "   Data:  $DATA_DIR"
echo "   Port:  $HOST_PORT"
[ -n "${PRIVATE_PASSWORD:-}" ] && echo "   Password: (custom — set via PRIVATE_PASSWORD)"
echo ""

# --- Auto-detect OS ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS="${ID:-}"
  [ -n "${VERSION_ID:-}" ] && echo "📋 Detected OS: $OS $VERSION_ID"
  [ -n "$OS" ] || die "Cannot detect OS from /etc/os-release."
else
  die "Cannot detect OS (no /etc/os-release). Install Docker manually, then re-run."
fi

# --- Sudo (curl|bash runs as a regular user; Docker install needs root) ---
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
    echo "🔐 Will use sudo for system packages and Docker."
    sudo -v 2>/dev/null || die "sudo failed — re-run from a terminal where you can enter your password."
  else
    die "Need root privileges and sudo was not found. Try: sudo bash -c \"curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash\""
  fi
fi

# --- Install prerequisites (curl, git, ca-certs, gnupg) ---
install_deps() {
  case "$OS" in
    ubuntu|debian)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y ca-certificates curl git gnupg
      ;;
    centos|rhel|rocky|alma|ol|amzn)
      $SUDO yum install -y ca-certificates curl git gnupg2
      ;;
    fedora)
      $SUDO dnf install -y ca-certificates curl git gnupg2
      ;;
    arch)
      $SUDO pacman -Sy --noconfirm ca-certificates curl git gnupg
      ;;
    alpine)
      $SUDO apk add --no-cache ca-certificates curl git gnupg
      ;;
    *)
      echo "⚠️ Unknown OS ($OS), trying apt..."
      $SUDO apt-get update -qq && $SUDO apt-get install -y ca-certificates curl git gnupg
      ;;
  esac
}

# --- Install Docker (if missing) ---
install_docker() {
  if command -v docker &> /dev/null; then
    echo "✅ Docker already installed: $(docker --version 2>/dev/null || $SUDO docker --version)"
    return
  fi

  echo "📦 Installing Docker..."
  case "$OS" in
    ubuntu|debian)
      $SUDO install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/$OS/gpg" | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(. /etc/os-release && echo $VERSION_CODENAME) stable" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
      $SUDO apt-get update -qq
      $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    centos|rhel|rocky|alma|ol|amzn)
      $SUDO yum install -y yum-utils
      $SUDO yum-config-manager --add-repo https://download.docker.com/linux/$OS/docker-ce.repo
      $SUDO yum install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    fedora)
      $SUDO dnf install -y dnf-plugins-core
      $SUDO dnf config-manager --add-repo https://download.docker.com/linux/$OS/docker-ce.repo
      $SUDO dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
      ;;
    arch)
      $SUDO pacman -S --noconfirm docker docker-compose
      ;;
    alpine)
      $SUDO apk add --no-cache docker docker-compose
      ;;
    *)
      echo "Trying Docker convenience script..."
      curl -fsSL https://get.docker.com | $SUDO sh || die "Docker install failed for $OS"
      ;;
  esac

  # Start Docker now (so it doesn't require a reboot)
  $SUDO systemctl enable --now docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
  echo "✅ Docker installed: $($SUDO docker --version 2>/dev/null || docker --version)"
  if [ -n "$SUDO" ] && [ -n "${USER:-}" ]; then
    $SUDO usermod -aG docker "$USER" 2>/dev/null || true
    echo "💡 You were added to the 'docker' group — it takes effect in a NEW terminal (or run 'newgrp docker')."
  fi
}

# --- Detect docker compose command (plugin v2 or legacy binary), with sudo if needed ---
detect_compose() {
  if $SUDO docker compose version &> /dev/null; then
    COMPOSE=("$SUDO" docker compose)
  elif $SUDO docker-compose version &> /dev/null; then
    COMPOSE=("$SUDO" docker-compose)
  else
    die "Docker Compose not found. Install it manually, then re-run."
  fi
  # Drop the empty first element when running as root (no sudo)
  if [ -z "$SUDO" ]; then COMPOSE=("${COMPOSE[@]:1}"); fi
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
if [ -t 0 ] && [ -z "${ANON_CHAT_DATA:-}" ]; then
  read -rp "Data folder [Enter to keep $DATA_DIR]: " ans
  DATA_DIR="${ans:-$DATA_DIR}"
fi

# --- Main ---
install_deps
install_docker
detect_compose
fetch_source

# --- Make sure the public port is free (unless our own container holds it) ---
if "$SUDO" docker ps -aq -f name=anon-chat 2>/dev/null | grep -q .; then
  echo "🔄 Existing anon-chat container found — it will be recreated with the new build."
elif command -v ss >/dev/null 2>&1; then
  if ss -lnt 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${HOST_PORT}$"; then
    die "Port $HOST_PORT is already in use. Stop that service, or pick another port: ANON_CHAT_PORT=8080 curl -fsSL ... | bash"
  fi
else
  if (exec 3<>"/dev/tcp/127.0.0.1/${HOST_PORT}") 2>/dev/null; then
    exec 3>&- 3<&- || true
    die "Port $HOST_PORT is already in use. Stop that service, or pick another port: ANON_CHAT_PORT=8080 curl -fsSL ... | bash"
  fi
fi

# Make sure data folders exist
mkdir -p "$DATA_DIR/uploads"
echo "📁 Data will be stored in: $DATA_DIR"
echo ""

# Write a self-contained compose file that bind-mounts the chosen data folder.
PW_LINE=""
[ -n "${PRIVATE_PASSWORD:-}" ] && PW_LINE="      - PRIVATE_PASSWORD=${PRIVATE_PASSWORD}"
cat > docker-compose.deploy.yml <<YAMLEOF
services:
  anon-chat:
    build: .
    container_name: anon-chat
    restart: unless-stopped
    ports:
      - "${HOST_PORT}:3000"
    environment:
      - NODE_ENV=production
${PW_LINE}
    volumes:
      - "${DATA_DIR}:/app/Data"
      - "${DATA_DIR}/uploads:/tmp/chat-uploads"
YAMLEOF

echo "🏗️  Building image (this can take a minute on first run)..."
"${COMPOSE[@]}" -f docker-compose.deploy.yml down --remove-orphans 2>/dev/null || true
"${COMPOSE[@]}" -f docker-compose.deploy.yml build
"${COMPOSE[@]}" -f docker-compose.deploy.yml up -d

# --- Verify the app is actually answering ---
echo "⏳ Waiting for Anon Chat to answer on port ${HOST_PORT}..."
UP=""
for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null; then
    UP=1
    break
  fi
  sleep 2
done

STATUS="$($SUDO docker ps --filter "name=anon-chat" --format "{{.Status}}" 2>/dev/null || true)"
echo ""
if [ -n "$UP" ] && echo "$STATUS" | grep -q "Up"; then
  PUBLIC_IP="$(curl -s --max-time 5 ifconfig.me 2>/dev/null || true)"
  [ -n "$PUBLIC_IP" ] || PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "✅ Anon Chat is running!"
  echo "🌐 http://${PUBLIC_IP:-localhost}:${HOST_PORT}"
  echo ""
  echo "📁 Data location: $DATA_DIR"
  echo "   (messages.json + uploads/ live here — back this folder up)"
  [ -n "${PRIVATE_PASSWORD:-}" ] || echo "⚠️  Using the built-in #Private password. Set PRIVATE_PASSWORD to your own (see README)."
  echo ""
  echo "🔒 Add HTTPS so Web Push notifications and passkeys work"
  echo "   (WebAuthn requires a secure context, e.g. behind Caddy/Nginx/Cloudflare — see README)."
  echo ""
  echo "💡 Re-run the same command any time to update to the latest version."
else
  echo "❌ Failed to start. Logs:"
  $SUDO docker logs anon-chat 2>&1 | tail -20
  exit 1
fi
