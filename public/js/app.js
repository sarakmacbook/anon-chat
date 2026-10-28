/**
 * Anon Chat — browser client.
 *
 * Everything that must stay secret stays here:
 *   • the admin password and the private room passphrase are stretched with
 *     Argon2id inside this tab and only a 256 bit verifier is ever sent;
 *   • private room messages are sealed with XChaCha20-Poly1305 before they hit
 *     the socket, and private files are sealed chunk by chunk before upload;
 *   • derived keys live in memory (plus sessionStorage for the current tab
 *     only) and are dropped the moment you lock the room.
 */
import * as sec from './crypto.mjs';

const $ = (id) => document.getElementById(id);

const TOKEN_KEY = 'anonchat.admin.token';
const ROOM_SESSION_KEY = 'anonchat.room.session';
const PUSH_ASKED_KEY = 'anonchat-push-asked';
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const MIN_ADMIN_SCORE = 2;
const MIN_ROOM_SCORE = 3;
const MIN_ADMIN_LENGTH = 10;
const MIN_ROOM_LENGTH = 12;

const state = {
  socket: null,
  room: 'public',
  username: '',
  messages: [],
  admin: null,
  bootstrap: null,
  roomKey: null,
  roomVerifier: null,
  kid: 0,
  moderationOnly: false,
  pendingJoin: false,
  pendingUpload: null,
  unlocked: new Map(),
  objectUrls: new Map(),
  modRoom: 'private',
  setup: { username: '', password: '', roomPass: '' }
};

/* ------------------------------------------------------------------ utils */

function toast(message, kind) {
  const wrap = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 3800);
}

function sysMsg(text) {
  const div = document.createElement('div');
  div.className = 'sysmsg';
  div.textContent = text;
  $('messages').appendChild(div);
  maybeScroll(true);
}

function maybeScroll(force) {
  const el = $('messages');
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  if (force || nearBottom) el.scrollTop = el.scrollHeight;
}

function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(token) {
  try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const useToken = token === undefined ? getToken() : token;
  if (useToken) headers['Authorization'] = 'Bearer ' + useToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* non JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fatal(message) {
  const el = $('fatalBanner');
  el.textContent = message;
  el.classList.remove('hidden');
}

function showSheet(id) { $(id).classList.remove('hidden'); }
function hideSheet(id) { $(id).classList.add('hidden'); }

/* --------------------------------------------------- room key persistence */
/* sessionStorage only: the derived key survives a reload inside the same tab
   and vanishes when the tab closes. The passphrase itself is never stored. */

function saveRoomSession() {
  if (!state.roomKey || !state.roomVerifier) return;
  try {
    sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify({
      kid: state.kid,
      verifier: state.roomVerifier,
      key: sec.toB64(state.roomKey)
    }));
  } catch { /* storage disabled */ }
}

function loadRoomSession() {
  try {
    const raw = sessionStorage.getItem(ROOM_SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const current = state.bootstrap && state.bootstrap.room;
    if (!current || data.kid !== current.kid) return null;
    return data;
  } catch { return null; }
}

function clearRoomSession() {
  state.roomKey = null;
  state.roomVerifier = null;
  state.kid = 0;
  state.unlocked.clear();
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls.clear();
  try { sessionStorage.removeItem(ROOM_SESSION_KEY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  try {
    await sec.cryptoReady();
    state.cryptoOk = true;
  } catch (err) {
    state.cryptoOk = false;
    console.error(err);
    fatal('⚠️ The encryption engine failed to load (' + (err && err.message ? err.message : 'unknown')
      + '). The public room still works, but the private room and the setup wizard need it.');
  }
  try {
    state.bootstrap = await api('/api/bootstrap');
  } catch (err) {
    fatal('⚠️ Cannot reach the server: ' + err.message);
    return;
  }
  bindStaticUi();
  if (state.bootstrap.setupRequired) {
    // The wizard owns the first connection: setupFinish() calls startChat().
    if (state.cryptoOk) return openSetup();
    startChat();          // crypto engine is dead — let the banner explain why
    return;
  }
  startChat();
}

function startChat() {
  const socket = io();
  state.socket = socket;

  socket.on('connect', () => {
    socket.emit('admin-auth', { token: getToken() || '' });
    // Rejoin whatever room this tab was in (the private key lives in sessionStorage).
    const cached = loadRoomSession();
    if (state.room === 'private' && cached) {
      try {
        state.roomKey = sec.fromB64(cached.key);
        state.roomVerifier = cached.verifier;
        state.kid = cached.kid;
        state.pendingJoin = true;
        socket.emit('join-room', { room: 'private', verifier: cached.verifier });
        return;
      } catch { clearRoomSession(); }
    }
    socket.emit('join-room', { room: 'public' });
  });

  socket.on('welcome', (data) => {
    state.username = data.username;
  });

  socket.on('room-joined', (data) => {
    state.room = data.room;
    state.messages = Array.isArray(data.messages) ? data.messages.slice() : [];
    state.pendingUpload = null;
    state.pendingJoin = false;
    state.moderationOnly = Boolean(data.moderationOnly);
    if (data.room === 'private' && data.kid) state.kid = data.kid;
    $('online').textContent = data.users + ' online';
    renderAll();
    updateRoomButtons();
    updateRoomBanner();
    if (data.room === 'private') maybeShowPushBanner();
  });

  socket.on('message', (msg) => {
    if (!msg || msg.room !== state.room) return;
    state.messages.push(msg);
    $('messages').appendChild(buildBubble(msg));
    maybeScroll();
  });

  socket.on('message-deleted', (data) => {
    state.messages = state.messages.filter((m) => m.id !== data.id);
    const el = document.querySelector('.msg[data-id="' + cssEscape(data.id) + '"]');
    if (el) {
      const note = document.createElement('div');
      note.className = 'sysmsg';
      note.textContent = '🗑 message removed by ' + (data.by || 'admin');
      el.replaceWith(note);
    }
    state.unlocked.delete(data.id);
  });

  socket.on('room-purged', () => {
    state.messages = [];
    state.unlocked.clear();
    renderAll();
    sysMsg('🗑 History cleared by an admin');
  });

  socket.on('room-key-changed', async () => {
    clearRoomSession();
    try { state.bootstrap = await api('/api/bootstrap'); } catch { /* keep old */ }
    if (state.room === 'private') {
      renderAll();
      updateRoomBanner();
      toast('The private room key was rotated. Enter the new passphrase.', 'error');
      showSheet('privateSheet');
    }
  });

  socket.on('admin-state', (data) => {
    state.admin = data && data.isAdmin ? { username: data.username, expiresAt: data.expiresAt } : null;
    updateAdminButton();
    renderAll();
  });

  socket.on('admin-action', () => { /* deletions arrive as message-deleted */ });

  socket.on('user-joined', (data) => {
    $('online').textContent = data.users + ' online';
    sysMsg(data.username + ' joined');
  });

  socket.on('user-left', (data) => {
    $('online').textContent = data.users + ' online';
    sysMsg(data.username + ' left');
  });

  socket.on('user-renamed', (data) => sysMsg(data.oldName + ' is now ' + data.newName));
  socket.on('name-changed', (data) => {
    state.username = data.username;
    sysMsg('You are now: ' + state.username);
    renderAll();
  });

  socket.on('error-msg', (data) => {
    toast(data.message, 'error');
    if (state.pendingJoin) {
      state.pendingJoin = false;
      clearRoomSession();
      $('privateJoinBtn').disabled = false;
      $('privateJoinBtn').textContent = 'Unlock';
      showSheet('privateSheet');
      $('passphraseHint').textContent = data.message;
      $('passphraseHint').className = 'hint error';
    }
  });

  socket.on('disconnect', () => {
    sysMsg('Connection lost — reconnecting…');
  });

  socket.on('connect_error', () => { /* socket.io retries on its own */ });
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/* -------------------------------------------------------------- rendering */

function renderAll() {
  const wrap = $('messages');
  wrap.innerHTML = '';
  state.messages.forEach((msg) => wrap.appendChild(buildBubble(msg)));
  maybeScroll(true);
}

function isEncrypted(msg) {
  return Boolean(msg && typeof msg.c === 'string');
}

function buildBubble(msg) {
  const el = document.createElement('div');
  el.className = 'msg ' + (msg.username === state.username ? 'self' : 'other');
  el.dataset.id = msg.id;

  const head = document.createElement('div');
  head.className = 'user';
  head.textContent = (msg.username || 'anon') + (isEncrypted(msg) ? ' 🔒' : '');
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'body';
  el.appendChild(body);

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(msg.time);
  el.appendChild(time);

  if (state.admin) {
    const del = document.createElement('button');
    del.className = 'del-btn';
    del.title = 'Remove this message (admin)';
    del.textContent = '🗑';
    del.addEventListener('click', () => confirmDelete(msg));
    el.appendChild(del);
  }

  fillBody(body, msg);
  return el;
}

function fillBody(body, msg) {
  body.innerHTML = '';

  if (isEncrypted(msg)) {
    if (!state.roomKey) {
      body.appendChild(lockedNote(state.moderationOnly
        ? '🔒 End-to-end encrypted — moderation view, content unavailable'
        : '🔒 Encrypted — unlock the room to read'));
      return;
    }
    if (msg.kid && state.kid && msg.kid !== state.kid) {
      body.appendChild(lockedNote('🔒 Sealed with an older room key (key #' + msg.kid + ')'));
      return;
    }
    let envelope = state.unlocked.get(msg.id);
    if (!envelope) {
      try {
        envelope = JSON.parse(sec.decryptText(state.roomKey, msg.c, msg.n));
      } catch (err) {
        body.appendChild(lockedNote('⚠️ Could not decrypt this message'));
        return;
      }
      state.unlocked.set(msg.id, envelope);
    }
    renderEnvelope(body, msg, envelope);
    return;
  }

  // Public room (and anything written by an older, unencrypted build)
  if (msg.text) {
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = msg.text;
    body.appendChild(text);
  }
  if (msg.file) body.appendChild(buildPlainFile(msg.file));
  if (!msg.text && !msg.file) body.appendChild(lockedNote('(empty message)'));
}

function lockedNote(text) {
  const el = document.createElement('div');
  el.className = 'locked-note';
  el.textContent = text;
  return el;
}

function buildPlainFile(file) {
  const wrap = document.createElement('div');
  if (file.type && file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = file.url;
    img.alt = file.name || 'image';
    img.loading = 'lazy';
    img.addEventListener('click', () => showImage(file.url));
    wrap.appendChild(img);
  } else {
    const a = document.createElement('a');
    a.href = file.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'file-link';
    a.textContent = '📎 ' + (file.name || 'File');
    wrap.appendChild(a);
  }
  return wrap;
}

function renderEnvelope(body, msg, envelope) {
  if (envelope && envelope.t) {
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = envelope.t;
    body.appendChild(text);
  }
  if (envelope && envelope.f && msg.file) {
    body.appendChild(buildPrivateFile(msg, envelope.f));
  } else if (msg.file) {
    // Metadata survived but the envelope did not name a file — offer a raw unlock.
    body.appendChild(buildPrivateFile(msg, { name: 'encrypted-file', type: 'application/octet-stream', size: 0 }));
  }
}

function buildPrivateFile(msg, meta) {
  const wrap = document.createElement('div');
  const isImage = /^image\//i.test(meta.type || '');
  const auto = isImage && Number(meta.size || 0) <= sec.AUTO_DECRYPT_MAX_BYTES && Number(meta.size || 0) > 0;

  if (auto) {
    const img = document.createElement('img');
    img.alt = meta.name || 'image';
    const spin = document.createElement('div');
    spin.className = 'pending';
    spin.textContent = '🔓 decrypting image…';
    wrap.appendChild(spin);
    wrap.appendChild(img);
    decryptToUrl(msg, meta)
      .then((url) => {
        img.src = url;
        img.addEventListener('click', () => showImage(url));
        spin.remove();
      })
      .catch((err) => {
        spin.textContent = '⚠️ ' + (err.message || 'decrypt failed');
      });
    return wrap;
  }

  const chip = document.createElement('div');
  chip.className = 'file-chip';
  const name = document.createElement('span');
  name.className = 'fc-name';
  name.textContent = '🔒 ' + (meta.name || 'encrypted file');
  chip.appendChild(name);
  if (meta.size) {
    const size = document.createElement('span');
    size.className = 'fc-size';
    size.textContent = formatSize(meta.size);
    chip.appendChild(size);
  }
  const btn = document.createElement('button');
  btn.textContent = 'Unlock';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const url = await decryptToUrl(msg, meta);
      if (isImage) { showImage(url); btn.textContent = 'View'; }
      else {
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name || 'file';
        document.body.appendChild(a);
        a.click();
        a.remove();
        btn.textContent = 'Download again';
      }
    } catch (err) {
      toast(err.message || 'Could not decrypt file', 'error');
      btn.textContent = 'Retry';
    }
    btn.disabled = false;
  });
  chip.appendChild(btn);
  wrap.appendChild(chip);
  return wrap;
}

async function decryptToUrl(msg, meta) {
  if (state.objectUrls.has(msg.id)) return state.objectUrls.get(msg.id);
  if (!state.roomKey) throw new Error('Room is locked');
  if (Number(meta.size || 0) > sec.DECRYPT_CONFIRM_BYTES) {
    if (!confirm('This file is ' + formatSize(meta.size) + '. Decrypting pulls it fully into this tab. Continue?')) {
      throw new Error('Cancelled');
    }
  }
  const res = await fetch(meta.url || msg.file.url);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  const sealed = await res.blob();
  const plain = await sec.decryptBlob(state.roomKey, sealed, meta.type || 'application/octet-stream');
  const url = URL.createObjectURL(plain);
  state.objectUrls.set(msg.id, url);
  return url;
}

function showImage(url) {
  $('modalImg').src = url;
  $('imageModal').classList.add('show');
}

function updateRoomButtons() {
  document.querySelectorAll('.room-btn[data-room]').forEach((b) => {
    b.classList.toggle('active', b.dataset.room === state.room);
  });
  const unlocked = state.room === 'private' && Boolean(state.roomKey);
  const privateBtn = document.querySelector('.room-btn[data-room="private"]');
  if (privateBtn) privateBtn.textContent = unlocked ? '#Private 🔓' : '#Private 🔒';
  $('msgInput').placeholder = state.room === 'private'
    ? (state.roomKey ? 'Encrypted message…' : 'Unlock the room to send')
    : 'Type a message...';
}

function updateRoomBanner() {
  const banner = $('roomBanner');
  const text = $('roomBannerText');
  const btn = $('roomBannerBtn');
  banner.className = 'room-banner';
  btn.classList.add('hidden');

  if (state.room !== 'private') {
    if (!state.bootstrap || state.bootstrap.setupRequired) {
      banner.classList.remove('hidden');
      banner.classList.add('warn');
      text.textContent = '⚠️ This server has not been configured yet.';
      return;
    }
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  if (state.moderationOnly || !state.roomKey) {
    banner.classList.add(state.moderationOnly ? 'moderation' : 'warn');
    text.textContent = state.moderationOnly
      ? '🛡️ Moderation mode — you can remove messages, but content stays end-to-end encrypted.'
      : '🔒 This room is locked. Enter the passphrase to read and write.';
    btn.textContent = state.moderationOnly ? 'Unlock' : 'Enter passphrase';
    btn.classList.remove('hidden');
    btn.onclick = () => showSheet('privateSheet');
    return;
  }
  const legacy = state.messages.filter((m) => !isEncrypted(m)).length;
  text.innerHTML = '';
  text.textContent = '🔐 End-to-end encrypted · Argon2id + XChaCha20-Poly1305 · key #' + (state.kid || '?')
    + (legacy ? ' · ' + legacy + ' legacy unencrypted message(s) in history' : '');
  btn.textContent = 'Lock';
  btn.classList.remove('hidden');
  btn.onclick = () => {
    clearRoomSession();
    state.socket.emit('join-room', { room: 'public' });
    toast('Private room locked', 'ok');
  };
}

function updateAdminButton() {
  const btn = $('adminBtn');
  if (state.admin) {
    btn.textContent = '🛡️ ' + state.admin.username;
    btn.classList.add('admin-on');
    btn.title = 'Open admin panel';
  } else {
    btn.textContent = '🛡️ Admin';
    btn.classList.remove('admin-on');
    btn.title = 'Sign in as admin';
  }
}

/* --------------------------------------------------------------- sending */

const MAX_TEXT = 4000;

function sendMessage() {
  const text = $('msgInput').value.trim();
  if (!text && !state.pendingUpload) return;
  if (!state.socket || !state.socket.connected) return toast('Not connected yet', 'error');
  if (text.length > MAX_TEXT) return toast('Message too long (' + text.length + '/' + MAX_TEXT + ')', 'error');

  if (state.room === 'private') {
    if (!state.roomKey) return toast('Unlock the private room first', 'error');
    const envelope = JSON.stringify({
      v: 1,
      t: text,
      f: state.pendingUpload ? state.pendingUpload.meta : null
    });
    let sealed;
    try {
      sealed = sec.encryptText(state.roomKey, envelope);
    } catch (err) {
      return toast('Encryption failed: ' + err.message, 'error');
    }
    state.socket.emit('message', {
      room: 'private',
      enc: sealed,
      kid: state.kid,
      file: state.pendingUpload ? { id: state.pendingUpload.id, url: state.pendingUpload.url } : undefined
    });
  } else {
    state.socket.emit('message', {
      room: 'public',
      text,
      file: state.pendingUpload
        ? { id: state.pendingUpload.id, url: state.pendingUpload.url, name: state.pendingUpload.meta.name, type: state.pendingUpload.meta.type }
        : undefined
    });
  }
  $('msgInput').value = '';
  state.pendingUpload = null;
}

function confirmDelete(msg) {
  const where = msg.room === 'private' ? '#Private' : '#Public';
  const who = msg.username || 'anon';
  if (!confirm('Remove this message from ' + where + '?\n\nSender: ' + who + '\nTime: ' + formatTime(msg.time) + '\n\nAny attached file is deleted from disk too.')) return;
  state.socket.emit('delete-message', { room: msg.room || state.room, id: msg.id });
}

async function handleFilePick() {
  const input = $('fileInput');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (state.room === 'private' && !state.roomKey) {
    return toast('Unlock the private room before attaching files', 'error');
  }

  const overlay = $('loadingOverlay');
  const card = overlay.querySelector('.loading-card');
  card.className = 'loading-card';
  overlay.classList.add('show');
  $('loadingFileName').textContent = file.name;

  const setStage = (label, icon) => {
    $('loadingStage').textContent = label;
    if (icon) $('loadingIcon').textContent = icon;
  };
  const setProgress = (ratio, loaded, total) => {
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    $('progressFill').style.width = pct + '%';
    $('progressPercent').textContent = pct + '%';
    if (loaded !== undefined && total !== undefined) {
      $('progressInfo').textContent = formatSize(loaded) + ' / ' + formatSize(total);
    }
  };

  try {
    let payload = file;
    const meta = { name: file.name, type: file.type || 'application/octet-stream', size: file.size };

    if (state.room === 'private') {
      setStage('Encrypting (in your browser)', '🔐');
      setProgress(0, 0, file.size);
      payload = await sec.encryptBlob(state.roomKey, file, (p) => setProgress(p, p * file.size, file.size));
    }

    setStage('Uploading', '📤');
    setProgress(0, 0, payload.size);
    const result = await uploadWithProgress(payload, state.room, state.room === 'private' ? 'upload.bin' : file.name, setProgress);

    state.pendingUpload = { id: result.id, url: result.url, meta };
    card.classList.add('complete');
    $('progressFill').style.width = '100%';
    $('progressPercent').textContent = '100%';
    setStage(state.room === 'private' ? 'Sealed & uploaded — press Send' : 'Uploaded — press Send', '✅');
    setTimeout(() => overlay.classList.remove('show'), 700);
  } catch (err) {
    card.classList.add('error');
    setStage('Failed', '⚠️');
    $('progressPercent').textContent = 'Failed';
    toast(err.message || 'Upload failed', 'error');
    setTimeout(() => overlay.classList.remove('show'), 1600);
  }
}

function uploadWithProgress(payload, room, filename, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    // 'room' must come first: multer decides the destination directory while it
    // is still reading the multipart stream.
    form.append('room', room);
    form.append('file', payload, filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total, e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200 && data && data.url) return resolve(data);
      reject(new Error((data && data.error) || 'Upload failed (' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

/* -------------------------------------------------------- private room UI */

function requestPrivateRoom() {
  const cached = loadRoomSession();
  if (cached && state.bootstrap && state.bootstrap.room) {
    try {
      state.roomKey = sec.fromB64(cached.key);
      state.roomVerifier = cached.verifier;
      state.kid = cached.kid;
      state.pendingJoin = true;
      state.socket.emit('join-room', { room: 'private', verifier: cached.verifier });
      return;
    } catch { clearRoomSession(); }
  }
  $('passphraseHint').textContent = 'Deriving keys takes a second — that delay is the point.';
  $('passphraseHint').className = 'hint';
  $('passphraseInput').value = '';
  showSheet('privateSheet');
  setTimeout(() => $('passphraseInput').focus(), 40);
}

async function submitPassphrase() {
  const passphrase = $('passphraseInput').value;
  const hint = $('passphraseHint');
  const btn = $('privateJoinBtn');
  if (!passphrase) { hint.textContent = 'Enter the passphrase'; hint.className = 'hint error'; return; }
  if (!state.bootstrap || !state.bootstrap.room) { hint.textContent = 'Server not configured'; hint.className = 'hint error'; return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Deriving';
  hint.textContent = 'Running Argon2id…';
  hint.className = 'hint';
  try {
    const { roomKey, verifier } = await sec.deriveRoomKeys(passphrase, state.bootstrap.room.salt);
    state.roomKey = roomKey;
    state.roomVerifier = verifier;
    state.kid = state.bootstrap.room.kid;
    saveRoomSession();
    state.pendingJoin = true;
    state.socket.emit('join-room', { room: 'private', verifier });
    hideSheet('privateSheet');
    $('passphraseInput').value = '';
    btn.disabled = false;
    btn.textContent = 'Unlock';
  } catch (err) {
    hint.textContent = err.message || 'Key derivation failed';
    hint.className = 'hint error';
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

/* ------------------------------------------------------------------ admin */

function generatePassphraseOrWarn() {
  try {
    return sec.generatePassphrase();
  } catch (err) {
    toast('Random generator unavailable: ' + err.message, 'error');
    return '';
  }
}

function openAdminSheet() {
  $('adminLoginError').classList.add('hidden');
  $('adminPassInput').value = '';
  if (state.admin) $('adminUserInput').value = state.admin.username;
  showSheet('adminSheet');
  setTimeout(() => ($(state.admin ? 'adminPassInput' : 'adminUserInput')).focus(), 40);
}

async function submitAdminLogin() {
  const username = $('adminUserInput').value.trim();
  const password = $('adminPassInput').value;
  const errEl = $('adminLoginError');
  const btn = $('adminLoginBtn');
  errEl.classList.add('hidden');
  if (!username || !password) {
    errEl.textContent = 'Enter both username and password';
    errEl.classList.remove('hidden');
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Deriving';
  try {
    const verifier = await sec.deriveAdminVerifier(username, password);
    const data = await api('/api/admin/login', { method: 'POST', body: { username, verifier }, token: null });
    setToken(data.token);
    state.socket.emit('admin-auth', { token: data.token });
    $('adminPassInput').value = '';
    hideSheet('adminSheet');
    toast('Signed in as ' + data.username, 'ok');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function adminLogout() {
  const token = getToken();
  setToken(null);
  state.admin = null;
  if (state.socket) state.socket.emit('admin-auth', { token: '' });
  if (token) api('/api/admin/logout', { method: 'POST', body: {}, token }).catch(() => {});
  hideSheet('panelSheet');
  updateAdminButton();
  renderAll();
  toast('Signed out', 'ok');
}

async function openPanel() {
  showSheet('panelSheet');
  switchTab('overview');
  $('panelSub').textContent = 'Signed in as ' + state.admin.username
    + (state.admin.expiresAt ? ' · session ends ' + new Date(state.admin.expiresAt).toLocaleString() : '');
  await refreshStats();
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (name === 'moderate') refreshModeration();
  if (name === 'audit') refreshAudit();
  if (name === 'security') {
    $('newAdminUser').value = state.admin ? state.admin.username : '';
  }
}

async function refreshStats() {
  try {
    const stats = await api('/api/admin/stats');
    const grid = $('statsGrid');
    grid.innerHTML = '';
    const cells = [
      ['Public messages', stats.public.messages],
      ['Public online', stats.public.online],
      ['Private messages', stats.private.messages],
      ['Private online', stats.private.online],
      ['Legacy unencrypted', stats.private.legacyUnencrypted],
      ['Stored files', stats.files],
      ['Room key id', stats.room ? '#' + stats.room.kid : '—'],
      ['Admin', state.admin ? state.admin.username : '—']
    ];
    cells.forEach(([k, v]) => {
      const box = document.createElement('div');
      box.className = 'stat';
      const key = document.createElement('div'); key.className = 'k'; key.textContent = k;
      const val = document.createElement('div'); val.className = 'v'; val.textContent = v;
      box.appendChild(key); box.appendChild(val);
      grid.appendChild(box);
    });
    $('cryptoNote').textContent = 'Client KDF: Argon2id (m=' + Math.round(stats.clientKdf.memlimit / 1048576)
      + ' MiB, t=' + stats.clientKdf.opslimit + ') · Server KDF: ' + stats.serverKdf
      + ' · Cipher: XChaCha20-Poly1305 · Session TTL: ' + Math.round(stats.tokenTtlMs / 3600000) + ' h';
    const warn = $('legacyWarn');
    if (stats.private.legacyUnencrypted > 0) {
      warn.textContent = '⚠️ ' + stats.private.legacyUnencrypted
        + ' private message(s) predate encryption and are stored in clear text. Remove them from the Moderate tab.';
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
  } catch (err) {
    toast(err.message, 'error');
    if (err.status === 401) adminLogout();
  }
}

async function refreshModeration() {
  const list = $('modList');
  list.innerHTML = '<div class="meta-row"><span class="mr-user">Loading…</span></div>';
  try {
    const data = await api('/api/admin/messages/' + state.modRoom);
    list.innerHTML = '';
    if (!data.messages.length) {
      list.innerHTML = '<div class="meta-row"><span class="mr-user">No messages in ' + (state.modRoom === 'private' ? '#Private' : '#Public') + '</span></div>';
      return;
    }
    data.messages.slice().reverse().forEach((m) => {
      const row = document.createElement('div');
      row.className = 'meta-row';
      const time = document.createElement('span'); time.className = 'mr-time'; time.textContent = formatTime(m.time);
      const user = document.createElement('span'); user.className = 'mr-user';
      user.textContent = m.username + (state.modRoom === 'public' && m.text ? ' — ' + m.text.slice(0, 60) : '');
      const tag = document.createElement('span'); tag.className = 'mr-tag';
      tag.textContent = (m.encrypted ? '🔒 sealed' : (state.modRoom === 'private' ? '⚠️ legacy' : 'plain')) + (m.hasFile ? ' 📎' : '');
      const btn = document.createElement('button');
      btn.className = 'btn small danger';
      btn.textContent = 'Delete';
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this message and its file?')) return;
        btn.disabled = true;
        try {
          await api('/api/admin/messages/' + state.modRoom + '/' + encodeURIComponent(m.id), { method: 'DELETE' });
          row.remove();
          toast('Message removed', 'ok');
        } catch (err) {
          btn.disabled = false;
          toast(err.message, 'error');
        }
      });
      row.appendChild(time); row.appendChild(user); row.appendChild(tag); row.appendChild(btn);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '';
    toast(err.message, 'error');
    if (err.status === 401) adminLogout();
  }
}

async function refreshAudit() {
  const list = $('auditList');
  list.innerHTML = '<div class="meta-row"><span class="mr-user">Loading…</span></div>';
  try {
    const data = await api('/api/admin/audit?limit=120');
    list.innerHTML = '';
    if (!data.entries.length) {
      list.innerHTML = '<div class="meta-row"><span class="mr-user">Nothing logged yet</span></div>';
      return;
    }
    data.entries.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'meta-row';
      const time = document.createElement('span'); time.className = 'mr-time'; time.textContent = formatTime(e.ts);
      const what = document.createElement('span'); what.className = 'mr-user';
      what.textContent = e.action + (e.actor ? ' · ' + e.actor : '') + (e.detail ? ' · ' + e.detail : '') + (e.room ? ' · #' + e.room : '');
      row.appendChild(time); row.appendChild(what);
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = '';
    toast(err.message, 'error');
  }
}

const strengthPainters = {};

/** Wire a password field to its strength meter. Registers the listener once. */
function paintStrength(inputId, barId, labelId, minScore, minLength) {
  const inputEl = $(inputId);
  const barEl = $(barId);
  const labelEl = $(labelId);
  const handler = () => {
    const result = sec.assessStrength(inputEl.value);
    barEl.className = 'strength s' + (result.score + 1);
    labelEl.textContent = inputEl.value
      ? result.label + ' · ~' + result.bits + ' bits' + (result.hints.length ? ' — ' + result.hints[0] : '')
      : '';
    labelEl.style.color = result.score >= minScore && inputEl.value.length >= minLength ? 'var(--accent)' : 'var(--muted)';
  };
  inputEl.addEventListener('input', handler);
  strengthPainters[inputId] = handler;
}

function repaint(inputId) {
  if (strengthPainters[inputId]) strengthPainters[inputId]();
}

async function changeAdminPassword() {
  const username = $('newAdminUser').value.trim();
  const password = $('newAdminPass').value;
  if (!USERNAME_RE.test(username)) return toast('Invalid username', 'error');
  const strength = sec.assessStrength(password);
  if (password.length < MIN_ADMIN_LENGTH || strength.score < MIN_ADMIN_SCORE) {
    return toast('Password too weak — at least ' + MIN_ADMIN_LENGTH + ' characters and a "Fair" rating', 'error');
  }
  const btn = $('saveAdminBtn');
  btn.disabled = true;
  try {
    const verifier = await sec.deriveAdminVerifier(username, password);
    const data = await api('/api/admin/password', { method: 'POST', body: { username, verifier } });
    setToken(data.token);
    state.admin = { username: data.username, expiresAt: Date.now() + data.expiresIn };
    state.socket.emit('admin-auth', { token: data.token });
    $('newAdminPass').value = '';
    $('panelSub').textContent = 'Signed in as ' + data.username;
    toast('Admin credentials updated', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function rotateRoomKey() {
  const passphrase = $('newRoomPass').value;
  const strength = sec.assessStrength(passphrase);
  if (passphrase.length < MIN_ROOM_LENGTH || strength.score < MIN_ROOM_SCORE) {
    return toast('Passphrase too weak — at least ' + MIN_ROOM_LENGTH + ' characters and a "Strong" rating', 'error');
  }
  if (!$('roomSavedConfirm').checked) return toast('Confirm you have saved the new passphrase', 'error');
  if (!confirm('Rotate the private room key?\n\nEveryone currently inside is kicked back to the passphrase prompt and all existing private messages become permanently unreadable.')) return;

  const btn = $('rotateRoomBtn');
  btn.disabled = true;
  try {
    const salt = sec.toB64(sec.randomBytes(16));
    const { roomKey, verifier } = await sec.deriveRoomKeys(passphrase, salt);
    const data = await api('/api/admin/room/rotate', { method: 'POST', body: { verifier, salt } });
    state.kid = data.room.kid;
    state.roomKey = roomKey;
    state.roomVerifier = verifier;
    state.bootstrap.room = { kid: data.room.kid, salt: data.room.salt };
    saveRoomSession();
    state.unlocked.clear();
    $('newRoomPass').value = '';
    $('roomSavedConfirm').checked = false;
    renderAll();
    updateRoomBanner();
    updateRoomButtons();
    toast('Room key rotated — new key #' + data.room.kid, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function purge(kind) {
  const confirmText = {
    legacy: 'Delete every private message stored in clear text by an older version?\n\nThis cannot be undone.',
    private: 'Delete ALL #Private messages and their files?\n\nThis cannot be undone.',
    public: 'Delete ALL #Public messages and their files?\n\nThis cannot be undone.'
  }[kind];
  if (!confirm(confirmText)) return;
  try {
    if (kind === 'legacy') {
      const data = await api('/api/admin/legacy', { method: 'DELETE' });
      toast('Removed ' + data.removed + ' legacy message(s)', 'ok');
    } else {
      const room = kind === 'private' ? 'private' : 'public';
      const data = await api('/api/admin/messages/' + room, { method: 'DELETE' });
      toast('Cleared ' + data.removed + ' message(s)', 'ok');
    }
    await refreshStats();
    refreshModeration();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------ setup wizard */

function openSetup() {
  state.setup = { username: '', password: '', roomPass: '' };
  state.adminOnlySetup = Boolean(state.bootstrap && state.bootstrap.needAdmin && !state.bootstrap.needRoom);
  $('setupSteps').classList.toggle('hidden', state.adminOnlySetup);
  $('setupTitle3').textContent = state.adminOnlySetup ? '✅ Confirm the new admin account' : '✅ Save your credentials';
  $('setupSub3').textContent = state.adminOnlySetup
    ? 'The private room key already exists, so it is left untouched and existing encrypted messages stay readable.'
    : 'This is the only time the private room passphrase is displayed. Copy it somewhere safe.';
  $('setupRoomField').classList.toggle('hidden', state.adminOnlySetup);
  $('savedConfirmLine').classList.toggle('hidden', state.adminOnlySetup);
  showSheet('setupSheet');
  gotoStep(1);
  setTimeout(() => $('setupUser').focus(), 60);
}

function gotoStep(n) {
  document.querySelectorAll('#setupSheet section[data-step]').forEach((s) => s.classList.toggle('hidden', s.dataset.step !== String(n)));
  const dots = document.querySelectorAll('#setupSteps .dot');
  dots.forEach((d, i) => {
    d.className = 'dot' + (i + 1 === n ? ' on' : (i + 1 < n ? ' done' : ''));
  });
}

function setupError(message, elementId) {
  const el = $(elementId);
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

function setupStep1() {
  const username = $('setupUser').value.trim();
  const password = $('setupPass').value;
  const again = $('setupPass2').value;
  if (!USERNAME_RE.test(username)) return setupError('Username must be 3–32 characters: letters, digits, dot, underscore, dash.', 'setupError');
  if (password.length < MIN_ADMIN_LENGTH) return setupError('Use at least ' + MIN_ADMIN_LENGTH + ' characters.', 'setupError');
  const strength = sec.assessStrength(password);
  if (strength.score < MIN_ADMIN_SCORE) return setupError('That password is too weak (' + strength.label + '). ' + (strength.hints[0] || ''), 'setupError');
  if (password !== again) return setupError('Passwords do not match.', 'setupError');
  state.setup.username = username;
  state.setup.password = password;
  $('setupError').classList.add('hidden');
  if (state.adminOnlySetup) {
    $('reviewUser').textContent = username;
    gotoStep(3);
    return;
  }
  gotoStep(2);
  setTimeout(() => $('setupRoomPass').focus(), 40);
}

function setupStep2() {
  const pass = $('setupRoomPass').value;
  const again = $('setupRoomPass2').value;
  if (pass.length < MIN_ROOM_LENGTH) return setupError('Use at least ' + MIN_ROOM_LENGTH + ' characters — this is an encryption key.', 'setupRoomError');
  const strength = sec.assessStrength(pass);
  if (strength.score < MIN_ROOM_SCORE) return setupError('Too weak (' + strength.label + '). Tap 🎲 Generate for a strong one.', 'setupRoomError');
  if (pass !== again) return setupError('Passphrases do not match.', 'setupRoomError');
  if (pass === state.setup.password) return setupError('Use something different from the admin password.', 'setupRoomError');
  state.setup.roomPass = pass;
  $('setupRoomError').classList.add('hidden');
  $('reviewUser').textContent = state.setup.username;
  $('reviewRoom').textContent = pass;
  gotoStep(3);
}

async function setupFinish() {
  const adminOnly = state.adminOnlySetup;
  if (!adminOnly && !$('savedConfirm').checked) {
    return setupError('Please confirm you saved the passphrase.', 'setupFinishError');
  }
  const btn = $('setupFinishBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Deriving keys';
  try {
    const adminVerifier = await sec.deriveAdminVerifier(state.setup.username, state.setup.password);
    let roomKey = null;
    let roomVerifier = null;
    let roomSalt = null;
    if (!adminOnly) {
      roomSalt = sec.toB64(sec.randomBytes(16));
      const derived = await sec.deriveRoomKeys(state.setup.roomPass, roomSalt);
      roomKey = derived.roomKey;
      roomVerifier = derived.verifier;
    }
    const data = await api('/api/setup', {
      method: 'POST',
      token: null,
      body: {
        adminUsername: state.setup.username,
        adminVerifier,
        roomVerifier: roomVerifier || undefined,
        roomSalt: roomSalt || undefined
      }
    });
    setToken(data.token);
    state.bootstrap = await api('/api/bootstrap');
    if (roomKey) {
      state.kid = data.room.kid;
      state.roomKey = roomKey;
      state.roomVerifier = roomVerifier;
      saveRoomSession();
    }
    // Drop the plaintext copies as early as JS lets us.
    state.setup.password = '';
    state.setup.roomPass = '';
    $('setupPass').value = ''; $('setupPass2').value = '';
    $('setupRoomPass').value = ''; $('setupRoomPass2').value = '';
    if (!adminOnly) $('reviewRoom').textContent = '••••••••••••';
    hideSheet('setupSheet');
    toast('Setup complete — you are signed in as ' + data.username, 'ok');
    startChat();
  } catch (err) {
    setupError(err.message, 'setupFinishError');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Finish setup';
  }
}

/* ------------------------------------------------------------- static UI */

function bindStaticUi() {
  $('imageModal').addEventListener('click', function () { this.classList.remove('show'); });

  document.querySelectorAll('.room-btn[data-room]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const room = btn.dataset.room;
      if (!state.socket) return toast('Loading…', 'error');
      if (room === state.room) return;
      if (room === 'private') return requestPrivateRoom();
      state.socket.emit('join-room', { room: 'public' });
    });
  });

  $('sendBtn').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
  $('fileInput').addEventListener('change', handleFilePick);

  // display name
  $('setNameBtn').addEventListener('click', () => {
    $('nameInput').value = state.username;
    showSheet('nameSheet');
    setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 40);
  });
  const saveName = () => {
    const name = $('nameInput').value.trim();
    if (name && state.socket) state.socket.emit('set-name', { name });
    hideSheet('nameSheet');
  };
  $('nameSaveBtn').addEventListener('click', saveName);
  $('nameCancelBtn').addEventListener('click', () => hideSheet('nameSheet'));
  $('nameInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') saveName(); });

  // private room sheet
  $('privateJoinBtn').addEventListener('click', submitPassphrase);
  $('privateCancelBtn').addEventListener('click', () => hideSheet('privateSheet'));
  $('passphraseInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') submitPassphrase(); });

  // admin
  $('adminBtn').addEventListener('click', () => (state.admin ? openPanel() : openAdminSheet()));
  $('adminLoginBtn').addEventListener('click', submitAdminLogin);
  $('adminCancelBtn').addEventListener('click', () => hideSheet('adminSheet'));
  $('adminPassInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') submitAdminLogin(); });
  $('panelCloseBtn').addEventListener('click', () => hideSheet('panelSheet'));
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('modRoomPublic').addEventListener('click', () => {
    state.modRoom = 'public';
    $('modRoomPublic').classList.add('primary'); $('modRoomPrivate').classList.remove('primary');
    refreshModeration();
  });
  $('modRoomPrivate').addEventListener('click', () => {
    state.modRoom = 'private';
    $('modRoomPrivate').classList.add('primary'); $('modRoomPublic').classList.remove('primary');
    refreshModeration();
  });
  $('modRefresh').addEventListener('click', refreshModeration);
  $('purgeLegacyBtn').addEventListener('click', () => purge('legacy'));
  $('purgePrivateBtn').addEventListener('click', () => purge('private'));
  $('purgePublicBtn').addEventListener('click', () => purge('public'));
  $('saveAdminBtn').addEventListener('click', changeAdminPassword);
  $('rotateRoomBtn').addEventListener('click', rotateRoomKey);
  $('logoutBtn').addEventListener('click', adminLogout);
  $('genRoomBtn').addEventListener('click', () => {
    $('newRoomPass').value = generatePassphraseOrWarn();
    $('newRoomPass').type = 'text';
    repaint('newRoomPass');
  });
  paintStrength('newAdminPass', 'adminPwStrength', 'adminPwLabel', MIN_ADMIN_SCORE, MIN_ADMIN_LENGTH);
  paintStrength('newRoomPass', 'roomPwStrength', 'roomPwLabel', MIN_ROOM_SCORE, MIN_ROOM_LENGTH);

  // setup wizard
  $('setupNext1').addEventListener('click', setupStep1);
  $('setupNext2').addEventListener('click', setupStep2);
  $('setupBack2').addEventListener('click', () => gotoStep(1));
  $('setupBack3').addEventListener('click', () => gotoStep(2));
  $('setupFinishBtn').addEventListener('click', setupFinish);
  $('setupPass2').addEventListener('keypress', (e) => { if (e.key === 'Enter') setupStep1(); });
  $('setupRoomPass2').addEventListener('keypress', (e) => { if (e.key === 'Enter') setupStep2(); });
  $('toggleSetupPass').addEventListener('click', () => {
    const el = $('setupPass');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('toggleSetupRoom').addEventListener('click', () => {
    const el = $('setupRoomPass');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('genSetupRoom').addEventListener('click', () => {
    const generated = generatePassphraseOrWarn();
    if (!generated) return;
    $('setupRoomPass').value = generated;
    $('setupRoomPass2').value = generated;
    $('setupRoomPass').type = 'text';
    repaint('setupRoomPass');
  });
  $('copyRoomBtn').addEventListener('click', async () => {
    const value = $('reviewRoom').textContent;
    try {
      await navigator.clipboard.writeText(value);
      toast('Passphrase copied', 'ok');
    } catch {
      toast('Copy blocked — select the text manually', 'error');
    }
  });
  paintStrength('setupPass', 'setupStrength', 'setupStrengthLabel', MIN_ADMIN_SCORE, MIN_ADMIN_LENGTH);
  paintStrength('setupRoomPass', 'roomStrength', 'roomStrengthLabel', MIN_ROOM_SCORE, MIN_ROOM_LENGTH);

  // close sheets on backdrop click
  ['privateSheet', 'nameSheet', 'adminSheet', 'panelSheet'].forEach((id) => {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) hideSheet(id); });
  });
}

/* ------------------------------------------------------- web push client */

const pushBanner = () => $('pushBanner');

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers unsupported');
  if (!window.isSecureContext) throw new Error('Secure (HTTPS) connection required');
  return navigator.serviceWorker.register('/service-worker.js');
}

async function initPush() {
  if (!pushSupported()) return;
  try {
    await registerSW();
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('SW init note:', e.message);
  }
}

async function subscribeToPush() {
  const text = pushBanner().querySelector('.pb-text');
  if (!pushSupported()) { text.textContent = '⚠️ This browser does not support push notifications.'; return; }
  if (!window.isSecureContext) { text.textContent = '⚠️ Notifications need HTTPS. Open the site via https:// to enable.'; return; }
  $('pushEnableBtn').disabled = true;
  text.textContent = '🔔 Requesting permission…';
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      text.textContent = '🔕 Notifications blocked. Allow them in your browser site settings.';
      $('pushEnableBtn').disabled = false;
      return;
    }
    text.textContent = '🔔 Subscribing…';
    const reg = await registerSW();
    await navigator.serviceWorker.ready;
    const keyRes = await fetch('/vapid-public-key');
    const { key } = await keyRes.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const res = await fetch('/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub })
    });
    if (!res.ok) throw new Error('subscribe request failed');
    text.textContent = '✅ Push enabled for #Private!';
    try { localStorage.setItem(PUSH_ASKED_KEY, '1'); } catch { /* ignore */ }
    setTimeout(() => pushBanner().classList.remove('show'), 2000);
  } catch (e) {
    console.warn('Push subscribe failed', e);
    text.textContent = '⚠️ Could not enable push: ' + (e.message || 'unknown error');
    $('pushEnableBtn').disabled = false;
  }
}

function maybeShowPushBanner() {
  if (!pushSupported()) return;
  if (Notification.permission === 'granted') return;
  try { if (localStorage.getItem(PUSH_ASKED_KEY) === '1') return; } catch { /* ignore */ }
  pushBanner().querySelector('.pb-text').textContent = '🔔 Get a ping when #Private messages arrive? (content stays encrypted)';
  pushBanner().classList.add('show');
}

/* ------------------------------------------------------------------ start */

window.addEventListener('beforeunload', () => {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ['imageModal'].forEach((id) => $(id).classList.remove('show'));
  ['privateSheet', 'nameSheet', 'adminSheet', 'panelSheet'].forEach(hideSheet);
});

$('pushEnableBtn').addEventListener('click', subscribeToPush);
$('pushDismissBtn').addEventListener('click', () => {
  pushBanner().classList.remove('show');
  try { localStorage.setItem(PUSH_ASKED_KEY, '1'); } catch { /* ignore */ }
});

initPush();
boot().catch((err) => {
  console.error(err);
  fatal('⚠️ Startup failed: ' + (err && err.message ? err.message : err));
});
