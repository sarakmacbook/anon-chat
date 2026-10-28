/**
 * UI smoke test: loads the real public/index.html into jsdom, runs the real
 * public/js/app.js against a real server, and drives the setup wizard, the
 * encrypted private room and admin message removal through actual DOM events.
 *
 * The server side of the protocol is covered by tests/server.test.mjs; this one
 * exists to catch a broken wire-up between the markup and the client code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { io as ioClient } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const ADMIN_USER = 'owner';
const ADMIN_PASS = 'a-very-strong-admin-password';

let child = null;
let baseUrl = '';
let tmpDir = '';
let dataDir = '';
let dom = null;
let win = null;
let doc = null;
let roomPassphrase = '';
const appSockets = [];

const savedGlobals = {};

function byId(id) {
  const el = doc.getElementById(id);
  if (!el) throw new Error('missing element #' + id);
  return el;
}

function visible(id) {
  const el = typeof id === 'string' ? byId(id) : id;
  return !el.classList.contains('hidden');
}

function click(el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function type(id, value) {
  const el = byId(id);
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return el;
}

function stepVisible(n) {
  return visible(doc.querySelector('#setupSheet section[data-step="' + n + '"]'));
}

async function waitFor(label, predicate, timeout = 25000) {
  const started = Date.now();
  for (;;) {
    let ok = false;
    try { ok = Boolean(predicate()); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - started > timeout) throw new Error('timed out waiting for: ' + label);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function serverJson(url) {
  const res = await fetch(baseUrl + url);
  return res.json();
}

function readStoredPrivate() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'private', 'messages.json'), 'utf8'));
  } catch { return []; }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonchat-ui-'));
  dataDir = path.join(tmpDir, 'Data');
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, UPLOAD_DIR: path.join(tmpDir, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  let settled = false;
  let resolvePort;
  let rejectPort;
  const started = new Promise((resolve, reject) => { resolvePort = resolve; rejectPort = reject; });
  const timer = setTimeout(() => {
    if (!settled) { settled = true; rejectPort(new Error('server did not start:\n' + log)); }
  }, 20000);
  child.stdout.on('data', (c) => {
    log += c.toString();
    const m = log.match(/Anon Chat on http:\/\/0\.0\.0\.0:(\d+)/);
    if (m && !settled) { settled = true; clearTimeout(timer); resolvePort(Number(m[1])); }
  });
  child.stderr.on('data', (c) => { log += c.toString(); });
  child.on('exit', (code) => {
    if (!settled) { settled = true; clearTimeout(timer); rejectPort(new Error('server exited ' + code + ':\n' + log)); }
  });
  baseUrl = 'http://127.0.0.1:' + (await started);
});

after(async () => {
  // Close the app's sockets first: with the server gone, socket.io would keep
  // reconnecting and the test process would never exit.
  appSockets.forEach((socket) => { try { socket.close(); } catch { /* already closed */ } });
  if (dom) { try { dom.window.close(); } catch { /* already closed */ } }
  if (child && !child.killed) child.kill('SIGKILL');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('the first load shows the setup wizard', async () => {
  // Warm the crypto module up before `window` exists, so libsodium initialises
  // through its Node path. ES module caching means app.js reuses this instance.
  await import('../public/js/crypto.mjs');

  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: baseUrl + '/', runScripts: 'outside-only' });
  win = dom.window;
  doc = win.document;

  // app.js is written for a browser: hand it the jsdom globals it expects.
  const nodeFetch = globalThis.fetch;
  const wire = {
    window: win,
    document: doc,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    XMLHttpRequest: win.XMLHttpRequest,
    location: win.location,
    history: win.history,
    confirm: () => true,
    alert: () => {},
    io: (opts) => {
      const socket = ioClient(baseUrl, opts);
      appSockets.push(socket);
      return socket;
    },
    // jsdom has no object URLs; the private file flow only needs a stable string.
    fetch: (input, init) => nodeFetch(typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input, init)
  };
  for (const [key, value] of Object.entries(wire)) {
    savedGlobals[key] = globalThis[key];
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, writable: true, configurable: true });
  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:anon-chat-fake';
    URL.revokeObjectURL = () => {};
  }

  await import('../public/js/app.js');
  await waitFor('the setup wizard to appear', () => visible('setupSheet'));
  assert.equal(stepVisible(1), true, 'step 1 should be showing');
  assert.equal(visible('privateSheet'), false);
  assert.equal(visible('adminSheet'), false);
});

test('the wizard rejects a weak admin password', async () => {
  type('setupUser', ADMIN_USER);
  type('setupPass', 'abc');
  type('setupPass2', 'abc');
  click(byId('setupNext1'));
  await waitFor('a strength complaint', () => visible('setupError'));
  assert.match(byId('setupError').textContent, /at least|weak/i);
  assert.equal(stepVisible(1), true, 'must not advance');

  type('setupUser', 'has spaces');
  type('setupPass', 'Str0ng-enough-passphrase');
  type('setupPass2', 'Str0ng-enough-passphrase');
  click(byId('setupNext1'));
  await waitFor('a username complaint', () => byId('setupError').textContent.length > 0);
  assert.match(byId('setupError').textContent, /username/i);
  assert.equal(stepVisible(1), true);
});

test('step 1 accepts a strong admin account', async () => {
  type('setupUser', ADMIN_USER);
  type('setupPass', ADMIN_PASS);
  type('setupPass2', ADMIN_PASS);
  const strength = byId('setupStrengthLabel');
  await waitFor('the strength meter to react', () => strength.textContent.length > 0);
  click(byId('setupNext1'));
  await waitFor('step 2', () => stepVisible(2));
});

test('step 2 generates and accepts a room passphrase', async () => {
  // Typing a weak passphrase must be refused first.
  type('setupRoomPass', 'short');
  type('setupRoomPass2', 'short');
  click(byId('setupNext2'));
  await waitFor('a room passphrase complaint', () => visible('setupRoomError'));

  click(byId('genSetupRoom'));
  roomPassphrase = byId('setupRoomPass').value;
  assert.ok(roomPassphrase.length >= 20, 'generator should produce a long passphrase');
  assert.equal(byId('setupRoomPass2').value, roomPassphrase, 'generator fills both fields');
  click(byId('setupNext2'));
  await waitFor('step 3', () => stepVisible(3));
  assert.equal(byId('reviewUser').textContent, ADMIN_USER);
  assert.equal(byId('reviewRoom').textContent, roomPassphrase);
});

test('step 3 requires the "I saved it" confirmation before finishing', async () => {
  click(byId('setupFinishBtn'));
  await waitFor('the save reminder', () => visible('setupFinishError'));
  assert.match(byId('setupFinishError').textContent, /confirm/i);
  const bootstrap = await serverJson('/api/bootstrap');
  assert.equal(bootstrap.setupRequired, true, 'nothing was created yet');
});

test('finishing setup creates credentials, signs the admin in and joins #public', async () => {
  byId('savedConfirm').checked = true;
  byId('savedConfirm').dispatchEvent(new win.Event('change', { bubbles: true }));
  click(byId('setupFinishBtn'));

  await waitFor('the wizard to close', () => !visible('setupSheet'), 30000);
  for (let i = 0; i < 200; i++) {
    const bootstrap = await serverJson('/api/bootstrap');
    if (!bootstrap.setupRequired) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const bootstrap = await serverJson('/api/bootstrap');
  assert.equal(bootstrap.setupRequired, false);
  assert.equal(bootstrap.room.kid, 1);

  await waitFor('the public room to be joined', () => byId('online').textContent === '1 online', 15000);
  await waitFor('the admin badge to light up', () => byId('adminBtn').textContent.includes(ADMIN_USER), 15000);
  assert.ok(win.localStorage.getItem('anonchat.admin.token'), 'admin token stored');
});

test('a public message is sent and rendered', async () => {
  type('msgInput', 'hello from the jsdom browser');
  click(byId('sendBtn'));
  await waitFor('the bubble to appear', () => {
    const bubble = doc.querySelector('.msg .text');
    return bubble && bubble.textContent === 'hello from the jsdom browser';
  });
  assert.equal(byId('msgInput').value, '', 'input is cleared after sending');
});

test('the admin panel opens and reports live stats', async () => {
  click(byId('adminBtn'));
  await waitFor('the panel', () => visible('panelSheet'));
  await waitFor('stats to render', () => byId('statsGrid').children.length >= 6, 15000);
  assert.match(byId('cryptoNote').textContent, /argon2id/i);
  assert.match(byId('cryptoNote').textContent, /scrypt/i);

  doc.querySelectorAll('.tabs button').forEach((b) => { if (b.dataset.tab === 'moderate') click(b); });
  await waitFor('the private moderation list to load', () => !/Loading/.test(byId('modList').textContent), 15000);
  assert.match(byId('modList').textContent, /No messages in #Private/, 'a fresh private room is empty');

  click(byId('modRoomPublic'));
  await waitFor('the public moderation list to load', () => /hello from the jsdom browser/.test(byId('modList').textContent), 15000);
  assert.match(byId('modList').textContent, /🗑|Delete/, 'rows carry a delete control');

  doc.querySelectorAll('.tabs button').forEach((b) => { if (b.dataset.tab === 'audit') click(b); });
  await waitFor('the audit list to load', () => !/Loading/.test(byId('auditList').textContent), 15000);
  assert.match(byId('auditList').textContent, /setup/, 'the setup itself is audited');

  click(byId('panelCloseBtn'));
  await waitFor('the panel to close', () => !visible('panelSheet'));
});

test('the admin can remove a message from the bubble', async () => {
  const bubble = doc.querySelector('.msg');
  assert.ok(bubble, 'a bubble exists');
  const del = bubble.querySelector('.del-btn');
  assert.ok(del, 'admins get a delete control on every message');
  click(del);
  await waitFor('the bubble to be replaced by a notice', () => {
    return doc.querySelector('.sysmsg') && !doc.querySelector('.msg .text');
  }, 15000);
  assert.match(doc.querySelector('.sysmsg').textContent, /removed by/i);
  for (let i = 0; i < 100; i++) {
    if (readStoredPublic().length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readStoredPublic().length, 0, 'gone from disk too');
});

function readStoredPublic() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'public', 'messages.json'), 'utf8'));
  } catch { return []; }
}

test('#Private opens straight after setup because the derived key is cached in the tab', async () => {
  click(doc.querySelector('.room-btn[data-room="private"]'));
  await waitFor('the encrypted room banner', () => {
    return visible('roomBanner') && /End-to-end encrypted/.test(byId('roomBannerText').textContent);
  }, 25000);
  assert.match(byId('roomBannerText').textContent, /key #1/);
  assert.equal(byId('msgInput').placeholder, 'Encrypted message…');
  assert.equal(visible('privateSheet'), false, 'no passphrase prompt needed yet');
  const cached = win.sessionStorage.getItem('anonchat.room.session');
  assert.ok(cached, 'derived key cached for this tab only');
  assert.ok(!cached.includes(roomPassphrase), 'the passphrase itself is never stored');
});

test('locking the room wipes the key and forces the passphrase prompt', async () => {
  assert.equal(byId('roomBannerBtn').textContent, 'Lock');
  click(byId('roomBannerBtn'));
  await waitFor('back in #public', () => doc.querySelector('.room-btn[data-room="public"]').classList.contains('active'), 15000);
  assert.equal(win.sessionStorage.getItem('anonchat.room.session'), null, 'key wiped from the tab');

  click(doc.querySelector('.room-btn[data-room="private"]'));
  await waitFor('the passphrase sheet', () => visible('privateSheet'), 15000);

  type('passphraseInput', 'definitely-the-wrong-passphrase');
  click(byId('privateJoinBtn'));
  await waitFor('a rejection', () => byId('passphraseHint').classList.contains('error'), 25000);
  assert.match(byId('passphraseHint').textContent, /wrong passphrase/i);
  assert.equal(win.sessionStorage.getItem('anonchat.room.session'), null, 'a failed attempt stores nothing');

  type('passphraseInput', roomPassphrase);
  click(byId('privateJoinBtn'));
  await waitFor('the encrypted banner again', () => {
    return visible('roomBanner') && /End-to-end encrypted/.test(byId('roomBannerText').textContent);
  }, 30000);
  assert.equal(visible('privateSheet'), false);
});

test('a private message is sealed before it leaves the browser', async () => {
  const secret = 'RENEZ-VOUS-AT-MIDNIGHT-' + Date.now();
  type('msgInput', secret);
  click(byId('sendBtn'));
  await waitFor('the decrypted bubble', () => {
    const bubble = doc.querySelector('.msg .text');
    return bubble && bubble.textContent === secret;
  }, 20000);
  assert.ok(doc.querySelector('.msg .user').textContent.includes('🔒'), 'bubble is marked as sealed');

  await waitFor('the ciphertext to be written to disk', () => readStoredPrivate().length === 1, 15000);
  const raw = fs.readFileSync(path.join(dataDir, 'private', 'messages.json'), 'utf8');
  assert.ok(!raw.includes(secret), 'the server must never see the plaintext');
  const stored = readStoredPrivate()[0];
  assert.ok(stored.c && stored.n, 'ciphertext + nonce stored');
  assert.equal(stored.text, undefined);
  assert.equal(stored.ip, undefined, 'private history carries no IP address');
  assert.equal(stored.kid, 1);
});

test('the admin can remove an encrypted message and the room survives', async () => {
  const bubble = doc.querySelector('.msg');
  click(bubble.querySelector('.del-btn'));
  await waitFor('removal notice', () => doc.querySelectorAll('.msg').length === 0, 15000);
  for (let i = 0; i < 100; i++) {
    if (readStoredPrivate().length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(readStoredPrivate().length, 0);

  // Still unlocked, still able to talk.
  type('msgInput', 'second secret');
  click(byId('sendBtn'));
  await waitFor('the next message', () => {
    const b = doc.querySelector('.msg .text');
    return b && b.textContent === 'second secret';
  }, 15000);
});

test('history from before the lock is decrypted again once the room reopens', async () => {
  type('msgInput', 'still secret after relocking');
  click(byId('sendBtn'));
  await waitFor('the relocked message', () => {
    const nodes = [...doc.querySelectorAll('.msg .text')];
    return nodes.some((n) => n.textContent === 'still secret after relocking');
  }, 20000);
  // one from the sealing test (the admin removed another) plus this one
  assert.equal(readStoredPrivate().length, 2, 'two sealed messages on disk');
  const raw = fs.readFileSync(path.join(dataDir, 'private', 'messages.json'), 'utf8');
  assert.ok(!raw.includes('still secret after relocking'));
  assert.ok(!raw.includes('second secret'));
});
