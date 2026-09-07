// ──────────────────────────────────────────────────────────────────────────────
//  WebAuthn / passkey credential store for the #Private room.
//
//  Only public keys and metadata are stored; the actual passkey lives on the
//  user's device / iCloud / Google account.
//
//  When an encryption key is configured, sensitive credential fields
//  (publicKey) are encrypted at rest with AES-256-GCM before writing to disk.
// ──────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const vault = require('./crypto-vault');

const DATA_DIR = path.join(__dirname, 'Data');
const DATA_PRIVATE_DIR = path.join(DATA_DIR, 'private');
const DATA_FILE = path.join(DATA_PRIVATE_DIR, 'passkeys.json');

let encryptionKey = null;

/**
 * Set the AES-256-GCM encryption key (Buffer, 32 bytes).
 * Must be called before load/save if encryption is desired.
 */
function setEncryptionKey(key) {
  encryptionKey = key;
}

/**
 * Get the current encryption key (Buffer or null).
 */
function getEncryptionKey() {
  return encryptionKey;
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_PRIVATE_DIR, { recursive: true }); } catch {}
}

// ── Encryption helpers ────────────────────────────────────────────────────────

function encryptField(value) {
  if (!encryptionKey || !value) return value;
  // Don't double-encrypt
  if (vault.isEncrypted(value)) return value;
  return vault.encryptString(value, encryptionKey);
}

function decryptField(value) {
  if (!encryptionKey || !value) return value;
  if (!vault.isEncrypted(value)) return value;     // stored unencrypted (migration)
  return vault.decryptString(value, encryptionKey) || value;
}

function encryptCredential(credential) {
  if (!encryptionKey) return credential;
  return {
    ...credential,
    publicKey: encryptField(credential.publicKey),
    encrypted: true,
  };
}

function decryptCredential(credential) {
  if (!encryptionKey) return credential;
  return {
    ...credential,
    publicKey: decryptField(credential.publicKey),
  };
}

// ── Store I/O ─────────────────────────────────────────────────────────────────

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw)) return { version: 2, credentials: raw };
    return { version: 2, credentials: Array.isArray(raw.credentials) ? raw.credentials : [] };
  } catch {
    return { version: 2, credentials: [] };
  }
}

function saveStore(store) {
  ensureDataDir();
  // Encrypt sensitive fields before writing
  const encrypted = store.credentials.map(encryptCredential);
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 2, credentials: encrypted }, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────────

function getAll() {
  const store = loadStore();
  // Decrypt sensitive fields after reading
  return store.credentials.map(decryptCredential);
}

function get(id) {
  const all = getAll();
  return all.find(credential => credential.id === id) || null;
}

function add(credential) {
  const store = loadStore();
  const existingIndex = store.credentials.findIndex(item => item.id === credential.id);
  const now = Date.now();
  const record = {
    ...credential,
    createdAt: credential.createdAt || now,
    lastUsedAt: credential.lastUsedAt || null,
  };
  if (existingIndex >= 0) {
    store.credentials[existingIndex] = { ...store.credentials[existingIndex], ...record };
  } else {
    store.credentials.push(record);
  }
  saveStore(store);
  return record;
}

function update(id, patch) {
  const store = loadStore();
  const index = store.credentials.findIndex(item => item.id === id);
  if (index < 0) return null;
  store.credentials[index] = { ...store.credentials[index], ...patch };
  saveStore(store);
  return store.credentials[index];
}

function remove(id) {
  const store = loadStore();
  const nextCredentials = store.credentials.filter(item => item.id !== id);
  if (nextCredentials.length === store.credentials.length) return false;
  store.credentials = nextCredentials;
  saveStore(store);
  return true;
}

module.exports = {
  getAll,
  get,
  add,
  update,
  remove,
  setEncryptionKey,
  getEncryptionKey,
};
