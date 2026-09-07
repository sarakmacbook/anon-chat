#!/usr/bin/env bash
# Anon Chat — remove a one-click or standalone Docker Compose installation.
# Also works when fetched with curl and piped to bash (confirmation uses /dev/tty).
set -euo pipefail

usage() {
  cat <<'EOF'
Anon Chat — complete uninstall

Usage:
  bash uninstall.sh [--dry-run] [--yes] [--files-only]
  bash install.sh --uninstall [--dry-run] [--yes] [--files-only]
  curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/uninstall.sh | bash

Permanently removes this installation's containers, Compose-managed images,
networks and volumes, bind-mounted messages/uploads, and application directory
(including .env, keys and source code). Back up anything you want to keep first.
Docker itself, shared system packages and unrelated applications are not removed.

Options:
  --dry-run      Show what would be removed; do not change anything.
  -y, --yes      Skip the confirmation (required without an interactive terminal).
  --files-only   Explicitly skip Docker cleanup, e.g. if Docker was already removed.
                 Stop any local Node server first. This cannot remove Docker resources.
  -h, --help     Show this help.

Environment overrides:
  ANON_CHAT_DIR       Application directory (default: $HOME/anon-chat).
  ANON_CHAT_DATA      Data directory, if it cannot be discovered from the install.
  ANON_CHAT_PROJECT   Compose project, if its container and install record are gone.

Run as the same user who installed the app; sudo is requested only when needed.
Custom data paths are discovered from the container, the install record, or the
installer's Compose file. No shell configuration files are sourced or evaluated.
EOF
}

die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

YES=false
DRY_RUN=false
FILES_ONLY=false
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    -y|--yes) YES=true ;;
    --dry-run) DRY_RUN=true ;;
    --files-only) FILES_ONLY=true ;;
    *) die "Unknown option: $arg. Use --help for usage." ;;
  esac
done

START_DIR="$PWD"
HOME_DIR="$(cd -- "$HOME" && pwd -P)"

# Normalize even missing paths, but never follow symlinks. In particular, a
# symlink followed by /.. must not turn a harmless-looking path into a parent.
normalize_path() {
  local path="$1" part result=""
  local -a parts=()
  case "$path" in
    ''|*$'\n'*|*$'\r'*|*$'\t'*) die "Paths must be nonempty and contain no newlines or tabs." ;;
  esac
  [[ "$path" = /* ]] || path="$START_DIR/$path"
  IFS=/ read -r -a parts <<< "$path"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|.) continue ;;
      ..) result="${result%/*}" ;;
      *) result="$result/$part" ;;
    esac
    [[ ! -L "${result:-/}" ]] || die "Refusing a symlink in removal path: $path"
  done
  printf '%s\n' "${result:-/}"
}

safe_path() {
  local path
  path="$(normalize_path "$1")" || return 1
  case "$path" in
    /|/bin|/sbin|/lib|/lib64|/boot|/dev|/etc|/home|/media|/mnt|/opt|/proc|/root|/run|/snap|/srv|/sys|/tmp|/usr|/usr/local|/var|/var/backups|/var/cache|/var/lib|/var/lib/docker|/var/local|/var/log|/var/mail|/var/opt|/var/run|/var/spool|/var/tmp|/var/www)
      die "Refusing to delete a system directory: $path" ;;
    /dev/*|/proc/*|/sys/*|/etc/*|/usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/boot/*|/run/*|/snap/*|/var/run/*|/var/lib/docker/*)
      die "Refusing to delete files in a system directory: $path" ;;
  esac
  if [[ "$HOME_DIR" = "$path" || "$HOME_DIR" = "$path/"* ]]; then
    die "Refusing to delete your home directory or one of its parents: $path"
  fi
  printf '%s\n' "$path"
}

APP_DIR="$(safe_path "${ANON_CHAT_DIR:-$HOME/anon-chat}")"
if [[ -e "$APP_DIR" ]]; then
  if [[ ! -d "$APP_DIR" || ! -f "$APP_DIR/server.js" || ! -f "$APP_DIR/package.json" ]] ||
    ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"anon-chat"' "$APP_DIR/package.json"; then
    die "$APP_DIR does not look like an Anon Chat installation. Check ANON_CHAT_DIR."
  fi
fi

BIND_DIRS=()
CONTAINERS=()
IMAGES=()
NETWORKS=()
VOLUMES=()
DOCKER=(docker)

add_bind_dir() {
  local path existing
  path="$(safe_path "$1")" || return 1
  if [[ "$APP_DIR" = "$path" || "$APP_DIR" = "$path/"* ]]; then
    die "Data directory must not be the application directory or its parent: $path"
  fi
  for existing in "${BIND_DIRS[@]}"; do
    [[ "$existing" != "$path" ]] || return 0
  done
  BIND_DIRS+=("$path")
}

add_volume() {
  local existing
  for existing in "${VOLUMES[@]}"; do
    [[ "$existing" != "$1" ]] || return 0
  done
  VOLUMES+=("$1")
}

# This record contains only paths/project names, never passwords. Read it as
# plain text, not shell code, even if someone has edited it since installation.
RECORDED_DATA=""
RECORDED_PROJECT=""
if [[ -f "$APP_DIR/.anon-chat-install" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      data_dir=*) RECORDED_DATA="${line#data_dir=}" ;;
      project_name=*) RECORDED_PROJECT="${line#project_name=}" ;;
    esac
  done < "$APP_DIR/.anon-chat-install"
fi

PROJECT="${ANON_CHAT_PROJECT:-$RECORDED_PROJECT}"
if [[ -z "$PROJECT" ]]; then
  PROJECT="$(basename -- "$APP_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[-_]*//')"
fi

# Read the short volume syntax used by both shipped Compose files, for older
# installations whose containers were already removed. Live mounts take
# precedence; arbitrary YAML/interpolation is deliberately not guessed at.
read_compose_data() {
  local file="$APP_DIR/docker-compose.yml" line entry source target
  local found_data=false found_uploads=false found_service=false
  local in_services=false in_app=false in_volumes=false
  [[ ! -f "$APP_DIR/docker-compose.deploy.yml" ]] || file="$APP_DIR/docker-compose.deploy.yml"
  [[ -f "$file" ]] || return 0
  if grep -Eq '^[[:space:]]*(name|external):' "$file"; then
    die "Custom Compose resource names/external resources in $file require a container to inspect. Restore it before uninstalling."
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    entry="${line#"${line%%[![:space:]]*}"}"
    case "$entry" in ''|\#*) continue ;; esac
    # Limit the fallback to the shipped two-space indentation and this service's
    # volumes. Never interpret another service's mounts as Anon Chat data.
    case "$line" in
      services:) in_services=true; in_app=false; in_volumes=false; continue ;;
      [![:space:]]*) in_services=false; in_app=false; in_volumes=false ;;
      '  anon-chat:')
        if $in_services; then
          ! $found_service || die "Duplicate anon-chat service in $file. Restore the Compose file before uninstalling."
          found_service=true; in_app=true; in_volumes=false
        fi
        continue ;;
      '  '[![:space:]]*) in_app=false; in_volumes=false ;;
      '    volumes:') if $in_app; then in_volumes=true; fi; continue ;;
      '    '[![:space:]]*) in_volumes=false ;;
    esac
    $in_volumes || continue
    [[ "$entry" = '- '* ]] || continue
    entry="${entry#- }"
    entry="${entry%"${entry##*[![:space:]]}"}"
    case "$entry" in
      \"*\") entry="${entry:1:${#entry}-2}" ;;
      \'*\') entry="${entry:1:${#entry}-2}" ;;
    esac
    if [[ "$entry" =~ ^(.+):(/app/Data|/tmp/chat-uploads)(:[a-zA-Z,]+)?$ ]]; then
      source="${BASH_REMATCH[1]}"
      target="${BASH_REMATCH[2]}"
      case "$source" in
        *'$'*|*'`'*|*'"'*|*"'"*|*'~'*) die "Cannot safely read data path in $file. Set ANON_CHAT_DATA explicitly." ;;
        /*) add_bind_dir "$source" ;;
        ./*|../*) add_bind_dir "$APP_DIR/$source" ;;
        chat-data|chat-uploads) ;; # The stock Compose-managed volumes, selected by labels above.
        *) die "Unsupported mount in $file. Restore the container or set ANON_CHAT_DATA explicitly." ;;
      esac
      if [[ "$target" = /app/Data ]]; then found_data=true; else found_uploads=true; fi
    fi
  done < "$file"
  if ! $found_data || ! $found_uploads; then
    die "Cannot discover both data mounts in $file. Restore the container or set ANON_CHAT_DATA to their common data directory."
  fi
}

docker_cmd() { "${DOCKER[@]}" "$@"; }
container_label() { docker_cmd container inspect --format "{{ index .Config.Labels \"$2\" }}" "$1"; }

if ! $FILES_ONLY; then
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Use --files-only only if Docker cleanup is no longer needed."
  if ! docker_cmd info >/dev/null 2>&1; then
    if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
      DOCKER=(sudo docker)
    else
      die "Cannot access Docker. Start the daemon/check permissions, then retry. No files were deleted."
    fi
  fi

  # The fixed container name lets us recover custom Compose project names.
  # Do not remove a same-named container belonging to a different checkout.
  exact="$(docker_cmd container ls --all --quiet --filter 'name=^/anon-chat$')"
  if [[ -n "$exact" ]]; then
    service="$(container_label "$exact" com.docker.compose.service)"
    working_dir="$(container_label "$exact" com.docker.compose.project.working_dir)"
    actual_project="$(container_label "$exact" com.docker.compose.project)"
    [[ "$service" = anon-chat && "$(normalize_path "$working_dir")" = "$APP_DIR" ]] ||
      die "The anon-chat container belongs to another directory or is not Compose-managed. Check ANON_CHAT_DIR."
    [[ -z "${ANON_CHAT_PROJECT:-}" || "$ANON_CHAT_PROJECT" = "$actual_project" ]] ||
      die "ANON_CHAT_PROJECT does not match the installed container ($actual_project)."
    PROJECT="$actual_project"
  fi
fi

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "Invalid Compose project name: $PROJECT"

if ! $FILES_ONLY; then
  list="$(docker_cmd container ls --all --quiet --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=anon-chat')"
  if [[ -n "$list" ]]; then mapfile -t CONTAINERS <<< "$list"; fi
  for container in "${CONTAINERS[@]}"; do
    working_dir="$(container_label "$container" com.docker.compose.project.working_dir)"
    [[ "$(normalize_path "$working_dir")" = "$APP_DIR" ]] || die "Container $container belongs to another installation: $working_dir"
    mounts="$(docker_cmd container inspect --format '{{range .Mounts}}{{if or (eq .Destination "/app/Data") (eq .Destination "/tmp/chat-uploads")}}{{.Type}}{{"\t"}}{{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}{{end}}' "$container")"
    while IFS=$'\t' read -r kind source target; do
      [[ -n "$kind" ]] || continue
      case "$kind" in
        bind) add_bind_dir "$source" ;;
        volume)
          owner="$(docker_cmd volume inspect --format '{{ index .Labels "com.docker.compose.project" }}' "$source")"
          [[ "$owner" = "$PROJECT" ]] || die "Volume $source is external/shared. Remove it manually if appropriate; no resources have been deleted."
          add_volume "$source"
          ;;
        tmpfs) ;; # Removed with the container.
        *) die "Unsupported data mount type: $kind" ;;
      esac
    done <<< "$mounts"
  done

  list="$(docker_cmd image ls --quiet --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.service=anon-chat' | sort -u)"
  if [[ -n "$list" ]]; then mapfile -t IMAGES <<< "$list"; fi
  list="$(docker_cmd network ls --quiet --filter "label=com.docker.compose.project=$PROJECT" --filter 'label=com.docker.compose.network=default')"
  if [[ -n "$list" ]]; then mapfile -t NETWORKS <<< "$list"; fi
  for volume_key in chat-data chat-uploads; do
    list="$(docker_cmd volume ls --quiet --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.volume=$volume_key")"
    while IFS= read -r volume; do
      [[ -z "$volume" ]] || add_volume "$volume"
    done <<< "$list"
  done
fi

if [[ -n "${ANON_CHAT_DATA:-}" ]]; then
  override="$(safe_path "$ANON_CHAT_DATA")"
  if [[ "${#CONTAINERS[@]}" -gt 0 ]]; then
    matches=false
    for path in "${BIND_DIRS[@]}"; do
      [[ "$path" != "$override" ]] || matches=true
    done
    $matches || die "ANON_CHAT_DATA does not match this container's bind mounts; refusing to delete an additional directory."
  else
    add_bind_dir "$override"
  fi
elif [[ "${#CONTAINERS[@]}" -eq 0 ]]; then
  if [[ -n "$RECORDED_DATA" ]]; then
    add_bind_dir "$RECORDED_DATA"
  else
    read_compose_data
  fi
fi

printf '\n⚠️  Anon Chat — PERMANENT uninstall\n\n'
printf 'Application directory (including secrets/source): %s\n' "$APP_DIR"
printf 'Compose project: %s\n' "$PROJECT"
for path in "${BIND_DIRS[@]}"; do printf 'Data directory (messages, passkeys, uploads): %s\n' "$path"; done
for container in "${CONTAINERS[@]}"; do printf 'Container: %s\n' "$container"; done
for image in "${IMAGES[@]}"; do printf 'Image: %s\n' "$image"; done
for network in "${NETWORKS[@]}"; do printf 'Network: %s\n' "$network"; done
for volume in "${VOLUMES[@]}"; do printf 'Data volume: %s\n' "$volume"; done
printf '\nThis deletes all chat history, uploads, server-side passkeys and configuration.\n'
printf 'Docker, system packages, proxy configuration and browser/device data are kept.\n'
if $FILES_ONLY; then
  printf '\n⚠️  Files-only mode: Docker resources will NOT be inspected or removed.\n'
  printf 'Stop any running Anon Chat server before proceeding.\n'
fi
if $DRY_RUN; then
  printf '\nDry run only. Nothing was removed.\n'
  exit 0
fi

if ! $YES; then
  answer=""
  if (exec 3<>/dev/tty) 2>/dev/null; then
    read -rp "Type 'uninstall' to permanently delete the items above: " answer </dev/tty || answer=""
  elif [[ -t 0 ]]; then
    read -rp "Type 'uninstall' to permanently delete the items above: " answer || answer=""
  else
    die "No interactive terminal. Review --dry-run, then pass --yes to confirm deletion."
  fi
  if [[ "$answer" != uninstall ]]; then
    printf '\nCancelled. Nothing was removed.\n'
    exit 0
  fi
fi

# Unforced image/network/volume removal refuses resources still used by other
# containers. Never prune Docker globally or disconnect another application.
if [[ "${#CONTAINERS[@]}" -gt 0 ]]; then docker_cmd container rm --force -- "${CONTAINERS[@]}" || die "Container cleanup failed; filesystem cleanup was not started."; fi
if [[ "${#NETWORKS[@]}" -gt 0 ]]; then docker_cmd network rm -- "${NETWORKS[@]}" || die "Network cleanup failed (possibly shared); filesystem cleanup was not started."; fi
if [[ "${#IMAGES[@]}" -gt 0 ]]; then docker_cmd image rm -- "${IMAGES[@]}" || die "Image cleanup failed (possibly shared); filesystem cleanup was not started."; fi
if [[ "${#VOLUMES[@]}" -gt 0 ]]; then docker_cmd volume rm -- "${VOLUMES[@]}" || die "Volume cleanup failed (possibly shared); filesystem cleanup was not started."; fi

remove_dir() {
  local path
  # Recheck paths after confirmation/Docker cleanup, not just during discovery.
  path="$(safe_path "$1")" || return 1
  [[ -e "$path" ]] || return 0
  printf 'Removing %s\n' "$path"
  if ! rm -rf -- "$path"; then
    if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
      sudo rm -rf -- "$path" || die "Could not remove $path. Fix its permissions and retry."
    else
      die "Could not remove $path. Fix its permissions and retry."
    fi
  fi
}

# Leave the install directory before deleting it (the script may live there).
cd /
for path in "${BIND_DIRS[@]}"; do remove_dir "$path"; done
remove_dir "$APP_DIR"

if $FILES_ONLY; then
  printf '\n✅ Anon Chat files removed. Docker cleanup was explicitly skipped.\n'
else
  printf '\n✅ Anon Chat uninstalled. Docker and unrelated applications were left installed.\n'
fi
printf 'Remove any manually configured reverse proxy/DNS entries separately.\n'
printf 'Clear browser data/notifications for this site and saved device passkeys separately.\n'
