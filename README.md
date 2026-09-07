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
- #Private can be unlocked with saved passkeys after first password setup
  - Works with iPhone Face ID/Touch ID + iCloud Keychain passkeys
  - Works with Google Chrome / Google Password Manager passkeys
  - Requires HTTPS in production (or `http://localhost` for local testing)
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
- `WEBAUTHN_RP_NAME` — display name shown by passkey prompts (default: `Anon Chat`)
- `WEBAUTHN_RP_ID` — passkey relying-party domain override, useful behind a reverse proxy
- `WEBAUTHN_ORIGIN` — public site origin override, e.g. `https://chat.example.com`

Passkeys are domain-bound and tied to the current private password hash. If you change domains or rotate the private password, users need to save a new passkey.
