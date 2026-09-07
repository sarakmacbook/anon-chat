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
#      PRIVATE_PASSWORD      #Private room password    (installer asks if not set)
#
#  Re-running the same command updates the install in place.
#  Complete uninstall: bash install.sh --uninstall (use --dry-run to preview).
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  cat <<'EOF'
Anon Chat — one-click installer

One-click install (fetched from GitHub):
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash

Run a local copy:
  bash install.sh [--help]

Complete uninstall (permanently deletes app data; asks for confirmation):
  bash install.sh --uninstall [--dry-run] [--yes] [--files-only]
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash -s -- --uninstall
  Use --uninstall --help for details.

Environment overrides (all optional):
  ANON_CHAT_REPO_URL   git URL to install from   (default: https://github.com/sarakmacbook/anon-chat.git)
  ANON_CHAT_DIR        install folder            (default: $HOME/anon-chat)
  ANON_CHAT_DATA       data folder               (default: $HOME/anon-chat-data)
  ANON_CHAT_PORT       public TCP port           (installer asks; default: previous port on updates, else 3000)
  PRIVATE_PASSWORD     #Private room password    (installer asks if not set — encrypted with PBKDF2 + AES-256-GCM)
EOF
}

die() { echo ""; echo "❌ $*"; exit 1; }

# Dispatch before any install prompts, package changes, or source updates.
# With curl | bash there is no local script path, so fetch the standalone tool.
if [ "${1:-}" = "--uninstall" ]; then
  shift
  SCRIPT_DIR=""
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  fi
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/uninstall.sh" ]; then
    exec bash "$SCRIPT_DIR/uninstall.sh" "$@"
  fi
  UNINSTALL_SCRIPT="$(mktemp)"
  trap 'rm -f -- "$UNINSTALL_SCRIPT"' EXIT
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/uninstall.sh -o "$UNINSTALL_SCRIPT"
  bash "$UNINSTALL_SCRIPT" "$@"
  exit 0
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi
[ "$#" -eq 0 ] || die "Unknown option: $1. Use --help for usage."

REPO_URL="${ANON_CHAT_REPO_URL:-https://github.com/sarakmacbook/anon-chat.git}"
APP_DIR="${ANON_CHAT_DIR:-$HOME/anon-chat}"
DATA_DIR="${ANON_CHAT_DATA:-$HOME/anon-chat-data}"
HOST_PORT="${ANON_CHAT_PORT:-3000}"

# Keep a custom data directory on subsequent installs. Treat the install record
# as plain text, never as shell code (it is also used by the uninstaller).
if [ -z "${ANON_CHAT_DATA:-}" ] && [ -r "$APP_DIR/.anon-chat-install" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      data_dir=*) DATA_DIR="${line#data_dir=}" ;;
    esac
  done < "$APP_DIR/.anon-chat-install"
fi

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Is something already listening on this port? (ss if present, else bash's /dev/tcp)
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${1}$"
  elif (exec 3<>"/dev/tcp/127.0.0.1/${1}") 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

# On updates, default to the port the previous install used (so pressing
# Enter doesn't silently move the app back to 3000).
PREV_PORT=""
if [ -r "$APP_DIR/docker-compose.deploy.yml" ]; then
  PREV_PORT="$(grep -oE '[0-9]+:3000' "$APP_DIR/docker-compose.deploy.yml" 2>/dev/null | head -n1 | cut -d: -f1 || true)"
  valid_port "$PREV_PORT" || PREV_PORT=""
fi
if [ -z "${ANON_CHAT_PORT:-}" ] && [ -n "$PREV_PORT" ]; then
  HOST_PORT="$PREV_PORT"
fi

# Where can we ask the user? /dev/tty works even with `curl ... | bash`;
# plain stdin works when there's no controlling terminal but stdin is a terminal.
# (Probe /dev/tty in a subshell so a failed open can't print a bash error.)
ASK_TTY=""
if (exec 3<>/dev/tty) 2>/dev/null; then
  ASK_TTY="tty"
elif [ -t 0 ]; then
  ASK_TTY="stdin"
fi

# Ask for the port (ANON_CHAT_PORT skips the prompt for unattended installs).
if [ -z "${ANON_CHAT_PORT:-}" ]; then
  if [ -z "$ASK_TTY" ]; then
    echo "ℹ️  No interactive terminal — using port ${HOST_PORT} (set ANON_CHAT_PORT to override)."
  else
    while true; do
      ANSWER=""
      label="Public port"
      [ -n "$PREV_PORT" ] && label="Public port (current install: ${PREV_PORT})"
      if [ "$ASK_TTY" = "tty" ]; then
        read -rp "${label} [${HOST_PORT}]: " ANSWER </dev/tty || ANSWER=""
      else
        read -rp "${label} [${HOST_PORT}]: " ANSWER || ANSWER=""
      fi
      candidate="${ANSWER:-$HOST_PORT}"
      if ! valid_port "$candidate"; then
        echo "Please enter a port from 1 to 65535."
        continue
      fi
      if [ "$candidate" != "$PREV_PORT" ] && port_in_use "$candidate"; then
        echo "Port ${candidate} is already in use — please pick another."
        continue
      fi
      HOST_PORT="$candidate"
      break
    done
  fi
fi

valid_port "$HOST_PORT" || die "ANON_CHAT_PORT must be a number from 1 to 65535 (got: '$HOST_PORT')."

# ─── Prompt for #Private room password ────────────────────────────────────────
#  The password protects the #Private room and is used to derive:
#    • A PBKDF2-SHA512 hash (600 000 iterations) for authentication
#    • An AES-256-GCM encryption key for passkey data at rest
#
#  The password is written to a .env file (chmod 600) so it never appears in
#  docker-compose.yml or process listings.
# ──────────────────────────────────────────────────────────────────────────────

ENV_FILE=""

if [ -z "${PRIVATE_PASSWORD:-}" ]; then
  if [ -n "$ASK_TTY" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔐  Set up your #Private room password"
    echo ""
    echo "   This password will be encrypted with high-end encryption:"
    echo "   • PBKDF2-SHA512 (600 000 iterations) for authentication"
    echo "   • AES-256-GCM to encrypt passkey data at rest on disk"
    echo ""
    echo "   You will use this password to unlock the #Private room"
    echo "   and to create passkeys (Face ID / Touch ID / Chrome)."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    while true; do
      if [ "$ASK_TTY" = "tty" ]; then
        read -rsp "  Enter password (min 6 characters): " pw1 </dev/tty || pw1=""
        echo ""
        read -rsp "  Confirm password: " pw2 </dev/tty || pw2=""
        echo ""
      else
        read -rsp "  Enter password (min 6 characters): " pw1 || pw1=""
        echo ""
        read -rsp "  Confirm password: " pw2 || pw2=""
        echo ""
      fi

      if [ -z "$pw1" ]; then
        echo "  ⚠️  Password cannot be empty. Try again."
        echo ""
        continue
      fi
      if [ "${#pw1}" -lt 6 ]; then
        echo "  ⚠️  Password must be at least 6 characters. Try again."
        echo ""
        continue
      fi
      if [ "$pw1" != "$pw2" ]; then
        echo "  ⚠️  Passwords do not match. Try again."
        echo ""
        continue
      fi
      PRIVATE_PASSWORD="$pw1"
      break
    done
    echo ""
    echo "  ✅ Password accepted. It will be encrypted with PBKDF2-SHA512 + AES-256-GCM."
    echo ""
  else
    echo "ℹ️  No interactive terminal — using built-in password (set PRIVATE_PASSWORD to customize)."
  fi
fi

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
[ -n "${PRIVATE_PASSWORD:-}" ] && echo "   🔐 Password: configured (PBKDF2-SHA512 + AES-256-GCM encryption)"
echo ""

# --- Auto-detect OS ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS="${ID:-}"
  [ -n "$VERSION_ID" ] && echo "📋 Detected OS: $OS $VERSION_ID"
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
  APP_DIR="$(pwd -P)"
}

# --- Ask for data folder (only when we have a terminal to ask on) ---
if [ -n "$ASK_TTY" ] && [ -z "${ANON_CHAT_DATA:-}" ]; then
  if [ "$ASK_TTY" = "tty" ]; then
    read -rp "Data folder [Enter to keep $DATA_DIR]: " ans </dev/tty || ans=""
  else
    read -rp "Data folder [Enter to keep $DATA_DIR]: " ans || ans=""
  fi
  DATA_DIR="${ans:-$DATA_DIR}"
fi

# The deployment file and plain-text install record require single-line paths.
case "$APP_DIR$DATA_DIR" in
  *$'\n'*|*$'\r'*|*$'\t'*) die "Install and data paths may not contain newlines or tabs." ;;
esac

# Resolve a relative data path before fetch_source changes the working directory.
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac

# --- Main ---
install_deps
install_docker
detect_compose
fetch_source

# --- Write the .env file (password stored securely, not in docker-compose.yml) ---
ENV_FILE="$APP_DIR/.env"
if [ -n "${PRIVATE_PASSWORD:-}" ]; then
  # Write the private password to a .env file with restricted permissions.
  # docker-compose reads .env automatically from the same directory.
  cat > "$ENV_FILE" <<ENVEOF
PRIVATE_PASSWORD=${PRIVATE_PASSWORD}
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "🔐 Password written to $ENV_FILE (mode 600 — readable only by owner)"
  # Clear the shell variable so it doesn't linger in memory longer than needed
  unset PRIVATE_PASSWORD
fi

# --- Make sure the public port is free (unless our own container holds it) ---
if "$SUDO" docker ps -aq -f name=anon-chat 2>/dev/null | grep -q .; then
  echo "🔄 Existing anon-chat container found — it will be recreated with the new build."
elif port_in_use "$HOST_PORT"; then
  die "Port $HOST_PORT is already in use. Stop that service, or pick another port: ANON_CHAT_PORT=8080 curl -fsSL ... | bash"
fi

# Make sure data folders exist
mkdir -p "$DATA_DIR/uploads"
DATA_DIR="$(cd -- "$DATA_DIR" && pwd -P)"
# Save this before building so even an interrupted installation can be removed.
printf 'data_dir=%s\n' "$DATA_DIR" > "$APP_DIR/.anon-chat-install"
chmod 600 "$APP_DIR/.anon-chat-install"
echo "📁 Data will be stored in: $DATA_DIR"
echo ""

# Write a self-contained compose file that bind-mounts the chosen data folder.
# The password is passed via the .env file (written above), not inline.
cat > docker-compose.deploy.yml <<YAMLEOF
services:
  anon-chat:
    build: .
    container_name: anon-chat
    restart: unless-stopped
    ports:
      - "${HOST_PORT}:3000"
    env_file:
      - path: .env
        required: false
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
INSTALL_PROJECT="$($SUDO docker container inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' anon-chat)"
printf 'project_name=%s\n' "$INSTALL_PROJECT" >> "$APP_DIR/.anon-chat-install"

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
  echo ""
  echo "🔐 Encryption:"
  echo "   • Password hashed with PBKDF2-SHA512 (600 000 iterations)"
  echo "   • Passkey data encrypted at rest with AES-256-GCM"
  echo "   • Password stored in $ENV_FILE (mode 600)"
  echo ""
  echo "🔒 Add HTTPS so Web Push notifications and passkeys work"
  echo "   (WebAuthn requires a secure context, e.g. behind Caddy/Nginx/Cloudflare — see README)."
  echo ""
  echo "💡 Re-run the same command any time to update to the latest version."
  printf '💡 Preview a complete uninstall: ANON_CHAT_DIR=%q bash %q --dry-run\n' "$APP_DIR" "$APP_DIR/uninstall.sh"
else
  echo "❌ Failed to start. Logs:"
  $SUDO docker logs anon-chat 2>&1 | tail -20
  exit 1
fi
