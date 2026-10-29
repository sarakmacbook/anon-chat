/**
 * Credential + session store for Anon Chat.
 *
 * Threat model
 * ------------
 * The browser never sends a password. It runs Argon2id (libsodium, 64 MiB,
 * t=2) locally and sends the 256 bit *verifier* instead. This module then
 * stretches that verifier again with scrypt (N=32768, r=8, p=1) under a fresh
 * random salt before it touches disk, so:
 *
 *   - a stolen `security.json` costs an attacker scrypt *and* Argon2id per guess;
 *   - a captured login only reveals a verifier that cannot be turned into the
 *     private room key (different KDF subkey, and the room key never leaves the
 *     browser at all);
 *   - comparisons are constant time, so there is no timing oracle on the hash.
 *
 * Sessions are stateless HMAC-SHA256 tokens signed with a random per-install
 * key (`session-secret.key`, mode 0600). Changing a password bumps
 * `sessionVersion`, which invalidates every issued token at once.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

// Lives inside Data/private so it survives both docker-compose layouts
// (named volume on /app/Data, and the bind mounts created by install.sh).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'Data');
const SECURE_DIR = path.join(DATA_DIR, 'private');
const CONFIG_FILE = path.join(SECURE_DIR, 'security.json');
const SECRET_FILE = path.join(SECURE_DIR, 'session-secret.key');
const AUDIT_FILE = path.join(SECURE_DIR, 'admin-audit.jsonl');

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };
const SCRYPT_LABEL = 'scrypt$N=' + SCRYPT_PARAMS.N + '$r=' + SCRYPT_PARAMS.r + '$p=' + SCRYPT_PARAMS.p;
const VERIFIER_RE = /^[0-9a-f]{64}$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const TOKEN_VERSION = 'v1';
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

const TOKEN_TTL_MS = (() => {
  const hours = Number(process.env.ADMIN_TOKEN_TTL_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 3600 * 1000 : 12 * 3600 * 1000;
})();

const CLIENT_KDF = Object.freeze({
  algorithm: 'argon2id',
  opslimit: 2,             // libsodium OPSLIMIT_INTERACTIVE
  memlimit: 67108864,      // libsodium MEMLIMIT_INTERACTIVE (64 MiB)
  outputBytes: 32
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ------------------------------------------------------------ file helpers */

function ensureDirs() {
  for (const dir of [DATA_DIR, SECURE_DIR, path.join(DATA_DIR, 'public')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function writePrivateFile(file, contents) {
  ensureDirs();
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) { /* filesystem may not support chmod */ }
  fs.renameSync(tmp, file);
}

/**
 * The config can legitimately be half populated: `scripts/reset-admin.js`
 * drops only `admin` so a locked out owner can create a new one without
 * destroying the private room key (and with it every encrypted message).
 */
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (_) {
    return null;
  }
}

function saveConfig(cfg) {
  cfg.updatedAt = Date.now();
  writePrivateFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ------------------------------------------------------------- secret key */

let cachedSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;
  ensureDirs();
  try {
    const buf = fs.readFileSync(SECRET_FILE);
    if (buf.length === 32) { cachedSecret = buf; return cachedSecret; }
  } catch (_) { /* first run */ }
  const fresh = crypto.randomBytes(32);
  writePrivateFile(SECRET_FILE, fresh);
  cachedSecret = fresh;
  return cachedSecret;
}

/* ---------------------------------------------------------------- hashing */

function isVerifier(value) {
  return typeof value === 'string' && VERIFIER_RE.test(value);
}

function isUsername(value) {
  return typeof value === 'string' && USERNAME_RE.test(value);
}

/**
 * Normalise a KDF salt to unpadded base64url, the alphabet libsodium uses in
 * the browser. Storing standard base64 instead would hand the client a string
 * its own decoder refuses to read.
 */
function normalizeSalt(value) {
  if (typeof value !== 'string' || !value.length) return null;
  let buf = null;
  try { buf = Buffer.from(value, 'base64'); } catch (_) { return null; }
  if (!buf || buf.length !== 16) return null;
  return buf.toString('base64url');
}

/**
 * scrypt the client side verifier. Returns { kdf, vSalt, vHash } all base64.
 * `vSalt`/`vHash` are named apart from the room's public Argon2 `salt` on
 * purpose — spreading a generic { salt, hash } record used to clobber it.
 */
async function hashVerifier(verifier) {
  if (!isVerifier(verifier)) throw httpError(400, 'Malformed verifier');
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(Buffer.from(verifier, 'hex'), salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem
  });
  return { kdf: SCRYPT_LABEL, vSalt: salt.toString('base64'), vHash: derived.toString('base64') };
}

/** Async on purpose: scrypt at N=32768 would otherwise stall the event loop. */
async function verifyVerifier(verifier, record) {
  if (!isVerifier(verifier) || !record || !record.vSalt || !record.vHash) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(record.vSalt, 'base64');
    expected = Buffer.from(record.vHash, 'base64');
  } catch (_) {
    return false;
  }
  const derived = await scryptAsync(Buffer.from(verifier, 'hex'), salt, expected.length, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_PARAMS.maxmem
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/* ----------------------------------------------------------------- tokens */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', getSecret()).update(payloadB64).digest());
}

/** Mint an admin session token. */
function issueToken(username, cfg) {
  const config = cfg || loadConfig();
  const now = Date.now();
  const payload = {
    sub: username,
    role: 'admin',
    sv: (config && config.sessionVersion) || 1,
    iat: now,
    exp: now + TOKEN_TTL_MS
  };
  const body = b64url(JSON.stringify(payload));
  return { token: TOKEN_VERSION + '.' + body + '.' + sign(body), payload, expiresIn: TOKEN_TTL_MS };
}

/** Verify an admin session token. Returns the payload or null. */
function verifyToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(sign(parts[1]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(unb64url(parts[1]).toString('utf8')); } catch (_) { return null; }
  if (!payload || payload.role !== 'admin' || typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;
  const cfg = loadConfig();
  if (!cfg || !cfg.admin) return null;
  if (payload.sv !== cfg.sessionVersion) return null;      // credentials changed → sessions dead
  if (payload.sub !== cfg.admin.username) return null;      // account renamed
  return payload;
}

/* -------------------------------------------------------------- lifecycle */

function hasAdmin() {
  const cfg = loadConfig();
  return Boolean(cfg && cfg.admin && cfg.admin.username && cfg.admin.vHash);
}

function hasRoom() {
  const cfg = loadConfig();
  return Boolean(cfg && cfg.room && cfg.room.salt && cfg.room.vHash);
}

function isSetup() {
  return hasAdmin() && hasRoom();
}

/** What the browser needs before it can derive anything. */
function bootstrap() {
  const cfg = loadConfig();
  const admin = hasAdmin();
  const room = hasRoom();
  return {
    setupRequired: !(admin && room),
    needAdmin: !admin,
    needRoom: !room,
    serverKdf: SCRYPT_LABEL,
    clientKdf: CLIENT_KDF,
    tokenTtlMs: TOKEN_TTL_MS,
    room: room ? { kid: cfg.room.kid, salt: cfg.room.salt, updatedAt: cfg.room.updatedAt } : null,
    createdAt: cfg ? cfg.createdAt : null
  };
}

/**
 * First run (or after an admin reset): create whichever credentials are
 * missing. Every secret arrives as a client side Argon2id verifier.
 */
async function createSetup({ adminUsername, adminVerifier, roomVerifier, roomSalt }) {
  if (hasAdmin() && hasRoom()) throw httpError(409, 'Already configured');
  const needAdmin = !hasAdmin();
  const needRoom = !hasRoom();

  if (needAdmin) {
    if (!isUsername(adminUsername)) {
      throw httpError(400, 'Username must be 3-32 characters: letters, digits, dot, underscore, dash');
    }
    if (!isVerifier(adminVerifier)) throw httpError(400, 'Malformed admin verifier');
  }
  let salt = null;
  if (needRoom) {
    if (!isVerifier(roomVerifier)) throw httpError(400, 'Malformed room verifier');
    salt = normalizeSalt(roomSalt);
    if (!salt) throw httpError(400, 'Room salt must be 16 bytes of base64');
  }

  ensureDirs();
  getSecret();
  const now = Date.now();
  const cfg = loadConfig() || {};
  cfg.version = cfg.version || 1;
  cfg.createdAt = cfg.createdAt || now;
  // A fresh setup invalidates every token minted before it.
  cfg.sessionVersion = (cfg.sessionVersion || 0) + 1;
  cfg.serverKdf = SCRYPT_LABEL;
  cfg.clientKdf = CLIENT_KDF;

  if (needAdmin) {
    const admin = await hashVerifier(adminVerifier);
    cfg.admin = { username: adminUsername, ...admin, createdAt: now, updatedAt: now };
  }
  if (needRoom) {
    const room = await hashVerifier(roomVerifier);
    cfg.room = { kid: 1, salt, ...room, updatedAt: now };
  }
  saveConfig(cfg);
  audit({
    action: needRoom ? 'setup' : 'admin-recreated',
    actor: cfg.admin.username,
    detail: needRoom ? 'initial configuration created' : 'admin replaced, private room key kept'
  });
  return cfg;
}

async function verifyAdmin(username, verifier) {
  const cfg = loadConfig();
  if (!cfg || !cfg.admin) return { ok: false, reason: 'not-configured' };
  const known = String(cfg.admin.username);
  if (typeof username !== 'string' || username.trim().toLowerCase() !== known.toLowerCase()) {
    // Burn one scrypt anyway so a wrong username costs the same as a wrong password.
    await verifyVerifier(isVerifier(verifier) ? verifier : '0'.repeat(64), cfg.admin);
    return { ok: false, reason: 'bad-credentials', username: known };
  }
  const ok = await verifyVerifier(verifier, cfg.admin);
  return ok ? { ok: true, username: known } : { ok: false, reason: 'bad-credentials', username: known };
}

async function verifyRoom(verifier) {
  const cfg = loadConfig();
  if (!cfg || !cfg.room) return false;
  return verifyVerifier(verifier, cfg.room);
}

function roomInfo() {
  const cfg = loadConfig();
  return cfg && cfg.room ? { kid: cfg.room.kid, salt: cfg.room.salt } : null;
}

/**
 * Rotate the private room passphrase. Bumps `kid` so messages sealed with the
 * previous key are recognisable — and stay unreadable on purpose, because
 * rotating is exactly how you revoke access from someone who left.
 */
async function rotateRoom({ roomVerifier, roomSalt }) {
  const cfg = loadConfig();
  if (!cfg || !cfg.room) throw httpError(409, 'Not configured');
  if (!isVerifier(roomVerifier)) throw httpError(400, 'Malformed verifier');
  const salt = normalizeSalt(roomSalt);
  if (!salt) throw httpError(400, 'Room salt must be 16 bytes of base64');
  const record = await hashVerifier(roomVerifier);
  cfg.room = { kid: (cfg.room.kid || 1) + 1, salt, ...record, updatedAt: Date.now() };
  saveConfig(cfg);
  audit({ action: 'room-key-rotated', actor: cfg.admin ? cfg.admin.username : null, detail: 'kid=' + cfg.room.kid });
  return { kid: cfg.room.kid, salt: cfg.room.salt };
}

/** Replace the admin credentials and kill every live session. */
async function changeAdmin({ username, adminVerifier }) {
  const cfg = loadConfig();
  if (!cfg || !cfg.admin) throw httpError(409, 'Not configured');
  if (!isUsername(username)) throw httpError(400, 'Invalid username');
  if (!isVerifier(adminVerifier)) throw httpError(400, 'Malformed verifier');
  const record = await hashVerifier(adminVerifier);
  cfg.admin = { username, ...record, createdAt: cfg.admin.createdAt, updatedAt: Date.now() };
  cfg.sessionVersion = (cfg.sessionVersion || 1) + 1;
  saveConfig(cfg);
  audit({ action: 'admin-credentials-changed', actor: username });
  return cfg;
}

function adminUsername() {
  const cfg = loadConfig();
  return cfg && cfg.admin ? cfg.admin.username : null;
}

/**
 * Drop the admin credentials only. The private room key — and therefore every
 * encrypted message — survives, and the wizard asks for a new admin.
 */
function clearAdmin() {
  const cfg = loadConfig();
  if (!cfg || !cfg.admin) return false;
  const who = cfg.admin.username;
  delete cfg.admin;
  cfg.sessionVersion = (cfg.sessionVersion || 1) + 1;
  saveConfig(cfg);
  audit({ action: 'admin-cleared', actor: 'cli', detail: who });
  return true;
}

/** Drop the private room key. Every message sealed with it becomes unreadable. */
function clearRoom() {
  const cfg = loadConfig();
  if (!cfg || !cfg.room) return false;
  delete cfg.room;
  cfg.sessionVersion = (cfg.sessionVersion || 1) + 1;
  saveConfig(cfg);
  audit({ action: 'room-key-cleared', actor: 'cli' });
  return true;
}

/* ------------------------------------------------------------------ audit */

function audit({ action, actor, detail, room, id, ip }) {
  try {
    ensureDirs();
    const entry = {
      ts: new Date().toISOString(),
      action: String(action || 'unknown'),
      actor: actor ? String(actor) : null,
      room: room || null,
      id: id || null,
      detail: detail || null,
      ip: ip || null
    };
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
      fs.writeFileSync(AUDIT_FILE, lines.slice(-2000).join('\n') + '\n');
    }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('audit write failed:', err.message);
  }
}

function readAudit(limit) {
  try {
    const max = Math.max(1, Math.min(1000, Number(limit) || 100));
    return fs.readFileSync(AUDIT_FILE, 'utf8')
      .trim().split('\n').filter(Boolean)
      .slice(-max)
      .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (_) {
    return [];
  }
}

/** Factory reset: forget every credential. Message history is left alone. */
function resetSetup() {
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  if (fs.existsSync(SECRET_FILE)) fs.unlinkSync(SECRET_FILE);
  cachedSecret = null;
  audit({ action: 'setup-reset', actor: 'cli' });
}

module.exports = {
  CONFIG_FILE,
  SECRET_FILE,
  AUDIT_FILE,
  SCRYPT_LABEL,
  CLIENT_KDF,
  TOKEN_TTL_MS,
  ensureDirs,
  isSetup,
  hasAdmin,
  hasRoom,
  bootstrap,
  createSetup,
  verifyAdmin,
  verifyRoom,
  roomInfo,
  rotateRoom,
  changeAdmin,
  clearAdmin,
  clearRoom,
  adminUsername,
  issueToken,
  verifyToken,
  isVerifier,
  isUsername,
  normalizeSalt,
  audit,
  readAudit,
  resetSetup
};
