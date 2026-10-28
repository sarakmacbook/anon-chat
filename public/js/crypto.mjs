/**
 * Anon Chat — client side cryptography.
 *
 * Everything sensitive happens here, in the browser. The server never sees a
 * password, a passphrase, an encryption key or a private room message.
 *
 *   password/passphrase
 *        │  Argon2id (libsodium crypto_pwhash, memory hard)
 *        ▼
 *     master (32B)
 *        │  BLAKE2B KDF (crypto_kdf_derive_from_key) — domain separated
 *        ├──▶ subkey 1 → room encryption key   (AES-class AEAD)
 *        ├──▶ subkey 2 → room auth verifier    (sent to server, hashed again there)
 *        └──▶ subkey 3 → admin auth verifier   (sent to server, hashed again there)
 *
 * Messages are sealed with XChaCha20-Poly1305 (AEAD, random 24 byte nonce per
 * message). Files are sealed with the secretstream variant of the same cipher,
 * 1 MiB chunk at a time, so multi gigabyte uploads never land in memory at once
 * and a truncated / reordered file fails authentication.
 *
 * This module is plain ESM with no DOM access so it also runs under Node for
 * `npm test`.
 */
import sodium from '../vendor/libsodium-wrappers.mjs';

export const PROTOCOL = Object.freeze({
  version: 1,
  kdf: 'argon2id',
  kdfContextRoom: 'AnonRoom',
  kdfContextAdmin: 'AnonAdm1',
  subkeyRoomEncryption: 1,
  subkeyRoomVerifier: 2,
  subkeyAdminVerifier: 3,
  aead: 'xchacha20poly1305-ietf',
  fileMagic: 'ANONENC1'
});

/** Files are sealed/unsealed in chunks of this size. Bump only with a new magic. */
export const FILE_CHUNK_SIZE = 1024 * 1024;
/** Images up to this size are decrypted inline without a tap. */
export const AUTO_DECRYPT_MAX_BYTES = 32 * 1024 * 1024;
/** Above this we ask before pulling a whole file into the tab. */
export const DECRYPT_CONFIRM_BYTES = 512 * 1024 * 1024;

const B64 = sodium.base64_variants ? sodium.base64_variants.URLSAFE_NO_PADDING : null;

let readyPromise = null;

/**
 * Resolves once libsodium is initialised. Safe to call repeatedly; the wasm
 * module is only loaded once.
 */
export function cryptoReady() {
  if (!readyPromise) {
    readyPromise = Promise.resolve(sodium.ready).then(() => {
      if (!sodium.crypto_pwhash) {
        throw new Error('This libsodium build has no Argon2 support');
      }
      return sodium;
    });
  }
  return readyPromise;
}

/** KDF cost actually used. Exposed so the UI and the server can report it. */
export function kdfParams() {
  return {
    algorithm: 'argon2id',
    opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    outputBytes: 32
  };
}

/* ------------------------------------------------------------------ utils */

export function randomBytes(n) {
  return sodium.randombytes_buf(n);
}

export function toB64(bytes) {
  return sodium.to_base64(bytes, B64);
}

export function fromB64(str) {
  return sodium.from_base64(str, B64);
}

export function toHex(bytes) {
  return sodium.to_hex(bytes);
}

export function wipe(bytes) {
  try {
    if (bytes) sodium.memzero(bytes);
  } catch (_) {
    /* read-only or shared buffer — nothing we can do */
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------ key schedule */

function argon2(secret, salt) {
  if (!(salt instanceof Uint8Array) || salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new Error('KDF salt must be ' + sodium.crypto_pwhash_SALTBYTES + ' bytes');
  }
  return sodium.crypto_pwhash(
    32,
    secret,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
}

/**
 * Deterministic 16 byte salt for an admin account, derived from the username.
 * Lets the browser derive a verifier without an extra round trip.
 */
export function adminSalt(username) {
  const label = 'anon-chat|admin-v1|' + String(username || '').trim().toLowerCase();
  return sodium.crypto_generichash(sodium.crypto_pwhash_SALTBYTES, sodium.from_string(label), null);
}

/**
 * Turn the admin password into the only value that ever reaches the server.
 * Returns 64 lowercase hex chars (256 bits of Argon2id output).
 */
export async function deriveAdminVerifier(username, password) {
  await cryptoReady();
  await yieldToBrowser();
  const master = argon2(password, adminSalt(username));
  const verifier = sodium.crypto_kdf_derive_from_key(
    32, PROTOCOL.subkeyAdminVerifier, PROTOCOL.kdfContextAdmin, master
  );
  const hex = sodium.to_hex(verifier);
  wipe(master);
  wipe(verifier);
  return hex;
}

/**
 * Turn the private room passphrase into { roomKey, verifier }.
 * `roomSaltB64` comes from the server (it is public, like an SRP salt).
 * The roomKey never leaves this tab; the verifier is what the server checks.
 */
export async function deriveRoomKeys(passphrase, roomSaltB64) {
  await cryptoReady();
  await yieldToBrowser();
  const salt = sodium.from_base64(roomSaltB64, B64);
  const master = argon2(passphrase, salt);
  const roomKey = sodium.crypto_kdf_derive_from_key(
    32, PROTOCOL.subkeyRoomEncryption, PROTOCOL.kdfContextRoom, master
  );
  const verifierBytes = sodium.crypto_kdf_derive_from_key(
    32, PROTOCOL.subkeyRoomVerifier, PROTOCOL.kdfContextRoom, master
  );
  const verifier = sodium.to_hex(verifierBytes);
  wipe(master);
  wipe(verifierBytes);
  return { roomKey, verifier };
}

/* ------------------------------------------------------- message envelope */

/** Seal a UTF-8 string. Returns { c, n } — both unpadded URL safe base64. */
export function encryptText(key, plaintext) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(String(plaintext == null ? '' : plaintext)), null, null, nonce, key
  );
  return { c: sodium.to_base64(ct, B64), n: sodium.to_base64(nonce, B64) };
}

/** Open a sealed string. Throws on a wrong key or on any tampering. */
export function decryptText(key, c, n) {
  const ct = sodium.from_base64(c, B64);
  const nonce = sodium.from_base64(n, B64);
  // Decrypt to bytes and decode ourselves: the string output format token was
  // renamed between libsodium.js releases, this works with all of them.
  const bytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
  return sodium.to_string(bytes);
}

/* ------------------------------------------------------------- file blobs */

function u32be(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function readU32be(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function fileHeader(streamHeader, chunkSize) {
  const magic = sodium.from_string(PROTOCOL.fileMagic);
  const version = new Uint8Array([PROTOCOL.version]);
  const head = new Uint8Array(magic.length + 1 + 4 + streamHeader.length);
  head.set(magic, 0);
  head.set(version, magic.length);
  head.set(u32be(chunkSize), magic.length + 1);
  head.set(streamHeader, magic.length + 5);
  return head;
}

/**
 * Seal a Blob/File chunk by chunk. Progress is reported as 0..1.
 * Returns a Blob the size of the input plus a 37 byte header and 20 bytes per chunk.
 */
export async function encryptBlob(key, blob, onProgress) {
  await cryptoReady();
  const TAG_MESSAGE = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  if (!stream || !stream.header || !stream.state) throw new Error('Could not start file encryption');
  const parts = [new Blob([fileHeader(stream.header, FILE_CHUNK_SIZE)])];
  const total = blob.size;
  let offset = 0;
  for (;;) {
    const isLast = offset + FILE_CHUNK_SIZE >= total;
    const slice = await blob.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
      stream.state, new Uint8Array(slice), null, isLast ? TAG_FINAL : TAG_MESSAGE
    );
    if (!ct) throw new Error('File encryption failed');
    parts.push(new Blob([u32be(ct.length), ct]));
    offset += FILE_CHUNK_SIZE;
    if (onProgress) onProgress(total ? Math.min(1, offset / total) : 1);
    if (isLast) break;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/**
 * Open a sealed Blob. Throws if the key is wrong or the file was tampered with,
 * truncated or reordered — secretstream authenticates the whole sequence.
 */
export async function decryptBlob(key, blob, mimeType, onProgress) {
  await cryptoReady();
  const TAG_FINAL = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const raw = new Uint8Array(await blob.arrayBuffer());
  const magic = sodium.from_string(PROTOCOL.fileMagic);
  if (raw.length < magic.length + 1 + 4 + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
    throw new Error('File is too small to be an encrypted Anon Chat file');
  }
  for (let i = 0; i < magic.length; i++) {
    if (raw[i] !== magic[i]) throw new Error('Not an encrypted Anon Chat file');
  }
  if (raw[magic.length] !== PROTOCOL.version) throw new Error('Unsupported file format version');
  const chunkSize = readU32be(raw, magic.length + 1);
  if (chunkSize <= 0 || chunkSize > 64 * 1024 * 1024) throw new Error('Bad chunk size');
  const headerLen = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const headerStart = magic.length + 5;
  const streamHeader = raw.slice(headerStart, headerStart + headerLen);
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
  if (!state) throw new Error('Decryption failed — this file was not sealed with that key');

  const parts = [];
  let pos = headerStart + headerLen;
  let done = 0;
  let sawFinal = false;
  while (pos < raw.length) {
    if (pos + 4 > raw.length) throw new Error('Truncated encrypted file');
    const len = readU32be(raw, pos);
    pos += 4;
    if (len <= 0 || pos + len > raw.length) throw new Error('Truncated encrypted file');
    const chunk = raw.slice(pos, pos + len);
    pos += len;
    // NOTE: secretstream pull returns `false` on an auth failure, it does not throw.
    const res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    if (!res) throw new Error('Decryption failed — wrong key, or the file was modified');
    parts.push(new Blob([res.message]));
    done += chunkSize;
    if (onProgress) onProgress(Math.min(1, done / Math.max(1, blob.size)));
    if (res.tag === TAG_FINAL) { sawFinal = true; break; }
  }
  if (!sawFinal) throw new Error('Truncated encrypted file');
  return new Blob(parts, { type: mimeType || 'application/octet-stream' });
}

/** True when a Blob carries our container format. */
export async function looksEncrypted(blob) {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  const magic = sodium.from_string(PROTOCOL.fileMagic);
  if (head.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (head[i] !== magic[i]) return false;
  return true;
}

/* --------------------------------------------------------------- strength */

const COMMON = new Set([
  'password', 'passw0rd', '123456', '1234567', '12345678', '123456789', '1234567890',
  'qwerty', 'abc123', 'letmein', 'admin', 'administrator', 'welcome', 'monkey', 'dragon',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman',
  'anonchat', 'anon-chat', 'private', 'secret', 'changeme', 'password1', 'qwerty123',
  '111111', '000000', '123123', '654321', 'pass123', 'test', 'guest', 'root', 'toor'
]);

/**
 * Cheap offline password quality estimate: 0 (unusable) .. 4 (excellent).
 * The real protection is Argon2id — this only stops people picking "123456".
 */
export function assessStrength(secret) {
  const pw = String(secret || '');
  const hints = [];
  if (!pw.length) return { score: 0, label: 'empty', hints: ['Type a password'], bits: 0 };

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  let bits = Math.round(pw.length * Math.log2(Math.max(2, pool)));

  // Penalise the obvious patterns an attacker tries first.
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) { bits = Math.min(bits, 6); hints.push('That is one of the most common passwords'); }
  if (/^(.)\1+$/.test(pw)) { bits = Math.min(bits, 8); hints.push('A single repeated character is trivial to guess'); }
  const seq = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (seq.includes(lower) && lower.length >= 4) { bits = Math.min(bits, 12); hints.push('Avoid plain sequences like "abcd" or "1234"'); }
  if (/^\d+$/.test(pw)) { bits = Math.min(bits, pw.length * 3.32); hints.push('Digits only — mix in letters and symbols'); }
  const uniq = new Set(lower.split('')).size;
  if (uniq <= Math.max(2, Math.floor(lower.length / 3))) { bits *= 0.6; hints.push('Low variety — reuse fewer characters'); }

  if (pw.length < 8) hints.push('Use at least 8 characters (12+ is much better)');
  else if (pw.length < 12) hints.push('Longer is stronger — 12+ characters recommended');

  bits = Math.max(0, Math.round(bits));
  let score;
  if (bits < 28) score = 0;
  else if (bits < 40) score = 1;
  else if (bits < 60) score = 2;
  else if (bits < 90) score = 3;
  else score = 4;
  const label = ['Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'][score];
  return { score, label, bits, hints };
}

/** A pronounceable-ish 128 bit random passphrase, easy to write on paper. */
export function generatePassphrase(words = 6) {
  const list = PASSPHRASE_WORDS;
  const out = [];
  for (let i = 0; i < words; i++) {
    out.push(list[sodium.randombytes_uniform(list.length)]);
  }
  const digits = sodium.randombytes_uniform(900) + 100;
  return out.join('-') + '-' + digits;
}

const PASSPHRASE_WORDS = [
  'anchor', 'basalt', 'cinder', 'delta', 'ember', 'fathom', 'glacier', 'harbor',
  'indigo', 'jasper', 'kelp', 'lantern', 'meadow', 'nimbus', 'onyx', 'prism',
  'quartz', 'ravine', 'solstice', 'tundra', 'umbra', 'vertex', 'willow', 'xenon',
  'yonder', 'zenith', 'amber', 'bramble', 'cipher', 'dune', 'echo', 'flint',
  'grove', 'hollow', 'ironwood', 'juniper', 'kiosk', 'lumen', 'mistral', 'nectar',
  'orbit', 'pine', 'quill', 'ridge', 'summit', 'thicket', 'updraft', 'vale',
  'wharf', 'yarrow', 'zephyr', 'atlas', 'beacon', 'cobalt', 'drift', 'eclipse'
];
