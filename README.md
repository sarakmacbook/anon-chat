# 💬 Anon Chat

Anonymous real-time chat you can host yourself. No accounts, no sign-up, no database — two rooms, a dark mobile-first UI, and files that clean themselves up.

- **#Public** — open to anyone: random anonymous nicknames (CoolPanda42), live messages, file sharing, built-in rate limiting.
- **#Private** — password-protected room. Unlock with a password **or a passkey** (iPhone Face ID / Touch ID, Windows Hello, Chrome passkeys), with **Web Push notifications** for every new message.

Built with Node.js, Express and Socket.IO. Ships as a Docker image and a single-file installer.

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

## 🗂 Project structure

| File | What it does |
|---|---|
| `server.js` | Express + Socket.IO server: rooms, uploads, passkeys, Web Push |
| `index.html` | The entire UI (vanilla JS, dark theme, mobile-first) |
| `service-worker.js` | Web Push notification handler |
| `passkey-store.js` | JSON store for passkey public keys |
| `push-store.js` | JSON store for push subscriptions |
| `upload-store.js` | JSON store for uploaded-file metadata |
| `Dockerfile`, `docker-compose.yml` | Container build & run |
| `install.sh` | The one-click installer (this README's hero) |

## 📄 License

ISC — see `package.json`.
