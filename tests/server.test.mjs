/**
 * End to end tests: spawns the real server on an ephemeral port with throwaway
 * data directories, then drives it over HTTP and socket.io exactly like the
 * browser client does — including the Argon2id derivations.
 *
 * The point of most assertions is what the server must NOT know.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import * as sec from '../public/js/crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let child = null;
let baseUrl = '';
let tmpDir = '';
let dataDir = '';
let uploadDir = '';

const ADMIN_USER = 'owner';
const ADMIN_PASS = 'a-very-strong-admin-password';
const ROOM_PASS = 'correct-horse-battery-staple-42';
const SECRET_TEXT = 'MEETING-AT-MIDNIGHT-DO-NOT-LEAK';

let adminToken = null;
let roomSalt = null;
let roomVerifier = null;
let roomKey = null;
let kid = 1;

const sockets = [];

function dataPath(...parts) { return path.join(dataDir, ...parts); }

function readStoredMessages(room) {
  try { return JSON.parse(fs.readFileSync(dataPath(room, 'messages.json'), 'utf8')); }
  catch { return []; }
}

async function json(method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(baseUrl + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

/**
 * Connect and wait for the server's `welcome`. Both listeners are attached
 * before the handshake can complete, so the greeting can never be missed.
 */
function connectSocket() {
  const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  const welcomed = once(socket, 'welcome');
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  return Promise.all([connected, welcomed]).then(([, welcome]) => {
    socket.welcome = welcome;
    return socket;
  });
}

function once(socket, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for "' + event + '"')), timeout);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

async function joinRoom(socket, room, extra = {}) {
  const joined = once(socket, 'room-joined');
  socket.emit('join-room', { room, ...extra });
  return joined;
}

function seal(text, fileMeta) {
  const envelope = JSON.stringify({ v: 1, t: text, f: fileMeta || null });
  return sec.encryptText(roomKey, envelope);
}

before(async () => {
  await sec.cryptoReady();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonchat-test-'));
  dataDir = path.join(tmpDir, 'Data');
  uploadDir = path.join(tmpDir, 'uploads');

  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, UPLOAD_DIR: uploadDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  let settled = false;
  let resolvePort = null;
  let rejectPort = null;
  const started = new Promise((resolve, reject) => { resolvePort = resolve; rejectPort = reject; });
  const timer = setTimeout(() => {
    if (!settled) { settled = true; rejectPort(new Error('server did not start within 20s:\n' + log)); }
  }, 20000);

  child.stdout.on('data', (chunk) => {
    log += chunk.toString();
    if (process.env.VERBOSE) process.stdout.write('[srv] ' + chunk);
    const match = log.match(/Anon Chat on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match && !settled) { settled = true; clearTimeout(timer); resolvePort(Number(match[1])); }
  });
  child.stderr.on('data', (chunk) => {
    log += chunk.toString();
    if (process.env.VERBOSE) process.stderr.write('[srv!] ' + chunk);
  });
  child.on('exit', (code) => {
    if (!settled) { settled = true; clearTimeout(timer); rejectPort(new Error('server exited with ' + code + ':\n' + log)); }
  });

  baseUrl = 'http://127.0.0.1:' + (await started);
});

after(async () => {
  sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
  if (child && !child.killed) child.kill('SIGKILL');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ------------------------------------------------------------------ setup */

test('a fresh server reports that setup is required', async () => {
  const { status, data } = await json('GET', '/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(data.setupRequired, true);
  assert.equal(data.needAdmin, true);
  assert.equal(data.needRoom, true);
  assert.equal(data.room, null);
  assert.equal(data.clientKdf.algorithm, 'argon2id');
  assert.ok(data.clientKdf.memlimit >= 64 * 1024 * 1024);
  assert.match(data.serverKdf, /^scrypt\$N=32768/);
});

test('admin endpoints refuse everyone before setup', async () => {
  const login = await json('POST', '/api/admin/login', { username: ADMIN_USER, verifier: '0'.repeat(64) });
  assert.equal(login.status, 409);
  const stats = await json('GET', '/api/admin/stats', undefined, 'v1.bogus.bogus');
  assert.equal(stats.status, 401);
});

test('first time setup creates credentials and signs the admin in', async () => {
  roomSalt = sec.toB64(sec.randomBytes(16));
  const adminVerifier = await sec.deriveAdminVerifier(ADMIN_USER, ADMIN_PASS);
  const derived = await sec.deriveRoomKeys(ROOM_PASS, roomSalt);
  roomKey = derived.roomKey;
  roomVerifier = derived.verifier;

  const { status, data } = await json('POST', '/api/setup', {
    adminUsername: ADMIN_USER, adminVerifier, roomVerifier, roomSalt
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.username, ADMIN_USER);
  assert.ok(data.token && data.token.split('.').length === 3);
  assert.equal(data.room.kid, 1);
  assert.equal(data.room.salt, roomSalt);
  adminToken = data.token;

  const after = await json('GET', '/api/bootstrap');
  assert.equal(after.data.setupRequired, false);
  assert.equal(after.data.needAdmin, false);
  assert.equal(after.data.needRoom, false);
  assert.equal(after.data.room.kid, 1);
  assert.equal(after.data.room.salt, roomSalt);
});

test('the stored config holds no plaintext secret', () => {
  const raw = fs.readFileSync(path.join(dataDir, 'private', 'security.json'), 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(!raw.includes(ADMIN_PASS), 'admin password must never be written to disk');
  assert.ok(!raw.includes(ROOM_PASS), 'room passphrase must never be written to disk');
  assert.ok(!raw.includes(roomVerifier), 'the raw verifier must not be stored either');
  assert.ok(!raw.includes(sec.toHex(roomKey)), 'the room key must never be stored');
  assert.equal(cfg.admin.username, ADMIN_USER);
  assert.match(cfg.admin.kdf, /^scrypt\$/);
  assert.equal(cfg.room.kid, 1);
  const mode = fs.statSync(path.join(dataDir, 'private', 'security.json')).mode & 0o777;
  assert.equal(mode, 0o600, 'security.json must be owner only');
});

test('setup cannot run twice', async () => {
  const { status } = await json('POST', '/api/setup', {
    adminUsername: 'second', adminVerifier: 'a'.repeat(64), roomVerifier: 'b'.repeat(64), roomSalt
  });
  assert.equal(status, 409);
});

test('malformed credentials are rejected before any hashing happens', async () => {
  assert.equal((await json('POST', '/api/admin/login', { username: ADMIN_USER, verifier: 'not-hex' })).status, 400);
  assert.equal((await json('POST', '/api/admin/login', { username: ADMIN_USER })).status, 400);
});

/* ------------------------------------------------------------------ admin */

test('admin login rejects a wrong verifier and accepts the right one', async () => {
  const wrongVerifier = await sec.deriveAdminVerifier(ADMIN_USER, 'the-wrong-password');
  const wrong = await json('POST', '/api/admin/login', { username: ADMIN_USER, verifier: wrongVerifier });
  assert.equal(wrong.status, 401);

  const wrongUser = await json('POST', '/api/admin/login', { username: 'nobody', verifier: wrongVerifier });
  assert.equal(wrongUser.status, 401);

  const rightVerifier = await sec.deriveAdminVerifier(ADMIN_USER, ADMIN_PASS);
  const right = await json('POST', '/api/admin/login', { username: ADMIN_USER, verifier: rightVerifier });
  assert.equal(right.status, 200, JSON.stringify(right.data));
  assert.ok(right.data.token);
  const me = await json('GET', '/api/admin/status', undefined, right.data.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.username, ADMIN_USER);
});

test('admin endpoints reject garbage and tampered tokens', async () => {
  assert.equal((await json('GET', '/api/admin/stats')).status, 401);
  assert.equal((await json('GET', '/api/admin/stats', undefined, 'v1.aaa.bbb')).status, 401);
  const parts = adminToken.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: ADMIN_USER, role: 'admin', sv: 1, exp: Date.now() + 9e9 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal((await json('GET', '/api/admin/stats', undefined, [parts[0], forgedPayload, parts[2]].join('.'))).status, 401);
  assert.equal((await json('GET', '/api/admin/stats', undefined, [parts[0], parts[1], parts[1]].join('.'))).status, 401);
});

/* ------------------------------------------------------- encrypted chat */

test('the private room rejects a wrong passphrase', async () => {
  const socket = await connectSocket();
  const bad = await sec.deriveRoomKeys('not-the-room-passphrase', roomSalt);
  const error = once(socket, 'error-msg');
  socket.emit('join-room', { room: 'private', verifier: bad.verifier });
  const msg = await error;
  assert.match(msg.message, /wrong passphrase/i);
  socket.close();
});

test('private messages travel and are stored as ciphertext only', async () => {
  const alice = await connectSocket();
  const bob = await connectSocket();

  const aliceJoined = await joinRoom(alice, 'private', { verifier: roomVerifier });
  assert.equal(aliceJoined.room, 'private');
  assert.equal(aliceJoined.kid, kid);
  assert.equal(aliceJoined.users, 1);

  const aliceSeesBob = once(alice, 'user-joined');
  const bobJoined = await joinRoom(bob, 'private', { verifier: roomVerifier });
  assert.equal(bobJoined.users, 2);
  assert.equal((await aliceSeesBob).users, 2);

  const received = once(bob, 'message');
  alice.emit('message', { room: 'private', enc: seal(SECRET_TEXT), kid });
  const broadcast = await received;

  assert.equal(broadcast.text, undefined, 'the server must not forward plaintext');
  assert.equal(broadcast.ip, undefined, 'private messages must not carry an IP');
  assert.ok(broadcast.c && broadcast.n, 'ciphertext + nonce expected');
  assert.equal(broadcast.kid, kid);
  assert.ok(sec.decryptText(roomKey, broadcast.c, broadcast.n).includes(SECRET_TEXT));

  const stored = readStoredMessages('private');
  assert.equal(stored.length, 1);
  const raw = fs.readFileSync(dataPath('private', 'messages.json'), 'utf8');
  assert.ok(!raw.includes(SECRET_TEXT), 'plaintext must never reach the disk');
  assert.equal(stored[0].text, undefined);
  assert.equal(stored[0].ip, undefined);
  assert.equal(stored[0].c, broadcast.c);

  // History handed to a fresh member is ciphertext too.
  const carol = await connectSocket();
  const joined = await joinRoom(carol, 'private', { verifier: roomVerifier });
  assert.equal(joined.messages.length, 1);
  assert.equal(joined.messages[0].text, undefined);
  assert.ok(sec.decryptText(roomKey, joined.messages[0].c, joined.messages[0].n).includes(SECRET_TEXT));

  alice.close(); bob.close(); carol.close();
});

test('you cannot post to the private room without unlocking it', async () => {
  const mallory = await connectSocket();
  await joinRoom(mallory, 'public');
  const error = once(mallory, 'error-msg');
  mallory.emit('message', { room: 'private', enc: seal('sneaky'), kid });
  const msg = await error;
  assert.match(msg.message, /join the private room first/i);
  assert.equal(readStoredMessages('private').length, 1, 'nothing was stored');
  mallory.close();
});

test('an admin may enter the private room without the key but still cannot read it', async () => {
  const socket = await connectSocket();
  socket.emit('admin-auth', { token: adminToken });
  const adminState = await once(socket, 'admin-state');
  assert.equal(adminState.isAdmin, true);
  const joined = await joinRoom(socket, 'private');
  assert.equal(joined.moderationOnly, true);
  assert.equal(joined.messages.length, 1);
  assert.equal(joined.messages[0].c.length > 0, true, 'only ciphertext is served');
  socket.close();
});

test('the public room keeps working in clear text', async () => {
  const a = await connectSocket();
  const b = await connectSocket();
  await joinRoom(a, 'public');
  await joinRoom(b, 'public');
  const received = once(b, 'message');
  a.emit('message', { room: 'public', text: 'public hello' });
  const msg = await received;
  assert.equal(msg.text, 'public hello');
  assert.equal(readStoredMessages('public').at(-1).text, 'public hello');
  a.close(); b.close();
});

/* --------------------------------------------------------------- removal */

test('a regular user cannot remove messages', async () => {
  const user = await connectSocket();
  await joinRoom(user, 'private', { verifier: roomVerifier });
  const target = readStoredMessages('private')[0].id;
  const error = once(user, 'error-msg');
  user.emit('delete-message', { room: 'private', id: target });
  const msg = await error;
  assert.match(msg.message, /only an admin/i);
  assert.equal(readStoredMessages('private').length, 1, 'message survived');
  const rest = await json('DELETE', '/api/admin/messages/private/' + target);
  assert.equal(rest.status, 401);
  user.close();
});

test('an admin can remove a message over the socket', async () => {
  const watcher = await connectSocket();
  await joinRoom(watcher, 'private', { verifier: roomVerifier });

  const admin = await connectSocket();
  admin.emit('admin-auth', { token: adminToken });
  await once(admin, 'admin-state');
  await joinRoom(admin, 'private');

  const target = readStoredMessages('private')[0].id;
  const deleted = once(watcher, 'message-deleted');
  admin.emit('delete-message', { room: 'private', id: target });
  const event = await deleted;
  assert.equal(event.id, target);
  assert.equal(event.by, ADMIN_USER);
  assert.equal(readStoredMessages('private').length, 0, 'message removed from disk');

  const audit = await json('GET', '/api/admin/audit', undefined, adminToken);
  assert.ok(audit.data.entries.some((e) => e.action === 'message-deleted' && e.id === target));
  watcher.close(); admin.close();
});

test('removing a message also removes its file from disk', async () => {
  const admin = await connectSocket();
  admin.emit('admin-auth', { token: adminToken });
  await once(admin, 'admin-state');
  await joinRoom(admin, 'private');

  const plain = new Uint8Array(4096).fill(0x41);
  const sealed = await sec.encryptBlob(roomKey, new Blob([plain]));
  const form = new FormData();
  form.append('room', 'private');
  form.append('file', sealed, 'upload.bin');
  const res = await fetch(baseUrl + '/upload', { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const uploaded = await res.json();
  assert.ok(uploaded.url.startsWith('/uploads/private/'), uploaded.url);
  assert.equal(uploaded.name, 'encrypted.bin');
  assert.equal(uploaded.encrypted, true);

  const diskFile = path.join(uploadDir, 'private', path.basename(uploaded.url));
  assert.ok(fs.existsSync(diskFile), 'file should exist on disk');
  const onDisk = new Uint8Array(fs.readFileSync(diskFile));
  assert.equal(String.fromCharCode(...onDisk.slice(0, 8)), 'ANONENC1', 'stored bytes must be the sealed container');
  assert.ok(!Buffer.from(onDisk).includes('AAAA'), 'plaintext must not be on disk');

  const fetched = await fetch(baseUrl + uploaded.url);
  assert.equal(fetched.status, 200);
  const roundTrip = await sec.decryptBlob(roomKey, await fetched.blob(), 'image/png');
  assert.deepEqual(Buffer.from(new Uint8Array(await roundTrip.arrayBuffer())), Buffer.from(plain));

  const meta = { name: 'photo.png', type: 'image/png', size: plain.length };
  const echoed = once(admin, 'message');
  admin.emit('message', {
    room: 'private',
    enc: seal('', meta),
    kid,
    file: { id: uploaded.id, url: uploaded.url }
  });
  const storedMessage = await echoed;
  assert.equal(storedMessage.file.url, uploaded.url);
  assert.equal(storedMessage.file.name, undefined, 'the real filename stays inside the envelope');

  const target = storedMessage.id;
  const deleted = once(admin, 'message-deleted');
  admin.emit('delete-message', { room: 'private', id: target });
  await deleted;

  assert.ok(!fs.existsSync(diskFile), 'the uploaded bytes must be gone');
  const uploads = JSON.parse(fs.readFileSync(path.join(dataDir, 'uploads.json'), 'utf8'));
  assert.equal(uploads[uploaded.id], undefined, 'metadata record must be gone');
  admin.close();
});

test('admin REST exposes private metadata but never content', async () => {
  const admin = await connectSocket();
  admin.emit('admin-auth', { token: adminToken });
  await once(admin, 'admin-state');
  await joinRoom(admin, 'private');
  const posted = once(admin, 'message');
  admin.emit('message', { room: 'private', enc: seal(SECRET_TEXT + '-2'), kid });
  await posted;
  admin.close();

  const list = await json('GET', '/api/admin/messages/private', undefined, adminToken);
  assert.equal(list.status, 200);
  assert.equal(list.data.messages.length, 1);
  const row = list.data.messages[0];
  assert.equal(row.encrypted, true);
  assert.equal(row.text, undefined);
  assert.equal(row.c, undefined, 'the admin API must not hand out ciphertext either');
  assert.equal(JSON.stringify(list.data).includes(SECRET_TEXT), false);

  const stats = await json('GET', '/api/admin/stats', undefined, adminToken);
  assert.equal(stats.data.private.messages, 1);
  assert.equal(stats.data.private.legacyUnencrypted, 0);
});

test('the legacy purge endpoint is admin only and reports what it removed', async () => {
  assert.equal((await json('DELETE', '/api/admin/legacy')).status, 401);
  const res = await json('DELETE', '/api/admin/legacy', undefined, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.removed, 0, 'nothing predates encryption in a fresh install');
  const stats = await json('GET', '/api/admin/stats', undefined, adminToken);
  assert.equal(stats.data.private.legacyUnencrypted, 0);
});

test('room key rotation invalidates the old passphrase', async () => {
  const newSalt = sec.toB64(sec.randomBytes(16));
  const newDerived = await sec.deriveRoomKeys('a-brand-new-room-passphrase', newSalt);
  const rotated = await json('POST', '/api/admin/room/rotate', { verifier: newDerived.verifier, salt: newSalt }, adminToken);
  assert.equal(rotated.status, 200);
  assert.equal(rotated.data.room.kid, 2);
  kid = 2;

  const oldLogin = await connectSocket();
  const error = once(oldLogin, 'error-msg');
  oldLogin.emit('join-room', { room: 'private', verifier: roomVerifier });
  assert.match((await error).message, /wrong passphrase/i);
  oldLogin.close();

  const fresh = await connectSocket();
  const joined = await joinRoom(fresh, 'private', { verifier: newDerived.verifier });
  assert.equal(joined.kid, 2);

  // Messages sealed with key #1 are still stored, but the new key cannot read them.
  const old = readStoredMessages('private').find((m) => m.kid === 1);
  assert.ok(old, 'old message kept for auditing');
  assert.throws(() => sec.decryptText(newDerived.roomKey, old.c, old.n), /./);

  // And posting with the stale key id is refused.
  const stale = once(fresh, 'error-msg');
  fresh.emit('message', { room: 'private', enc: sec.encryptText(newDerived.roomKey, JSON.stringify({ v: 1, t: 'x' })), kid: 1 });
  assert.match((await stale).message, /key changed/i);
  fresh.close();

  roomKey = newDerived.roomKey;
  roomVerifier = newDerived.verifier;
});

test('changing the admin password invalidates existing sessions', async () => {
  const newPass = 'an-even-stronger-admin-password';
  const verifier = await sec.deriveAdminVerifier(ADMIN_USER, newPass);
  const changed = await json('POST', '/api/admin/password', { username: ADMIN_USER, verifier }, adminToken);
  assert.equal(changed.status, 200);
  assert.ok(changed.data.token);

  assert.equal((await json('GET', '/api/admin/status', undefined, adminToken)).status, 401, 'old token must die');
  assert.equal((await json('GET', '/api/admin/status', undefined, changed.data.token)).status, 200);
  adminToken = changed.data.token;

  const socket = await connectSocket();
  socket.emit('admin-auth', { token: changed.data.token });
  assert.equal((await once(socket, 'admin-state')).isAdmin, true);
  socket.close();
});

test('purging a room clears messages for everyone', async () => {
  const watcher = await connectSocket();
  await joinRoom(watcher, 'private', { verifier: roomVerifier });

  const purged = once(watcher, 'room-purged');
  const res = await json('DELETE', '/api/admin/messages/private', undefined, adminToken);
  assert.equal(res.status, 200);
  await purged;
  assert.equal(readStoredMessages('private').length, 0);
  watcher.close();
});

test('malformed socket packets cannot crash the server', async () => {
  const socket = await connectSocket();
  socket.emit('set-name');
  socket.emit('set-name', 'not-an-object');
  socket.emit('message');
  socket.emit('message', null);
  socket.emit('join-room');
  socket.emit('delete-message');
  socket.emit('admin-auth');
  await joinRoom(socket, 'public');
  socket.emit('message', { room: 'public', file: 'not-an-object' });
  socket.emit('message', { room: 'public', text: '', file: { url: '/etc/passwd' } });
  socket.emit('message', { room: 'public', text: '', file: { url: '/uploads/public/../../secret' } });
  socket.emit('message', { room: 'public', text: 'still fine' });
  const ok = await once(socket, 'message');
  assert.equal(ok.text, 'still fine');
  socket.close();

  const alive = await json('GET', '/api/bootstrap');
  assert.equal(alive.status, 200, 'the server is still answering');
  const fresh = await connectSocket();
  assert.equal((await joinRoom(fresh, 'public')).room, 'public');
  fresh.close();

  const stored = readStoredMessages('public').filter((m) => m.file);
  assert.equal(stored.length, 0, 'junk file references were dropped, not stored');
});

test('repeated bad logins lock the door (run last: it locks this IP)', async () => {
  let last = null;
  for (let i = 0; i < 7; i++) {
    last = await json('POST', '/api/admin/login', { username: ADMIN_USER, verifier: 'f'.repeat(64) });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'brute force must be throttled');
  assert.ok(last.data.retryAfter > 0);

  const roomSocket = await connectSocket();
  let roomError = null;
  for (let i = 0; i < 7; i++) {
    const error = once(roomSocket, 'error-msg');
    roomSocket.emit('join-room', { room: 'private', verifier: 'e'.repeat(64) });
    roomError = await error;
    if (/locked/i.test(roomError.message)) break;
  }
  assert.match(roomError.message, /locked|too many/i);
  roomSocket.close();
});
