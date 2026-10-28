#!/bin/bash
set -e
echo "🚀 Installing Anon Chat..."

# --- Auto-detect OS ---
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
  VER=$VERSION_ID
  echo "📋 Detected: $OS $VER"
else
  echo "❌ Cannot detect OS. Manual install required."
  exit 1
fi

# --- Update packages ---
echo "📦 Updating packages..."
case "$OS" in
  ubuntu|debian)
    apt-get update -qq
    ;;
  centos|rhel|rocky|alma|ol|amzn)
    yum makecache -q
    ;;
  fedora)
    dnf makecache -q
    ;;
  *)
    echo "⚠️ Skipping package update for $OS"
    ;;
esac
echo "✅ Packages updated"

# --- Install prerequisites based on OS ---
install_deps() {
  case "$OS" in
    ubuntu|debian)
      apt-get update -qq
      apt-get install -y ca-certificates curl gnupg lsb-release
      ;;
    centos|rhel|rocky|alma|ol|amzn)
      yum install -y ca-certificates curl gnupg2
      ;;
    fedora)
      dnf install -y ca-certificates curl gnupg2
      ;;
    arch)
      pacman -Sy --noconfirm ca-certificates curl gnupg
      ;;
    alpine)
      apk add --no-cache ca-certificates curl gnupg
      ;;
    *)
      echo "⚠️ Unknown OS: $OS. Trying apt..."
      apt-get update -qq && apt-get install -y ca-certificates curl gnupg
      ;;
  esac
}

# --- Install Docker ---
install_docker() {
  if command -v docker &> /dev/null; then
    echo "✅ Docker already installed: $(docker --version)"
    return
  fi

  echo "📦 Installing Docker..."
  case "$OS" in
    ubuntu|debian)
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/$OS/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
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

  systemctl enable --now docker 2>/dev/null || true
  echo "✅ Docker installed: $(docker --version)"
}

# --- Install docker-compose (v1 fallback) ---
install_compose() {
  if command -v docker-compose &> /dev/null; then
    echo "✅ docker-compose installed: $(docker-compose --version)"
    return
  fi
  if docker compose version &> /dev/null; then
    echo "✅ docker compose plugin installed: $(docker compose version)"
    return
  fi

  echo "📦 Installing docker-compose..."
  case "$OS" in
    ubuntu|debian)
      apt-get install -y docker-compose 2>/dev/null || true
      ;;
    centos|rhel|rocky|alma|ol|amzn|fedora)
      yum install -y docker-compose-plugin 2>/dev/null || true
      ;;
  esac

  # Fallback: install via pip
  if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    if command -v pip3 &> /dev/null; then
      pip3 install docker-compose
    elif command -v pip &> /dev/null; then
      pip install docker-compose
    else
      # Download binary directly
      COMPOSE_VER="1.29.2"
      ARCH=$(uname -m)
      case "$ARCH" in
        x86_64) ARCH="x86_64" ;;
        aarch64|arm64) ARCH="aarch64" ;;
        *) echo "⚠️ Unsupported arch: $ARCH"; return ;;
      esac
      curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-$(uname -s)-${ARCH}" -o /usr/local/bin/docker-compose
      chmod +x /usr/local/bin/docker-compose
      echo "✅ docker-compose binary installed"
    fi
  fi
}

# --- Detect compose command ---
detect_compose() {
  if command -v docker-compose &> /dev/null; then
    COMPOSE="docker-compose"
  elif docker compose version &> /dev/null; then
    COMPOSE="docker compose"
  else
    echo "❌ docker-compose not found. Install manually."
    exit 1
  fi
  echo "🔧 Using: $COMPOSE"
}

# --- Main ---
install_deps
install_docker
install_compose
detect_compose

# --- Data location: default to Host folder (option 2) ---
DATA_CHOICE=2

if [ "$DATA_CHOICE" = "2" ]; then
  # Auto-detect available mounts — filter out tiny/temp mounts
  echo ""
  echo "📦 Available locations:"
  echo "   0) Custom path (type your own)"
  MOUNTS=()
  # Get all mounts with >100MB free, skip virtual/temp filesystems
  while IFS= read -r line; do
    MOUNT=$(echo "$line" | awk '{print $1}')
    SIZE=$(echo "$line" | awk '{print $2}')
    AVAIL=$(echo "$line" | awk '{print $3}')
    # Skip virtual filesystems and tiny mounts
    case "$MOUNT" in /proc|/sys*|/dev*|/run*|/snap*|/boot/efi) continue ;; esac
    MOUNTS+=("$MOUNT|$SIZE|$AVAIL")
  done < <(df -h --output=target,size,avail | grep -E "^/" | awk 'NR>1')

  # Also check common dirs
  for dir in /home /opt /data /var /mnt; do
    if [ -d "$dir" ]; then
      AVAIL=$(df -h "$dir" | tail -1 | awk '{print $4}')
      SIZE=$(df -h "$dir" | tail -1 | awk '{print $2}')
      EXISTS=false
      for m in "${MOUNTS[@]}"; do
        [[ "$m" == "$dir|"* ]] && EXISTS=true
      done
      [ "$EXISTS" = false ] && MOUNTS+=("$dir|$SIZE|$AVAIL")
    fi
  done

  i=1
  for entry in "${MOUNTS[@]}"; do
    MOUNT=$(echo "$entry" | cut -d'|' -f1)
    SIZE=$(echo "$entry" | cut -d'|' -f2)
    AVAIL=$(echo "$entry" | cut -d'|' -f3)
    echo "   $i) $MOUNT  ($AVAIL free / $SIZE total)"
    ((i++))
  done
  echo ""
  read -p "Select mount [Enter=0 custom, 1-$((i-1))]: " MOUNT_CHOICE
  MOUNT_CHOICE=${MOUNT_CHOICE:-0}

  if [ "$MOUNT_CHOICE" = "0" ]; then
    read -p "Enter public room path: " DATA_PUBLIC_PATH
    read -p "Enter private room path: " DATA_PRIVATE_PATH
  else
    SELECTED_ENTRY="${MOUNTS[$((MOUNT_CHOICE-1))]}"
    SELECTED_MOUNT=$(echo "$SELECTED_ENTRY" | cut -d'|' -f1)
    # Drill down — show subfolders
    CURRENT="$SELECTED_MOUNT"
    while true; do
      echo ""
      echo "📂 Current: $CURRENT"
      echo "   0) ✅ Use this folder"
      echo "   1) ../  (go up)"
      SUBS=()
      i=2
      for d in "$CURRENT"/*/; do
        [ -d "$d" ] || continue
        NAME=$(basename "$d")
        [ "$NAME" = "proc" ] || [ "$NAME" = "sys" ] || [ "$NAME" = "dev" ] || [ "$NAME" = "run" ] && continue
        SUBS+=("$d")
        echo "   $i) $NAME/"
        ((i++))
      done
      read -p "Select [0=use here, 1=up, 2-$((i-1))=subfolder]: " DIR_CHOICE
      if [ "$DIR_CHOICE" = "0" ]; then
        break
      elif [ "$DIR_CHOICE" = "1" ]; then
        CURRENT=$(dirname "$CURRENT")
      elif [ "$DIR_CHOICE" -ge 2 ] 2>/dev/null && [ "$DIR_CHOICE" -le $((i-1)) ]; then
        CURRENT="${SUBS[$((DIR_CHOICE-2))]}"
      else
        echo "Invalid choice"
      fi
    done
    DATA_PUBLIC_PATH="${CURRENT%/}/anon-chat/public"
    DATA_PRIVATE_PATH="${CURRENT%/}/anon-chat/private"
  fi

  mkdir -p "$DATA_PUBLIC_PATH" "$DATA_PRIVATE_PATH" "$DATA_PUBLIC_PATH/uploads" "$DATA_PRIVATE_PATH/uploads"
  echo "📁 Public:  $DATA_PUBLIC_PATH"
  echo "📁 Private: $DATA_PRIVATE_PATH"

  # Rewrite docker-compose.yml cleanly
  cat > docker-compose.yml << YAMLEOF
version: "3"
services:
  anon-chat:
    build: .
    container_name: anon-chat
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ${DATA_PUBLIC_PATH}:/app/Data/public
      - ${DATA_PRIVATE_PATH}:/app/Data/private
      - ${DATA_PUBLIC_PATH}/uploads:/tmp/chat-uploads/public
      - ${DATA_PRIVATE_PATH}/uploads:/tmp/chat-uploads/private
YAMLEOF
  echo "✅ docker-compose.yml updated with bind mounts"
else
  echo "📁 Using Docker volume (default)"
fi

# --- Build and start ---
cd "$(dirname "$0")"
$COMPOSE down 2>/dev/null || true
$COMPOSE build
$COMPOSE up -d

# --- Verify ---
sleep 5
STATUS=$(docker ps --filter "name=anon-chat" --format "{{.Status}}")
echo ""
if echo "$STATUS" | grep -q "Up"; then
  echo ""
  echo "✅ Anon Chat is running!"
  echo "🌐 http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):3000"
  echo ""
  echo "🔒 Add HTTPS to make notifications work (Web Push requires a secure context)."
  echo ""
  echo "📁 Data locations:"
  if [ "$DATA_CHOICE" = "2" ]; then
    echo "   Public:  $DATA_PUBLIC_PATH/messages.json"
    echo "   Private: $DATA_PRIVATE_PATH/messages.json"
    echo "   Uploads: $DATA_PUBLIC_PATH/uploads/"
  else
    echo "   Chats:  /var/lib/docker/volumes/$(docker volume ls -q | grep chat-data)/_data/"
    echo "   Uploads: /var/lib/docker/volumes/$(docker volume ls -q | grep chat-uploads)/_data/"
  fi
else
  echo "❌ Failed to start. Logs:"
  docker logs anon-chat 2>&1 | tail -10
fi
