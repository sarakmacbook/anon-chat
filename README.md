# 💬 Anon Chat

Anonymous real-time chat you can host yourself. No accounts, no sign-up, no database — two rooms, a dark mobile-first UI, and files that clean themselves up.

- **#Public** — open to anyone: random anonymous nicknames (CoolPanda42), live messages, file sharing, built-in rate limiting.
- **#Private** — password-protected room. Unlock with a password **or a passkey** (iPhone Face ID / Touch ID, Windows Hello, Chrome passkeys), with **Web Push notifications** for every new message.

Built with Node.js, Express and Socket.IO. Ships as a Docker image, a single-file installer, a complete uninstaller, and a one-click [Vercel deployment](#️-deploy-to-vercel).

## ✨ Features

- 🔒 **#Private room** — password or passkey (WebAuthn) unlock; 5-minute unlock tokens
- 🔑 **Passkeys** — enter the password once, tap **Save Passkey**, then unlock with Face ID / Touch ID / Hello. Only public keys are stored server-side.
- 🔔 **Web Push notifications** for #Private messages — even when the tab is closed
- 📎 **File sharing** — inline image previews, full-screen viewer, upload progress bar; 200 MB limit in #Public, ~all free disk space in #Private
- 🧹 **Self-cleaning** — uploaded files expire after 180 days; message history is capped at the latest 10,000 per room
- 🤖 **Anti-spam** — per-user rate limits (10 messages / 30 s → 60 s mute), duplicate-message guard, upload throttling
- 👻 **Zero accounts** — random adjective + animal nicknames, changeable anytime, nothing tied to who you are
- 🐘 **Zero database** — all state is plain JSON in one folder; backup = `cp -r`
- 📱 **Mobile-first** — works great on phones; WebSocket chat with image lightbox
- 🗑️ **Complete uninstall** — preview and remove the app, its Docker resources, and stored data with a confirmation prompt

## 🚀 One-click install (Linux)

One line — everything is fetched straight from this GitHub repo:

```bash
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash
```

The installer will:

1. Ask which public port to use (press Enter for `3000`; it re-asks if the port is taken)
2. Install Docker if it's missing (Ubuntu/Debian, RHEL/Rocky/Alma, Fedora, Arch, Alpine)
3. Clone this repo to `~/anon-chat` (or update an existing install)
4. Build the image and start the `anon-chat` container with data in `~/anon-chat-data`
5. Verify the app is answering, then print your URL (usually `http://YOUR_SERVER_IP:3000`)

**Updating later?** Run the exact same command — it pulls the latest code and rebuilds,
and keeps the port and data folder from your previous install (just press Enter).

### Options (environment variables)

```bash
# Data elsewhere, port 8080, and your own #Private password:
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | \
  ANON_CHAT_DATA=~/chat-data ANON_CHAT_PORT=8080 PRIVATE_PASSWORD='my-secret' bash
```

| Variable | Default | Meaning |
|---|---|---|
| `ANON_CHAT_REPO_URL` | `https://github.com/sarakmacbook/anon-chat.git` | Git URL to install from |
| `ANON_CHAT_DIR` | `~/anon-chat` | Where the app source is cloned |
| `ANON_CHAT_DATA` | `~/anon-chat-data` | Where messages + uploads are stored (**back this up**) |
| `ANON_CHAT_PORT` | prompted (`3000`) | Public TCP port; set this to skip the prompt. On updates the prompt defaults to your previous port |
| `PRIVATE_PASSWORD` | built-in password | Password for #Private — **set this before putting the server on the internet** |

## 🐳 Docker (manual)

```bash
git clone https://github.com/sarakmacbook/anon-chat.git
cd anon-chat
docker compose up -d --build
# → http://localhost:3000
```

To store data in your own folder instead of the named volumes:

```yaml
volumes:
  - /path/to/anon-chat-data:/app/Data
  - /path/to/anon-chat-data/uploads:/tmp/chat-uploads
```

## ☁️ Deploy to Vercel

Anon Chat also runs on [Vercel](https://vercel.com) — no Docker, no VPS, HTTPS
included. The whole app, Socket.IO server and all, is deployed as a single
Express-backed Vercel Function on [Fluid compute](https://vercel.com/docs/fluid-compute),
which is what lets it hold WebSocket connections open. The UI in `public/` is
served from Vercel's CDN, and the server detects Vercel at runtime (`VERCEL=1`)
to keep its writable state in the instance-local `/tmp`, because the project
directory there is read-only.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/sarakmacbook/anon-chat)

### Option A — install from the dashboard (no tooling)

1. Click the **Deploy** button above, or [import the repo at vercel.com/new](https://vercel.com/new).
2. Leave the build settings untouched. `vercel.json` pins `"framework": "express"`
   and `"fluid": true`, so Vercel builds `server.js` into one function and serves
   `public/` statically — no build command, no output directory to configure.
3. Add your [environment variables](#environment-variables-on-vercel) (at minimum
   `PRIVATE_PASSWORD`), then hit **Deploy**.
4. Open the `*.vercel.app` URL — that is your chat.

### Option B — install and deploy with the Vercel CLI

```bash
# 1. Install the CLI (Node.js 18+; Vercel CLI 47+ is required for Express apps)
npm install -g vercel        # or: pnpm add -g vercel / brew install vercel-cli

# 2. Get the code and its dependencies
git clone https://github.com/sarakmacbook/anon-chat.git
cd anon-chat
npm install

# 3. Log in and link the folder to a Vercel project (creates ./.vercel)
vercel login
vercel link

# 4. Set your secrets (repeat per environment: production / preview / development)
vercel env add PRIVATE_PASSWORD production

# 5. Ship it
vercel deploy            # preview URL
vercel deploy --prod     # production URL
```

Run `vercel dev` for a local Vercel-like server on <http://localhost:3000>, or
`npm start` for plain Node.

Later updates: `git push` to the connected branch (or re-run `vercel deploy --prod`).

### Environment variables on Vercel

Set these in *Project → Settings → Environment Variables* (or with `vercel env add`):

| Variable | Needed? | Why |
|---|---|---|
| `PRIVATE_PASSWORD` | **Yes** | #Private room password. Without it the built-in default password is public knowledge, and passkeys are stored unencrypted |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | Recommended | Stable Web Push keys. Without them keys are generated per instance in `/tmp`, so push subscriptions break whenever an instance is recycled. Generate a pair with `npx web-push generate-vapid-keys` |
| `WEBAUTHN_RP_ID` | Only if needed | Host that passkeys are bound to, e.g. `chat.example.com`. Defaults to the request hostname — set it if you use a custom domain and want passkeys to survive a switch away from the `*.vercel.app` URL |
| `MAX_PRIVATE_UPLOAD_MB` | Optional | #Private upload cap in MB (Vercel default: 4; Pro plans can raise it toward the 100 MB body limit) |

Redeploy after changing environment variables — Vercel only applies them to new deployments.

### What works on Vercel

- The full app: #Public and #Private, passkeys, Web Push, file uploads, rate limits.
- Real-time chat over WebSockets. [WebSocket support on Vercel Functions](https://vercel.com/docs/functions/websockets)
  is in public beta and requires Fluid compute (default for projects created after
  23 April 2025; `vercel.json` sets `"fluid": true` explicitly). The client connects
  with the WebSocket transport first, since Socket.IO's HTTP long-polling fallback
  needs sticky sessions that serverless instances cannot provide — the server only
  accepts the WebSocket transport when it detects Vercel.
- HTTPS by default, so passkeys and Web Push work out of the box.

### Vercel-specific limitations

Vercel is a serverless platform, so compared to self-hosting:

- **Storage is ephemeral.** Message history, uploads, passkeys, and push
  subscriptions live in the function's instance-local `/tmp`. They persist while
  the instance is warm but are **lost when the instance scales to zero** (after
  being idle) or is recycled — expect chat history to reset from time to time.
  For durable storage, self-host.
- **Connections have a maximum lifetime.** A WebSocket closes when the function
  reaches its max duration — 300 s on every plan by default (Pro/Enterprise can
  raise it in *Project → Settings → Functions*). The client reconnects
  automatically; anyone who was in #Private is asked to unlock again.
- **Upload sizes are capped by the plan's request-body limit** — 4.5 MB on Hobby,
  100 MB on Pro — not by the app's 200 MB #Public limit.
- **Cold starts.** The first request after the function sleeps pays a short startup cost.
- **High concurrency.** Rooms are kept in memory and a connection is pinned to the
  instance that accepted it, so users on different instances would not see each
  other's messages. It works well for a small community on one warm instance; for a
  busy, heavily populated chat, self-host instead.

## 💻 Local development (no Docker)

```bash
npm install
node server.js
# → http://localhost:3000
```

All environment variables below work the same way, e.g. `PORT=8080 PRIVATE_PASSWORD=secret node server.js`.

## 🔐 The #Private room & passkeys

1. **First time:** enter the room password, then tap **➕ Save Passkey**. Creating a passkey always requires the password.
2. **After that:** tap **🔑 Unlock with Passkey** and use Face ID / Touch ID / Windows Hello. The resulting unlock token lasts 5 minutes.
3. **Server-side:** only *public* keys are stored (`Data/private/passkeys.json`) — the secrets never leave your device.

> ⚠️ Passkeys and Web Push require **HTTPS** (or `http://localhost` for local testing). Over plain `http://`, the room still works with the password, but the passkey/push buttons will tell you they're unavailable.

## 🔒 HTTPS (required for passkeys & push)

Put a TLS-terminating reverse proxy in front of the app.

**Caddy** (automatic Let's Encrypt certificates — easiest):

```
chat.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**Nginx** (WebSocket upgrade headers matter for Socket.IO):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
location /socket.io/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
}
```

Cloudflare Tunnel, Tailscale Funnel, or any other TLS proxy works too — as long as `X-Forwarded-Proto`/`X-Forwarded-Host` are passed through (the app trusts them to figure out its public origin). If your proxy rewrites the public origin, override it explicitly with `WEBAUTHN_ORIGIN`.

## ⚙️ Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the Node server listens on |
| `PRIVATE_PASSWORD` | built-in password | #Private room password (plaintext) |
| `PRIVATE_PASSWORD_HASH` | — | #Private room password as a SHA-256 hex string (takes precedence over `PRIVATE_PASSWORD`) |
| `WEBAUTHN_ORIGIN` | auto-detected from the request | Public origin used to verify passkeys, e.g. `https://chat.example.com` |
| `WEBAUTHN_RP_ID` | hostname | WebAuthn relying-party ID (usually your domain) |
| `WEBAUTHN_RP_NAME` | `Anon Chat` | Name shown when saving passkeys |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated on first run | Web Push keypair. Set both to keep push subscriptions valid across restarts/instances (`npx web-push generate-vapid-keys`) |
| `MAX_PRIVATE_UPLOAD_MB` | auto | #Private upload cap in MB (auto = free disk space self-hosted, 4 on Vercel) |
| `ANON_CHAT_DATA_DIR` | `./Data` (`/tmp/anon-chat/data` on Vercel) | Where message history, passkeys, and metadata are stored |

## 💾 Data & backups

Everything lives in one folder (`~/anon-chat-data` with the one-click installer, or the named Docker volumes with the stock compose file):

```
anon-chat-data/
├── public/
│   └── messages.json        # #Public history (latest 10,000 messages)
├── private/
│   ├── messages.json        # #Private history
│   └── passkeys.json        # passkey public keys
├── push-subscriptions.json  # Web Push subscriptions
├── uploads.json             # file metadata
└── uploads/
    ├── public/              # shared files (expire after 180 days)
    └── private/
```

Backing up is just `cp -r ~/anon-chat-data /backup/`. Restoring is putting the folder back and restarting.

## 🔁 Updating

Re-run the one-click command:

```bash
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash
```

…or manually: `git pull` in `~/anon-chat`, then rebuild and restart the container.

## 🗑️ Complete uninstall (Linux)

> **This permanently deletes all chat history, uploaded files, server-side passkey records,
> passwords/configuration, and the application source directory. Back up anything you want
> to keep first.** Run as the same user who installed Anon Chat; the uninstaller uses `sudo`
> only when needed, so you do not accidentally target root's home directory.

Preview exactly what will be removed, then run the interactive uninstall:

```bash
bash ~/anon-chat/uninstall.sh --dry-run
bash ~/anon-chat/uninstall.sh
# Type uninstall at the confirmation prompt to proceed. Any other answer cancels.
```

For an older installation without `uninstall.sh`, fetch it directly:

```bash
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/uninstall.sh | bash
```

The installer also exposes the same command, **without running any installation steps**:

```bash
bash install.sh --uninstall --dry-run
# Or fetch the installer and select uninstall:
curl -fsSL https://raw.githubusercontent.com/sarakmacbook/anon-chat/main/install.sh | bash -s -- --uninstall
```

### What gets removed

- This installation's Anon Chat containers, Compose-labelled app images, default network,
  and managed data/upload volumes (including stopped containers and leftover volumes).
- Bind-mounted data and uploads. Paths are discovered from the container, the new
  `.anon-chat-install` record, or the older installer's `docker-compose.deploy.yml`.
- The application directory, including `.env`, keys, local `Data/`, dependencies, and Git checkout.

**Docker itself, system packages, unrelated containers/volumes, and shared Docker build caches
are kept.** External/shared volumes are refused; Docker resources still in use by other
containers are never force-removed. A cleanup failure stops the uninstall rather than
silently deleting the source and reporting success. Home/system directories, symlinked
removal paths, and containers belonging to another checkout are also refused.

Manually configured reverse proxies, HTTPS certificates, DNS/tunnels, backups, browser
site data/notification permissions, and device-saved passkeys must be removed separately.
The server cannot erase data stored in visitors' browsers or password managers.

### Uninstall options

| Option / variable | Meaning |
|---|---|
| `--dry-run` | Inspect and print the removal plan without changing files or Docker resources |
| `--yes` / `-y` | Confirm permanent deletion without a prompt; required when there is no terminal |
| `--files-only` | Explicitly skip Docker cleanup, e.g. after Docker has already been removed; this is **not** a full Docker uninstall |
| `ANON_CHAT_DIR` | App directory; defaults to `~/anon-chat`, just like the installer |
| `ANON_CHAT_DATA` | Explicit data directory if deployment metadata is missing or cannot be read |
| `ANON_CHAT_PROJECT` | Custom Compose project name if neither the container nor the install record is available |

For a custom installation, specify the same application directory used at install time:

```bash
ANON_CHAT_DIR=/srv/anon-chat bash /srv/anon-chat/uninstall.sh --dry-run
# If data cannot be discovered, explicitly supply its location too:
ANON_CHAT_DIR=/srv/anon-chat ANON_CHAT_DATA=/srv/chat-data \
  bash /srv/anon-chat/uninstall.sh --yes
```

The uninstaller supports both the one-click install and the stock manual Compose setup,
without requiring the Compose plugin to still be installed. For edited Compose files with
complex mounts, keep the container (it may be stopped) so its actual mount paths can be
inspected. With no container, the fallback supports the shipped short-form volume syntax;
it refuses ambiguous configuration rather than guessing a deletion path.

For **local development without Docker**, stop `node server.js` first, then explicitly
include the local server's temporary upload directory:

```bash
# From your local Anon Chat checkout; this deletes the checkout too.
ANON_CHAT_DIR="$PWD" ANON_CHAT_DATA=/tmp/chat-uploads bash uninstall.sh --files-only
```

### Testing the uninstaller

```bash
npm test
```

Tests use disposable directories and a fake Docker CLI, never the real Docker daemon or
this checkout. They cover removal, confirmation, dry runs, custom paths/projects, named
volumes, installer dispatch, failure handling, and protection of unrelated files/resources.

## 🗂 Project structure

| File | What it does |
|---|---|
| `server.js` | Express + Socket.IO server: rooms, uploads, passkeys, Web Push |
| `public/index.html` | The entire UI (vanilla JS, dark theme, mobile-first) — served by Express locally, by the CDN on Vercel |
| `public/service-worker.js` | Web Push notification handler |
| `index.html`, `service-worker.js` | Root copies of the two files above, kept in sync |
| `vercel.json`, `.vercelignore` | Vercel deployment config (Express framework preset, Fluid compute) |
| `passkey-store.js` | JSON store for passkey public keys |
| `push-store.js` | JSON store for push subscriptions |
| `upload-store.js` | JSON store for uploaded-file metadata |
| `Dockerfile`, `docker-compose.yml` | Container build & run |
| `install.sh` | The one-click installer; also accepts `--uninstall` |
| `uninstall.sh` | Confirmed, scoped removal of Anon Chat and its stored data |
| `tests/` | Isolated uninstaller tests with a fake Docker CLI |

## 📄 License

ISC — see `package.json`.
