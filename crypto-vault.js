// ──────────────────────────────────────────────────────────────────────────────
//  Crypto Vault — high-end encryption for password hashing & passkey data at rest
//
//  • Password hashing: PBKDF2, 600 000 iterations, SHA-512, 32-byte random salt, 64-byte output
//  • Data encryption: AES-256-GCM with a 256-bit key derived via PBKDF2 from the user password
//  • Each encryption operation uses a unique 16-byte IV (stored alongside the ciphertext)
//  • Format: "v1$<iterations>$<salt-hex>$<hash-hex>"  (password hash)
//             "v1$<iv-hex>$<auth-tag-hex>$<ciphertext-hex>"  (encrypted payload)
// ──────────────────────────────────────────────────────────────────────────────
"use strict";

const crypto = require("crypto");

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEYLEN = 64;          // 512-bit output for password hash
const PBKDF2_DIGEST = "sha512";
const SALT_BYTES = 32;             // 256-bit salt
const AES_KEY_BYTES = 32;          // 256-bit AES key
const AES_IV_BYTES = 16;           // 128-bit IV for GCM
const AES_TAG_BYTES = 16;          // 128-bit authentication tag

// ─── Password hashing (PBKDF2) ───────────────────────────────────────────────

/**
 * Hash a password with PBKDF2-SHA512 (600 000 iterations, random 256-bit salt).
 * Returns a portable string: "v1$<iter>$<salt-hex>$<hash-hex>"
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `v1$${PBKDF2_ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Verify a password against a stored hash.  Supports:
 *   • v1$ PBKDF2 format (preferred)
 *   • Raw 64-char hex (legacy sha256 — for backward compatibility)
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const input = typeof password === "string" ? password : "";

  // New PBKDF2 format
  if (stored.startsWith("v1$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], "hex");
    const expectedHash = Buffer.from(parts[3], "hex");
    if (!iterations || salt.length === 0 || expectedHash.length === 0) return false;
    const derived = crypto.pbkdf2Sync(input, salt, iterations, expectedHash.length, PBKDF2_DIGEST);
    return crypto.timingSafeEqual(derived, expectedHash);
  }

  // Legacy sha256 hex (64 chars)
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const derived = crypto.createHash("sha256").update(input).digest("hex");
    const a = Buffer.from(derived);
    const b = Buffer.from(stored);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  return false;
}

// ─── AES-256-GCM encryption (for passkey data at rest) ───────────────────────

/**
 * Derive a 256-bit AES key from a password using PBKDF2.
 * A fixed application-level salt is used so the same password always produces
 * the same key (needed to decrypt stored data across restarts).  The per-record
 * IV still provides uniqueness.
 */
function deriveEncryptionKey(password) {
  const APP_SALT = "anon-chat-passkey-vault-v1";  // application-level salt
  return crypto.pbkdf2Sync(password, APP_SALT, PBKDF2_ITERATIONS, AES_KEY_BYTES, PBKDF2_DIGEST);
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 * Returns "v1$<iv-hex>$<tag-hex>$<ciphertext-hex>".
 */
function encryptString(plaintext, key) {
  const iv = crypto.randomBytes(AES_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1$${iv.toString("hex")}$${tag.toString("hex")}$${encrypted.toString("hex")}`;
}

/**
 * Decrypt an AES-256-GCM payload produced by encryptString().
 * Returns the original UTF-8 string, or null on failure.
 */
function decryptString(blob, key) {
  if (!blob || typeof blob !== "string" || !blob.startsWith("v1$")) return null;
  const parts = blob.split("$");
  if (parts.length !== 4) return null;
  try {
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const ciphertext = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Encrypt an object (JSON-serialised) with AES-256-GCM.
 */
function encryptObject(obj, key) {
  return encryptString(JSON.stringify(obj), key);
}

/**
 * Decrypt an AES-256-GCM payload back to an object.
 */
function decryptObject(blob, key) {
  const json = decryptString(blob, key);
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * Check whether a value looks like an encrypted blob.
 */
function isEncrypted(value) {
  return typeof value === "string" && value.startsWith("v1$") && value.split("$").length === 4;
}

module.exports = {
  hashPassword,
  verifyPassword,
  deriveEncryptionKey,
  encryptString,
  decryptString,
  encryptObject,
  decryptObject,
  isEncrypted,
  PBKDF2_ITERATIONS,
};
