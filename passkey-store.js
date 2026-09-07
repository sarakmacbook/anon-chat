// WebAuthn/passkey credential store for the #Private room.
// Only public keys and metadata are stored; passkeys themselves stay on the user's device/account.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'Data');
const DATA_PRIVATE_DIR = path.join(DATA_DIR, 'private');
const DATA_FILE = path.join(DATA_PRIVATE_DIR, 'passkeys.json');

function ensureDataDir() {
  try { fs.mkdirSync(DATA_PRIVATE_DIR, { recursive: true }); } catch {}
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw)) return { version: 1, credentials: raw };
    return { version: 1, credentials: Array.isArray(raw.credentials) ? raw.credentials : [] };
  } catch {
    return { version: 1, credentials: [] };
  }
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify({ version: 1, credentials: store.credentials }, null, 2));
}

function getAll() {
  return loadStore().credentials;
}

function get(id) {
  return getAll().find(credential => credential.id === id) || null;
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
  if (existingIndex >= 0) store.credentials[existingIndex] = { ...store.credentials[existingIndex], ...record };
  else store.credentials.push(record);
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

module.exports = { getAll, get, add, update, remove };
