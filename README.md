# Anon Chat

Anonymous chat with file sharing, built with Node.js + Socket.IO.

## Quick Install

```bash
cd deploy-anon-chat
./install.sh
```

## Manual Install

```bash
docker compose up -d --build
```

## Access

Open `http://YOUR_SERVER_IP:3000` in browser.

## Files

- `server.js` — main server
- `upload-store.js` — file storage (JSON-based)
- `public/index.html` — chat UI
- `Dockerfile` — container definition
- `docker-compose.yml` — orchestration

## Features

- #Public and #Private rooms
- Private room password: `321`
- Photo & file upload
- Custom display names
- Anti-spam protection
- Messages persist forever
- Files expire after 6 months

## Config

Edit `server.js` and rebuild container:
- `PRIVATE_PASSWORD` — private room password
- `FILE_EXPIRY` — file auto-delete (ms)
- `RATE_LIMIT` — anti-spam settings
