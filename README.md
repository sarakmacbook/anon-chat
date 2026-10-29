# Anon Chat

Anonymous chat with file sharing, an **end-to-end encrypted private room** and
**admin moderation** (remove any message). Node.js + Express + Socket.IO, no
database, no build step.

```
┌─────────────┐   Argon2id    ┌──────────────┐   XChaCha20-Poly1305   ┌────────┐
│ passphrase  │ ────────────▶ │  room key    │ ─────────────────────▶ │ sealed │ ──▶ server
│ (in browser)│   64 MiB, t=2 │ (never sent) │   per message / chunk  │ bytes  │    stores
└─────────────┘               └──────────────┘                        └────────┘    ciphertext
```

The server never sees a password, a passphrase, a key, or the contents of a
private message. It stores ciphertext and metadata (who, when) and nothing else.

---

## Quick install

```bash
./install.sh          # Docker + persistent folders, picked interactively
```

or by hand:

```bash
docker compose up -d --build
# … or without Docker:
npm install --omit=dev && npm start
```

Then open `http://YOUR_SERVER_IP:3000`.

## First run: the setup wizard

The first page load has no credentials yet, so the site asks you to create them.
There is no default password and nothing to edit in the source.

1. **Admin account** — username + password. The admin is the only role that can
   remove chat messages, in either room.
2. **#Private room passphrase** — this *is* the encryption key for the private
   room. Tap 🎲 **Generate** for a 6-word, ~250 bit passphrase.
3. **Save it** — the passphrase is shown exactly once. Copy it somewhere safe.

Both are stretched with Argon2id **in your browser**; only a 256 bit verifier is
sent, and the server hashes that again with scrypt before writing it to disk.

> ⚠️ **The private room passphrase cannot be recovered.** Not by you, not by the
> admin, not by the server — the server never had it. Lose it and every private
> message stays encrypted forever. Losing the *admin* password is recoverable
> (see [Locked out?](#locked-out)).

---

## Features

**Rooms**
- `#Public` — open, plain text, rate limited (10 messages / 30 s, 5 uploads / 5 min, spam detection).
- `#Private` 🔒 — passphrase gated and end-to-end encrypted, including files.

**Admin** (🛡️ button in the header)
- Remove any single message from either room — the 🗑 button on each bubble. Attached files are deleted from disk with it.
- Moderation list per room with one-click delete, plus *clear room history*.
- Delete unencrypted messages left behind by an older version.
- Change the admin username/password (invalidates every live session).
- Rotate the private room key (revokes access from anyone who had the old passphrase).
- Audit log of every admin action.
- Enter `#Private` without the passphrase in **moderation mode**: you can delete, but you still cannot read — that is the point of E2EE.

**Everything else**
- Photo & file upload with real progress (encrypted in-browser first for `#Private`).
- Custom display names, random anonymous alias on arrival.
- Web push notifications for `#Private` (the payload says only "🔒 Encrypted message from …" — never the content).
- Messages persist forever (10 000 per room in memory), files expire after 6 months.

---

## Security model

### Passwords and passphrases

| step | where | what |
| ---- | ----- | ---- |
| 1 | browser | Argon2id (libsodium, 64 MiB, t=2, 256 bit output) with a per-account salt |
| 2 | browser | BLAKE2b KDF splits the master into domain-separated subkeys: `1` = room encryption key, `2` = room login verifier, `3` = admin login verifier |
| 3 | network | only the verifier travels (never the password, never the room key) |
| 4 | server | scrypt (`N=32768, r=8, p=1`, 64 byte output) under a fresh random salt, written to `Data/private/security.json` with mode `0600` |
| 5 | server | comparison is `crypto.timingSafeEqual`; a wrong username still burns one scrypt so the response time does not leak which half was wrong |

Cracking a stolen `security.json` therefore costs an attacker scrypt **and**
Argon2id per guess.

### Private room messages

- Cipher: **XChaCha20-Poly1305** (AEAD, 256 bit key, random 24 byte nonce per message — no nonce reuse is possible).
- Stored record: `{ id, username, time, room, kid, c, n, file? }` — no `text`, no `ip`.
- Files: sealed with **secretstream XChaCha20-Poly1305** in 1 MiB chunks, so a truncated, reordered or edited file fails authentication instead of half-decrypting, and multi-GB uploads never sit in memory at once. Private files are stored as `<uuid>.bin` and their real name/MIME type stay inside the encrypted envelope.
- Key id (`kid`): rotating the passphrase bumps it. Messages sealed with an older key are shown as 🔒 locked rather than silently failing.

### Sessions

Admin sessions are stateless `v1.<payload>.<hmac-sha256>` tokens signed with a
random per-install key (`Data/private/session-secret.key`, `0600`), 12 h lifetime
by default. Changing the admin password bumps `sessionVersion`, which kills every
issued token immediately. Tokens live in `localStorage`; the derived room key
lives in `sessionStorage` for the current tab only (so a refresh does not ask
again) and is wiped by the **Lock** button.

### Brute force

5 failed admin logins or 5 wrong room passphrases from one IP ⇒ 15 minute
lockout. All mutating endpoints reject cross-origin requests.

### What is *not* protected

Being honest about the limits matters more than the marketing:

- **Metadata is visible to the server**: who posted, when, how often, whether a
  message had an attachment, and the IP address for `#Public`. Private room
  messages store no IP.
- **Everyone with the passphrase can read the room.** It is a shared-secret
  room, not per-user keying — there is no forward secrecy against a member who
  wrote the messages down. Rotate the key to evict someone.
- **A compromised browser is game over**, as with any E2EE scheme: the key is in
  memory while the room is unlocked.
- **Push notifications travel through third-party servers**, so they carry no
  content — only "🔒 Encrypted message from <alias>".
- **Serve it over HTTPS.** Without TLS someone on the path can read `#Public`
  and could try to swap the page's JavaScript. (Encryption of `#Private` still
  works over plain HTTP — that is why libsodium is vendored instead of using
  WebCrypto, which browsers only expose in a secure context — but TLS is strongly
  recommended, and required for web push.)

---

## Locked out?

```bash
# inside the container
docker exec -it anon-chat node scripts/reset-admin.js

# or on a bare-metal install
node scripts/reset-admin.js
```

That forgets the **admin account only** and keeps the private room key, so the
website asks you to create a new admin and every encrypted message stays
readable. Extra flags, both of which ask for a typed confirmation:

```bash
node scripts/reset-admin.js --room   # also forget the private room key (history becomes unreadable)
node scripts/reset-admin.js --all    # forget everything, back to a first-run server
```

Chat history and uploaded files are never touched by this script.

---

## HTTP API

| method | path | auth | purpose |
| ------ | ---- | ---- | ------- |
| GET | `/api/bootstrap` | — | is setup needed? room key id + salt, KDF parameters |
| POST | `/api/setup` | — (only while unconfigured) | create admin and/or room key from verifiers |
| POST | `/api/admin/login` | — | exchange an admin verifier for a session token |
| POST | `/api/admin/logout` | admin | audit the sign-out |
| GET | `/api/admin/status` | admin | who am I, when does the session end |
| GET | `/api/admin/stats` | admin | counters, KDF parameters, legacy message count |
| GET | `/api/admin/messages/:room` | admin | message **metadata** (never private content) |
| DELETE | `/api/admin/messages/:room/:id` | admin | remove one message + its file |
| DELETE | `/api/admin/messages/:room` | admin | purge a room |
| DELETE | `/api/admin/legacy` | admin | drop private messages stored in clear text by an old build |
| POST | `/api/admin/password` | admin | change admin username/password |
| POST | `/api/admin/room/rotate` | admin | rotate the private room key |
| GET | `/api/admin/audit` | admin | recent admin activity |
| POST | `/upload` | — | multipart upload (`room` field first!) |
| GET | `/limits`, `/vapid-public-key`, `/file/:id` | — | upload limits, push key, file redirect |

## Socket.IO events

| direction | event | notes |
| --------- | ----- | ----- |
| ← | `welcome` | random alias, `setupRequired` |
| → | `admin-auth {token}` | upgrades this socket to admin |
| ← | `admin-state {isAdmin, username, expiresAt}` | |
| → | `set-name {name}` | |
| → | `join-room {room, verifier?}` | `verifier` required for `#Private` unless you are an admin (moderation mode) |
| ← | `room-joined {room, users, messages, kid, moderationOnly}` | |
| → | `message {room, text, file}` | public room |
| → | `message {room, enc:{c,n}, kid, file:{id,url}}` | private room — sealed envelope |
| ← | `message`, `message-deleted`, `room-purged`, `room-key-changed`, `user-joined`, `user-left`, `user-renamed`, `error-msg` | |
| → | `delete-message {room, id}` | **admin only** |

---

## Configuration

Environment variables:

| variable | default | meaning |
| -------- | ------- | ------- |
| `PORT` | `3000` | listen port (`0` = pick a free one) |
| `DATA_DIR` | `./Data` | chats, credentials, keys |
| `UPLOAD_DIR` | `/tmp/chat-uploads` | uploaded files |
| `ADMIN_TOKEN_TTL_HOURS` | `12` | admin session lifetime |

In `server.js`: `FILE_EXPIRY` (6 months), `MAX_PUBLIC_MB` (200),
`MAX_PUBLIC_TEXT` (4000), `RATE_LIMIT`, `AUTH_LIMIT` (5 attempts / 15 min
lockout), `HISTORY_LIMIT` (100), `MAX_STORED_MESSAGES` (10 000).

## Files

```
server.js               HTTP + Socket.IO server, moderation, uploads, push
auth-store.js           credentials, scrypt hashing, HMAC sessions, audit log
upload-store.js         file metadata (delete aware, tagged per room)
push-store.js           web push subscriptions
scripts/reset-admin.js  emergency credential recovery
public/index.html       UI
public/js/app.js        client: rooms, rendering, admin panel, setup wizard
public/js/crypto.mjs    client crypto: Argon2id, XChaCha20-Poly1305, chunked files
public/vendor/          libsodium.js 0.8.4 (sumo, ESM) — see its README
tests/                  crypto, protocol and jsdom UI tests
Data/                   created at runtime (gitignored) — back this up
```

## Tests

```bash
npm test
```

44 tests, no mocks:

- `tests/crypto.test.mjs` — Argon2id determinism, key separation, AEAD round
  trips, chunked file sealing, rejection of tampering/truncation/wrong keys.
- `tests/server.test.mjs` — boots the real server, then walks setup → login →
  encrypted messaging → admin deletion → key rotation → lockout, asserting at
  every step what the server must *not* know.
- `tests/ui.test.mjs` — loads the real page in jsdom and drives the wizard, the
  private room and the 🗑 button with actual DOM events.

---

## Upgrading from 1.x

Breaking, on purpose:

- The hardcoded private room password (`321`, stored as a bare SHA-256) is gone.
  Run the setup wizard once after upgrading.
- Private messages written by 1.x are plain text on disk. They are still
  displayed, flagged as legacy, counted in the admin panel, and can be removed
  in one click (**Admin panel → Moderate → Delete unencrypted legacy private
  messages**).
- `install.sh` now mounts a single data root (`…/anon-chat/data` and
  `…/anon-chat/uploads`) so `Data/private/security.json` survives a rebuild.
  If you keep the old two-folder mounts, move them under one `data/` folder.
- `.vapidkeys` moved to `Data/vapid-keys.json`; existing push subscriptions
  need to be re-enabled once.
- The stale root-level copies of `index.html` and `service-worker.js` were
  removed — `public/` is the only copy the server serves.
