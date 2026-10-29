/**
 * Unit tests for the browser crypto module. It has no DOM dependencies, so it
 * runs as-is under Node against the same vendored libsodium the browser loads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sec from '../public/js/crypto.mjs';

test('libsodium initialises and exposes Argon2id', async () => {
  const sodium = await sec.cryptoReady();
  assert.equal(typeof sodium.crypto_pwhash, 'function', 'Argon2 build required');
  const params = sec.kdfParams();
  assert.equal(params.algorithm, 'argon2id');
  assert.equal(params.outputBytes, 32);
  assert.ok(params.memlimit >= 64 * 1024 * 1024, 'KDF must be memory hard');
});

test('room keys are deterministic per passphrase+salt and split cleanly', async () => {
  const salt = sec.toB64(sec.randomBytes(16));
  const a = await sec.deriveRoomKeys('hunter2-correct-horse', salt);
  const b = await sec.deriveRoomKeys('hunter2-correct-horse', salt);
  const c = await sec.deriveRoomKeys('hunter3-correct-horse', salt);
  const d = await sec.deriveRoomKeys('hunter2-correct-horse', sec.toB64(sec.randomBytes(16)));

  assert.equal(a.verifier, b.verifier, 'same passphrase + salt → same verifier');
  assert.equal(sec.toHex(a.roomKey), sec.toHex(b.roomKey), 'same passphrase + salt → same key');
  assert.notEqual(a.verifier, c.verifier, 'different passphrase → different verifier');
  assert.notEqual(sec.toHex(a.roomKey), sec.toHex(d.roomKey), 'different salt → different key');

  // The verifier is what travels to the server: it must not reveal the key.
  assert.notEqual(a.verifier, sec.toHex(a.roomKey));
  assert.match(a.verifier, /^[0-9a-f]{64}$/);
  assert.equal(a.roomKey.length, 32);
});

test('admin verifier is bound to the username and case insensitive on it', async () => {
  const v1 = await sec.deriveAdminVerifier('Owner', 'a-strong-admin-password');
  const v2 = await sec.deriveAdminVerifier('owner', 'a-strong-admin-password');
  const v3 = await sec.deriveAdminVerifier('owner', 'a-strong-admin-passworD');
  const v4 = await sec.deriveAdminVerifier('other', 'a-strong-admin-password');
  assert.equal(v1, v2, 'username is normalised');
  assert.notEqual(v1, v3, 'password changes the verifier');
  assert.notEqual(v1, v4, 'username changes the verifier');
  assert.match(v1, /^[0-9a-f]{64}$/);
});

test('message sealing round trips and rejects wrong keys and tampering', async () => {
  const salt = sec.toB64(sec.randomBytes(16));
  const { roomKey } = await sec.deriveRoomKeys('passphrase-for-sealing', salt);
  const other = await sec.deriveRoomKeys('not-the-passphrase', salt);
  const plaintext = JSON.stringify({ v: 1, t: 'hello 🔒 ünïcøde', f: null });

  const sealed = sec.encryptText(roomKey, plaintext);
  assert.ok(sealed.c && sealed.n);
  assert.ok(!sealed.c.includes('hello'), 'ciphertext must not contain the plaintext');
  assert.equal(sec.decryptText(roomKey, sealed.c, sealed.n), plaintext);

  assert.throws(() => sec.decryptText(other.roomKey, sealed.c, sealed.n), /./, 'wrong key must fail');

  // Flip one bit of the ciphertext.
  const bytes = sec.fromB64(sealed.c);
  bytes[0] ^= 0x01;
  assert.throws(() => sec.decryptText(roomKey, sec.toB64(bytes), sealed.n), /./, 'tampering must fail');

  // Nonces must never repeat.
  const again = sec.encryptText(roomKey, plaintext);
  assert.notEqual(again.n, sealed.n);
  assert.notEqual(again.c, sealed.c);
});

test('file sealing round trips across many chunks', async () => {
  const salt = sec.toB64(sec.randomBytes(16));
  const { roomKey } = await sec.deriveRoomKeys('passphrase-for-files', salt);

  // 2.5 chunks so the FINAL tag is not on a chunk boundary.
  const size = Math.floor(sec.FILE_CHUNK_SIZE * 2.5) + 17;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = (i * 37 + 11) & 0xff;

  const sealed = await sec.encryptBlob(roomKey, new Blob([payload], { type: 'image/png' }));
  assert.ok(sealed.size > payload.length, 'container adds a header and per chunk tags');
  assert.ok(await sec.looksEncrypted(sealed), 'magic must be detectable');

  const opened = await sec.decryptBlob(roomKey, sealed, 'image/png');
  assert.equal(opened.type, 'image/png');
  const back = new Uint8Array(await opened.arrayBuffer());
  assert.equal(back.length, size);
  assert.deepEqual(Buffer.from(back), Buffer.from(payload));
});

test('empty files survive the round trip', async () => {
  const salt = sec.toB64(sec.randomBytes(16));
  const { roomKey } = await sec.deriveRoomKeys('empty-file-passphrase', salt);
  const sealed = await sec.encryptBlob(roomKey, new Blob([]));
  const opened = await sec.decryptBlob(roomKey, sealed, 'text/plain');
  assert.equal(opened.size, 0);
});

test('file decryption rejects truncation, tampering and wrong keys', async () => {
  const salt = sec.toB64(sec.randomBytes(16));
  const { roomKey } = await sec.deriveRoomKeys('tamper-test-passphrase', salt);
  const wrong = await sec.deriveRoomKeys('another-passphrase', salt);
  const payload = new Uint8Array(sec.FILE_CHUNK_SIZE + 4096).fill(7);
  const sealed = await sec.encryptBlob(roomKey, new Blob([payload]));
  const raw = new Uint8Array(await sealed.arrayBuffer());

  const tampered = raw.slice();
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(() => sec.decryptBlob(roomKey, new Blob([tampered]), 'x/y'), /./);

  await assert.rejects(() => sec.decryptBlob(roomKey, new Blob([raw.slice(0, raw.length - 40)]), 'x/y'), /./);
  await assert.rejects(() => sec.decryptBlob(wrong.roomKey, sealed, 'x/y'), /./);
  await assert.rejects(() => sec.decryptBlob(roomKey, new Blob([new Uint8Array([1, 2, 3])]), 'x/y'), /./);
});

test('strength meter blocks the usual suspects and passes real passphrases', () => {
  for (const weak of ['123456', 'password', 'aaaaaaaa', 'qwerty123', 'anonchat']) {
    assert.ok(sec.assessStrength(weak).score <= 1, weak + ' should be rejected');
  }
  assert.ok(sec.assessStrength('').score === 0);
  assert.ok(sec.assessStrength(sec.generatePassphrase()).score >= 3, 'generated passphrases must be strong');
  const generated = sec.generatePassphrase();
  assert.notEqual(generated, sec.generatePassphrase(), 'generator must use fresh randomness');
});
