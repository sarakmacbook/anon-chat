const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const multer = require("multer");
const webpush = require("web-push");
const auth = require("./auth-store");
const uploadStore = require("./upload-store");
const pushStore = require("./push-store");

const app = express();
const server = http.createServer(app);
// Messages are tiny (files go over HTTP), so keep the socket payload small.
const io = new Server(server, { maxHttpBufferSize: 1 * 1024 * 1024 });

// PORT=0 asks the OS for a free port (used by the test suite).
const PORT = process.env.PORT !== undefined && process.env.PORT !== "" && Number.isFinite(Number(process.env.PORT))
  ? Number(process.env.PORT)
  : 3000;
const MESSAGE_EXPIRY = null;
const FILE_EXPIRY = 180 * 24 * 60 * 60 * 1000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "Data");
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : "/tmp/chat-uploads";
const UPLOAD_PUBLIC = path.join(UPLOAD_DIR, "public");
const UPLOAD_PRIVATE = path.join(UPLOAD_DIR, "private");
const MAX_PUBLIC_MB = 200;
const MAX_PUBLIC_TEXT = 4000;
const MAX_PRIVATE_ENVELOPE = 64 * 1024;   // base64 ciphertext of one message
const HISTORY_LIMIT = 100;
const MAX_STORED_MESSAGES = 10000;

// Create Data/public and Data/private folders
const DATA_PUBLIC = path.join(DATA_DIR, "public");
const DATA_PRIVATE = path.join(DATA_DIR, "private");
[DATA_DIR, DATA_PUBLIC, DATA_PRIVATE, UPLOAD_DIR, UPLOAD_PUBLIC, UPLOAD_PRIVATE].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
auth.ensureDirs();

// Auto-detect storage for private room upload limit
function getAvailableGB() {
  try {
    const out = execSync("df -k " + JSON.stringify(UPLOAD_DIR) + " | tail -1", { encoding: "utf8" });
    const parts = out.trim().split(/\s+/);
    return Math.floor(parseInt(parts[3]) / 1048576);
  } catch { return 10; }
}
let availableGB = getAvailableGB();
let maxPrivateUploadMB = Math.max(1, (availableGB - 1) * 1024);
console.log("Storage: " + availableGB + "GB available, private upload limit: " + Math.round(maxPrivateUploadMB / 1024) + "GB");
setInterval(() => {
  availableGB = getAvailableGB();
  maxPrivateUploadMB = Math.max(1, (availableGB - 1) * 1024);
}, 300000);

const RATE_LIMIT = {
  maxMessages: 10,
  windowMs: 30000,
  muteDurationMs: 60000,
  maxFileUploads: 5,
  fileWindowMs: 300000,
};

// Credential guessing is expensive for the attacker (scrypt) but we still lock
// the door after a handful of misses.
const AUTH_LIMIT = { maxFailures: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const authAttempts = new Map();

function authState(key) {
  const now = Date.now();
  let entry = authAttempts.get(key);
  if (!entry) { entry = { count: 0, first: now, lockedUntil: 0 }; authAttempts.set(key, entry); }
  if (entry.lockedUntil && now < entry.lockedUntil) return entry;
  if (now - entry.first > AUTH_LIMIT.windowMs) { entry.count = 0; entry.first = now; entry.lockedUntil = 0; }
  return entry;
}
function authBlocked(key) {
  const entry = authState(key);
  return entry.lockedUntil > Date.now() ? Math.ceil((entry.lockedUntil - Date.now()) / 1000) : 0;
}
function authFailure(key) {
  const now = Date.now();
  const entry = authState(key);
  entry.count += 1;
  if (entry.count >= AUTH_LIMIT.maxFailures) {
    entry.lockedUntil = now + AUTH_LIMIT.lockMs;
    entry.count = 0;
    entry.first = now;
  }
  if (authAttempts.size > 20000) {
    for (const [k, v] of authAttempts) if (now - v.first > AUTH_LIMIT.windowMs && !(v.lockedUntil > now)) authAttempts.delete(k);
  }
  return entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0;
}
function authReset(key) { authAttempts.delete(key); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authAttempts) if (now - v.first > AUTH_LIMIT.windowMs && !(v.lockedUntil > now)) authAttempts.delete(k);
}, 10 * 60 * 1000).unref?.();

const userMessages = {};
const userUploads = {};
const mutedUsers = {};
const usernames = {};

// Load existing messages
const rooms = {
  public: { messages: loadMessages("public"), users: new Set() },
  private: { messages: loadMessages("private"), users: new Set() }
};
function loadMessages(r) {
  const dir = r === "private" ? DATA_PRIVATE : DATA_PUBLIC;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "messages.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveMessages(r) {
  const dir = r === "private" ? DATA_PRIVATE : DATA_PUBLIC;
  const file = path.join(dir, "messages.json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rooms[r].messages));
  fs.renameSync(tmp, file);
}

/**
 * Files expire after FILE_EXPIRY. The old sweep looked at the top level of
 * UPLOAD_DIR, which only ever contains the public/ and private/ folders, so it
 * never actually deleted anything.
 */
function cleanupExpiredFiles() {
  let removed = 0;
  [UPLOAD_PUBLIC, UPLOAD_PRIVATE].forEach(dir => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    names.forEach(name => {
      const fp = path.join(dir, name);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile() && Date.now() - stat.mtimeMs > FILE_EXPIRY) { fs.unlinkSync(fp); removed++; }
      } catch { /* gone already */ }
    });
  });
  // Drop metadata whose bytes are no longer on disk.
  uploadStore.getAllFiles().forEach(record => {
    const dir = record.room === "private" ? UPLOAD_PRIVATE : UPLOAD_PUBLIC;
    try {
      if (!fs.existsSync(path.join(dir, record.diskName))) uploadStore.removeFile(record.id);
    } catch { /* ignore */ }
  });
  if (removed) console.log("Expired files removed:", removed);
}
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 6 * 60 * 60 * 1000).unref?.();

app.use(express.json({ limit: "1mb" }));
// .mjs must arrive as JavaScript or browsers refuse to run the crypto module.
app.use((req, res, next) => {
  if (req.path.endsWith(".mjs")) res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  next();
});
app.use("/vendor", express.static(path.join(__dirname, "public", "vendor"), { maxAge: "1d", etag: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads/public", express.static(UPLOAD_PUBLIC));
app.use("/uploads/private", express.static(UPLOAD_PRIVATE));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Cheap CSRF guard for the JSON endpoints. Session tokens live in an
 * Authorization header (never a cookie) so they are already unforgeable, but
 * the one shot /api/setup call has no token to check.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl / same page without Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function requireAdmin(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : (req.body && req.body.token) || (req.query && req.query.token);
  const payload = auth.verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Admin session required" });
  req.admin = payload;
  return null;
}

/* ------------------------------------------------------- setup / admin API */

app.get("/api/bootstrap", (req, res) => {
  res.json(auth.bootstrap());
});

let setupInFlight = null;
app.post("/api/setup", (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Cross origin request rejected" });
  if (auth.isSetup()) return res.status(409).json({ error: "Already configured" });
  const wait = authBlocked("setup:" + clientIp(req));
  if (wait) return res.status(429).json({ error: "Too many attempts", retryAfter: wait });
  if (setupInFlight) return res.status(429).json({ error: "Setup already running" });

  const { adminUsername, adminVerifier, roomVerifier, roomSalt } = req.body || {};
  setupInFlight = auth.createSetup({ adminUsername, adminVerifier, roomVerifier, roomSalt })
    .then((cfg) => {
      authReset("setup:" + clientIp(req));
      const issued = auth.issueToken(cfg.admin.username, cfg);
      console.log("Setup complete — admin:", cfg.admin.username, "| private room kid:", cfg.room.kid);
      res.json({
        ok: true,
        username: cfg.admin.username,
        token: issued.token,
        expiresIn: issued.expiresIn,
        room: { kid: cfg.room.kid, salt: cfg.room.salt }
      });
    })
    .catch((err) => {
      authFailure("setup:" + clientIp(req));
      res.status(err.status || 500).json({ error: err.message || "Setup failed" });
    })
    .finally(() => { setupInFlight = null; });
});

app.post("/api/admin/login", async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: "Cross origin request rejected" });
  const ip = clientIp(req);
  const wait = authBlocked("login:" + ip);
  if (wait) return res.status(429).json({ error: "Too many failed attempts. Try again in " + wait + "s", retryAfter: wait });
  if (!auth.hasAdmin()) return res.status(409).json({ error: "Setup required" });
  const { username, verifier } = req.body || {};
  if (!auth.isVerifier(verifier)) return res.status(400).json({ error: "Malformed credentials" });
  const result = await auth.verifyAdmin(username, verifier);
  if (!result.ok) {
    const lockFor = authFailure("login:" + ip);
    auth.audit({ action: "admin-login-failed", actor: String(username || "").slice(0, 64), ip });
    return res.status(lockFor ? 429 : 401).json({
      error: lockFor ? "Too many failed attempts. Locked for " + lockFor + "s" : "Wrong username or password",
      retryAfter: lockFor || undefined
    });
  }
  authReset("login:" + ip);
  const issued = auth.issueToken(result.username);
  auth.audit({ action: "admin-login", actor: result.username, ip });
  res.json({ ok: true, username: result.username, token: issued.token, expiresIn: issued.expiresIn });
});

app.post("/api/admin/logout", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  auth.audit({ action: "admin-logout", actor: req.admin.sub, ip: clientIp(req) });
  res.json({ ok: true });
});

app.get("/api/admin/status", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  res.json({ isAdmin: true, username: req.admin.sub, expiresAt: req.admin.exp, room: auth.roomInfo() });
});

/**
 * Message metadata for moderation. Private content is never included — the
 * server only ever holds ciphertext, so there is nothing to leak here.
 */
app.get("/api/admin/messages/:room", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const room = req.params.room === "private" ? "private" : "public";
  const list = (rooms[room]?.messages || []).map(m => ({
    id: m.id,
    username: m.username,
    time: m.time,
    encrypted: Boolean(m.c),
    kid: m.kid || null,
    hasFile: Boolean(m.file),
    // Public room only. Private text does not exist on this server.
    text: room === "public" ? (m.text || "") : undefined
  }));
  res.json({ room, count: list.length, messages: list.slice(-500) });
});

app.delete("/api/admin/messages/:room/:id", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const room = req.params.room === "private" ? "private" : "public";
  const result = deleteMessage(room, req.params.id, req.admin.sub, clientIp(req));
  if (!result) return res.status(404).json({ error: "Message not found" });
  res.json({ ok: true, id: req.params.id, room });
});

app.delete("/api/admin/messages/:room", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const room = req.params.room === "private" ? "private" : "public";
  const removed = purgeRoom(room, req.admin.sub, clientIp(req));
  res.json({ ok: true, room, removed });
});

/** Remove every private message that was stored in clear text by an old build. */
app.delete("/api/admin/legacy", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const legacy = (rooms.private.messages || []).filter(m => !m.c);
  legacy.forEach(m => unlinkUpload(m.file));
  rooms.private.messages = (rooms.private.messages || []).filter(m => m.c);
  saveMessages("private");
  io.to("private").emit("room-purged", { scope: "legacy", count: legacy.length });
  auth.audit({ action: "legacy-purged", actor: req.admin.sub, room: "private", detail: `${legacy.length} messages`, ip: clientIp(req) });
  res.json({ ok: true, removed: legacy.length });
});

app.post("/api/admin/password", async (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  if (!sameOrigin(req)) return res.status(403).json({ error: "Cross origin request rejected" });
  const { username, verifier } = req.body || {};
  try {
    await auth.changeAdmin({ username, adminVerifier: verifier });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const issued = auth.issueToken(username);
  auth.audit({ action: "admin-password-changed", actor: username, ip: clientIp(req) });
  res.json({ ok: true, username, token: issued.token, expiresIn: issued.expiresIn });
});

app.post("/api/admin/room/rotate", async (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  if (!sameOrigin(req)) return res.status(403).json({ error: "Cross origin request rejected" });
  const { verifier, salt } = req.body || {};
  let info;
  try {
    info = await auth.rotateRoom({ roomVerifier: verifier, roomSalt: salt });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  auth.audit({ action: "room-key-rotated", actor: req.admin.sub, room: "private", detail: `kid=${info.kid}`, ip: clientIp(req) });
  // Everyone currently inside #Private is now holding a dead key.
  io.to("private").emit("room-key-changed", { kid: info.kid, salt: info.salt });
  res.json({ ok: true, room: info });
});

app.get("/api/admin/audit", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  res.json({ entries: auth.readAudit(Number(req.query.limit) || 100) });
});

app.get("/api/admin/stats", (req, res) => {
  const denied = requireAdmin(req, res); if (denied) return;
  const legacy = (rooms.private.messages || []).filter(m => !m.c).length;
  res.json({
    public: { messages: rooms.public.messages.length, online: rooms.public.users.size },
    private: { messages: rooms.private.messages.length, online: rooms.private.users.size, legacyUnencrypted: legacy },
    files: uploadStore.getAllFiles().length,
    room: auth.roomInfo(),
    serverKdf: auth.SCRYPT_LABEL,
    clientKdf: auth.CLIENT_KDF,
    tokenTtlMs: auth.TOKEN_TTL_MS
  });
});

/* ------------------------------------------------------------ web push */

// Generate a valid keypair at runtime so web-push never crashes on bogus/missing hardcoded keys.
// Kept inside DATA_DIR: the container root is ephemeral, and regenerating the
// VAPID pair on every restart silently kills every existing push subscription.
const VAPID_FILE = path.join(DATA_DIR, "vapid-keys.json");
let vapidKeys;
try {
  if (fs.existsSync(VAPID_FILE)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, "utf8"));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys), { mode: 0o600 });
  }
} catch (e) {
  vapidKeys = webpush.generateVAPIDKeys();
}
try {
  webpush.setVapidDetails("mailto:anon-chat@example.com", vapidKeys.publicKey, vapidKeys.privateKey);
  console.log("Web Push VAPID ready");
} catch (e) {
  console.error("Web Push VAPID setup failed:", e.message);
}
app.get("/vapid-public-key", (req, res) => res.json({ key: vapidKeys.publicKey }));
app.post("/push-subscribe", (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Bad subscription" });
  pushStore.add(sub);
  res.json({ ok: true });
});
app.post("/push-unsubscribe", (req, res) => {
  const sub = req.body && req.body.subscription;
  if (sub && sub.endpoint) pushStore.remove(sub.endpoint);
  res.json({ ok: true });
});
function sendPushToAll(payload) {
  const subs = pushStore.getAll();
  if (!subs.length) return;
  subs.forEach(sub => {
    webpush.sendNotification(sub, payload).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) pushStore.remove(sub.endpoint);
    });
  });
}

/* --------------------------------------------------------------- uploads */

const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const room = req.body.room === "private" ? "private" : "public";
    const dir = room === "private" ? UPLOAD_PRIVATE : UPLOAD_PUBLIC;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // Private room files are ciphertext: strip the real extension so the stored
  // name cannot hint at what is inside.
  filename: (req, file, cb) => {
    const ext = req.body.room === "private" ? ".bin" : path.extname(file.originalname).slice(0, 20);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

app.get("/limits", (req, res) => {
  res.json({ maxPrivateUploadMB, maxPublicMB: MAX_PUBLIC_MB });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const room = req.body.room === "private" ? "private" : "public";
  if (room === "public" && req.file.size > MAX_PUBLIC_MB * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: "Public chat max " + MAX_PUBLIC_MB + "MB." });
  }
  if (room === "private" && req.file.size > maxPrivateUploadMB * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: "File exceeds " + Math.round(maxPrivateUploadMB / 1024) + "GB storage limit." });
  }
  const id = path.parse(req.file.filename).name;
  const safeName = room === "private" ? "encrypted.bin" : sanitize(req.file.originalname);
  const safeType = room === "private" ? "application/octet-stream" : req.file.mimetype;
  uploadStore.saveFile(id, safeName, safeType, req.file.filename, req.file.size, room);
  const uploadUrl = room === "private" ? "/uploads/private/" + req.file.filename : "/uploads/public/" + req.file.filename;
  console.log("Uploaded:", safeName, Math.round(req.file.size / 1024) + "KB", "[" + room + "]");
  res.json({
    id,
    url: uploadUrl,
    name: safeName,
    type: safeType,
    size: req.file.size,
    encrypted: room === "private",
    expires: Date.now() + FILE_EXPIRY
  });
});

app.get("/file/:id", (req, res) => {
  const file = uploadStore.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "Not found" });
  const room = file.room === "private" ? "private" : "public";
  res.redirect("/uploads/" + room + "/" + file.diskName);
});

/* ------------------------------------------------------- message plumbing */

/** Delete an upload record and the bytes behind it. */
function unlinkUpload(file) {
  if (!file) return false;
  let record = null;
  const id = file.id || (typeof file.url === "string" ? path.basename(file.url).split(".")[0] : null);
  if (id) record = uploadStore.removeFile(id);
  const diskName = (record && record.diskName) || (typeof file.url === "string" ? path.basename(file.url) : null);
  if (!diskName) return false;
  const room = (record && record.room) || (typeof file.url === "string" && file.url.indexOf("/uploads/private/") === 0 ? "private" : "public");
  const dir = room === "private" ? UPLOAD_PRIVATE : UPLOAD_PUBLIC;
  try { fs.unlinkSync(path.join(dir, path.basename(diskName))); } catch { /* already gone */ }
  return true;
}

/** Admin only. Returns the removed message, or null when the id is unknown. */
function deleteMessage(room, id, actor, ip) {
  const target = rooms[room];
  if (!target || typeof id !== "string" || !id) return null;
  const index = target.messages.findIndex(m => m.id === id);
  if (index === -1) return null;
  const [removed] = target.messages.splice(index, 1);
  saveMessages(room);
  const hadFile = unlinkUpload(removed.file);
  io.to(room).emit("message-deleted", { id, room, by: actor || "admin" });
  auth.audit({
    action: "message-deleted", actor, room, id,
    detail: (removed.c ? "encrypted" : "plain") + (hadFile ? " +file" : ""),
    ip
  });
  return removed;
}

/** Admin only. Wipe a room: messages and every file that belongs to them. */
function purgeRoom(room, actor, ip) {
  const target = rooms[room];
  if (!target) return 0;
  const count = target.messages.length;
  target.messages.forEach(m => unlinkUpload(m.file));
  target.messages = [];
  saveMessages(room);
  const orphaned = uploadStore.removeByRoom(room);
  orphaned.forEach(record => {
    const dir = room === "private" ? UPLOAD_PRIVATE : UPLOAD_PUBLIC;
    try { fs.unlinkSync(path.join(dir, path.basename(record.diskName))); } catch { /* already gone */ }
  });
  io.to(room).emit("room-purged", { room, count });
  auth.audit({ action: "room-purged", actor, room, detail: `${count} messages, ${orphaned.length} files`, ip });
  return count;
}

/* --------------------------------------------------------------- sockets */

const adjectives = ["Cool","Sneaky","Wild","Calm","Bold","Swift","Dark","Bright","Lone","Free","Happy","Clever"];
const nouns = ["Panda","Fox","Wolf","Eagle","Tiger","Owl","Bear","Hawk","Lynx","Raven","Cat","Dog"];
function randomName() {
  return adjectives[Math.floor(Math.random() * adjectives.length)] + nouns[Math.floor(Math.random() * nouns.length)] + Math.floor(Math.random() * 99);
}

/** A message may only reference a file this server actually served. */
function isUploadUrl(url) {
  return typeof url === "string"
    && (url.startsWith("/uploads/public/") || url.startsWith("/uploads/private/"))
    && url.length <= 500
    && !url.includes("..");
}

/** Any client can emit anything: never assume a payload exists. */
const obj = (value) => (value && typeof value === "object" ? value : {});

io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  let username = randomName();
  usernames[socket.id] = username;
  socket.data.room = null;
  socket.data.isAdmin = false;
  socket.data.adminName = null;
  console.log("Connect:", ip, "| Online:", Object.keys(usernames).length);
  socket.emit("welcome", { username, setupRequired: !auth.isSetup() });

  socket.on("admin-auth", (data) => {
    const payload = auth.verifyToken(data && data.token);
    socket.data.isAdmin = Boolean(payload);
    socket.data.adminName = payload ? payload.sub : null;
    socket.emit("admin-state", {
      isAdmin: socket.data.isAdmin,
      username: socket.data.adminName,
      expiresAt: payload ? payload.exp : null
    });
  });

  socket.on("set-name", (payload) => {
    const data = obj(payload);
    const oldName = usernames[socket.id];
    const newName = String(data.name || "").trim().substring(0, 20) || randomName();
    usernames[socket.id] = newName;
    username = newName;
    socket.emit("name-changed", { username: newName });
    Object.keys(rooms).forEach(r => {
      if (rooms[r].users.has(socket.id)) io.to(r).emit("user-renamed", { oldName, newName });
    });
  });

  socket.on("join-room", async (payload) => {
    const data = obj(payload);
    const room = data.room === "private" ? "private" : "public";
    if (room === "private") {
      if (!auth.hasRoom()) {
        socket.emit("error-msg", { message: "The private room has not been set up yet" });
        return;
      }
      const lockKey = "room:" + (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address);
      const wait = authBlocked(lockKey);
      if (wait) {
        socket.emit("error-msg", { message: "Too many wrong passphrases. Wait " + wait + "s" });
        return;
      }
      // An authenticated admin may enter without the passphrase to moderate.
      // They still cannot read anything: content only exists as ciphertext.
      const adminModeration = Boolean(socket.data.isAdmin) && !auth.isVerifier(data.verifier);
      if (!adminModeration) {
        const ok = await auth.verifyRoom(data.verifier);
        if (!ok) {
          const lockFor = authFailure(lockKey);
          socket.emit("error-msg", {
            message: lockFor ? "Too many wrong passphrases. Locked for " + lockFor + "s" : "Wrong passphrase"
          });
          return;
        }
        authReset(lockKey);
      }
      const info = auth.roomInfo();
      socket.data.moderationOnly = adminModeration;
      socket.data.kid = info ? info.kid : 0;
    } else {
      socket.data.moderationOnly = false;
    }

    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(room);
    if (!rooms[room]) rooms[room] = { messages: [], users: new Set() };
    rooms[room].users.add(socket.id);
    socket.data.room = room;
    socket.emit("room-joined", {
      room,
      users: rooms[room].users.size,
      messages: rooms[room].messages.slice(-HISTORY_LIMIT),
      kid: room === "private" ? socket.data.kid : null,
      moderationOnly: room === "private" ? Boolean(socket.data.moderationOnly) : false
    });
    socket.to(room).emit("user-joined", { username, users: rooms[room].users.size });
  });

  socket.on("message", (payload) => {
    const data = obj(payload);
    const room = data.room === "private" ? "private" : "public";
    if (!rooms[room]) return;
    // You must have passed the room check to post in it.
    if (socket.data.room !== room) {
      socket.emit("error-msg", { message: room === "private" ? "Join the private room first" : "Join a room first" });
      return;
    }
    const now = Date.now();
    const sid = socket.id;

    if (room === "public") {
      if (mutedUsers[sid] && now < mutedUsers[sid]) {
        socket.emit("error-msg", { message: "Slow down! Wait " + Math.ceil((mutedUsers[sid] - now) / 1000) + "s" });
        return;
      }
      delete mutedUsers[sid];
      if (!userMessages[sid]) userMessages[sid] = [];
      userMessages[sid] = userMessages[sid].filter(t => now - t < RATE_LIMIT.windowMs);
      if (userMessages[sid].length >= RATE_LIMIT.maxMessages) {
        mutedUsers[sid] = now + RATE_LIMIT.muteDurationMs;
        socket.emit("error-msg", { message: "Too many messages! Muted for 1 minute." });
        return;
      }
      userMessages[sid].push(now);

      const incomingFile = obj(data.file);
      const hasFile = isUploadUrl(incomingFile.url);
      const text = typeof data.text === "string" ? data.text.slice(0, MAX_PUBLIC_TEXT) : "";

      if (hasFile) {
        if (!userUploads[sid]) userUploads[sid] = [];
        userUploads[sid] = userUploads[sid].filter(t => now - t < RATE_LIMIT.fileWindowMs);
        if (userUploads[sid].length >= RATE_LIMIT.maxFileUploads) {
          socket.emit("error-msg", { message: "Too many uploads! Wait 5 minutes." });
          return;
        }
        userUploads[sid].push(now);
      }
      if (text) {
        const lastMsgs = rooms[room].messages.slice(-20);
        const dup = lastMsgs.filter(m => m.username === usernames[sid] && m.text === text).length;
        if (dup >= 6) { socket.emit("error-msg", { message: "Stop spamming!" }); return; }
      }
      if (!text && !hasFile) return;

      const file = hasFile ? {
        id: String(incomingFile.id || "").slice(0, 64) || undefined,
        url: String(incomingFile.url).slice(0, 500),
        name: sanitize(String(incomingFile.name || "file")).slice(0, 100),
        type: String(incomingFile.type || "").slice(0, 100)
      } : undefined;

      const msg = { id: uuidv4(), username: usernames[sid], text, file, ip, time: new Date().toISOString(), room };
      appendAndBroadcast(room, msg);
      return;
    }

    /* ---- private: the server only ever sees ciphertext ---- */
    const enc = data.enc;
    if (!enc || typeof enc.c !== "string" || typeof enc.n !== "string") {
      socket.emit("error-msg", { message: "Private messages must be encrypted" });
      return;
    }
    if (enc.c.length > MAX_PRIVATE_ENVELOPE || enc.n.length > 64) {
      socket.emit("error-msg", { message: "Message too large" });
      return;
    }
    const info = auth.roomInfo();
    const kid = Number(data.kid) || 0;
    if (!info || kid !== info.kid) {
      socket.emit("room-key-changed", { kid: info ? info.kid : 0, salt: info ? info.salt : null });
      socket.emit("error-msg", { message: "The private room key changed. Rejoin #Private." });
      return;
    }
    const privateFile = obj(data.file);
    const file = isUploadUrl(privateFile.url) ? {
      id: String(privateFile.id || "").slice(0, 64) || undefined,
      url: String(privateFile.url).slice(0, 500)
    } : undefined;

    // No `text`, no `ip`: private room history holds nothing but sealed bytes.
    const msg = {
      id: uuidv4(),
      username: usernames[sid],
      time: new Date().toISOString(),
      room,
      kid,
      c: enc.c,
      n: enc.n
    };
    if (file) msg.file = file;
    appendAndBroadcast(room, msg);
  });

  socket.on("delete-message", (payload) => {
    if (!socket.data.isAdmin) {
      socket.emit("error-msg", { message: "Only an admin can remove messages" });
      return;
    }
    const data = obj(payload);
    const room = data.room === "private" ? "private" : "public";
    if (!deleteMessage(room, data.id, socket.data.adminName, ip)) {
      socket.emit("error-msg", { message: "Message not found" });
      return;
    }
    socket.emit("admin-action", { ok: true, action: "delete-message", room, id: data.id });
  });

  socket.on("disconnect", () => {
    Object.keys(rooms).forEach(r => {
      if (rooms[r].users.has(socket.id)) {
        rooms[r].users.delete(socket.id);
        io.to(r).emit("user-left", { username: usernames[socket.id], users: rooms[r].users.size });
      }
    });
    delete usernames[socket.id];
    delete userMessages[socket.id];
    delete userUploads[socket.id];
    delete mutedUsers[socket.id];
  });
});

function appendAndBroadcast(room, msg) {
  rooms[room].messages.push(msg);
  while (rooms[room].messages.length > MAX_STORED_MESSAGES) rooms[room].messages.shift();
  saveMessages(room);
  io.to(room).emit("message", msg);
  if (room === "private") {
    // Never put private content in a push payload — it travels through third
    // party servers in the clear. Only the (alias) sender is announced.
    sendPushToAll(JSON.stringify({
      title: "Anon Chat",
      body: "🔒 Encrypted message" + (msg.username ? " from " + msg.username : ""),
      room: "private"
    }));
  }
  if (MESSAGE_EXPIRY) {
    setTimeout(() => {
      if (rooms[room]) {
        rooms[room].messages = rooms[room].messages.filter(m => m.id !== msg.id);
        io.to(room).emit("message-deleted", { id: msg.id, room });
        saveMessages(room);
      }
    }, MESSAGE_EXPIRY);
  }
}

if (!auth.hasAdmin() || !auth.hasRoom()) {
  const missing = [!auth.hasAdmin() ? "admin account" : null, !auth.hasRoom() ? "private room key" : null].filter(Boolean);
  console.log("⚠️  First time setup pending (" + missing.join(" + ") + ") — open the site to run the wizard.");
} else {
  console.log("🔒 Admin:", auth.adminUsername(), "| private room key id:", (auth.roomInfo() || {}).kid);
  console.log("🔐 Private room content is end-to-end encrypted: this server stores ciphertext only.");
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason && reason.stack ? reason.stack : reason);
});

function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      const bound = server.address();
      console.log("Anon Chat on http://0.0.0.0:" + (bound && bound.port ? bound.port : port));
      resolve(bound && bound.port ? bound.port : port);
    });
  });
}

if (require.main === module) start();

module.exports = { app, server, io, rooms, start, deleteMessage, purgeRoom };
