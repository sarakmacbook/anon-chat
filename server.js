const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const multer = require("multer");
const webpush = require("web-push");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const crypto = require("crypto");
const cryptoVault = require("./crypto-vault");
const passkeyStore = require("./passkey-store");

const app = express();
app.set("trust proxy", true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 * 1024 });

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// ─── Password & encryption setup ─────────────────────────────────────────────
//
//  Password verification now uses PBKDF2-SHA512 (600 000 iterations) via
//  crypto-vault.  A legacy sha256 hex hash is still accepted for backward
//  compatibility so existing installs keep working.
//
//  When PRIVATE_PASSWORD is available we also derive an AES-256-GCM encryption
//  key so passkey credentials are encrypted at rest on disk.
// ─────────────────────────────────────────────────────────────────────────────

const BUILT_IN_PRIVATE_PASSWORD_HASH = "8d23cf6c86e834a7aa6eded54c26ce2bb2e74903538c61bdd5d2197997ab2f72";

// Resolve the active password hash.
//   PRIVATE_PASSWORD_HASH  →  explicit hash (PBKDF2 v1$… or legacy sha256 hex)
//   PRIVATE_PASSWORD       →  derive a PBKDF2 hash at startup
//   (neither)              →  built-in default (legacy sha256)
let PRIVATE_PASSWORD_HASH;
let PRIVATE_PASSWORD_PLAIN = null;

if (process.env.PRIVATE_PASSWORD_HASH) {
  PRIVATE_PASSWORD_HASH = process.env.PRIVATE_PASSWORD_HASH;
  console.log("#Private password: using PRIVATE_PASSWORD_HASH");
} else if (process.env.PRIVATE_PASSWORD) {
  PRIVATE_PASSWORD_PLAIN = process.env.PRIVATE_PASSWORD;
  // Hash the password with PBKDF2 for verification
  PRIVATE_PASSWORD_HASH = cryptoVault.hashPassword(PRIVATE_PASSWORD_PLAIN);
  console.log("#Private password: hashed with PBKDF2-SHA512 (600k iterations)");
} else {
  PRIVATE_PASSWORD_HASH = BUILT_IN_PRIVATE_PASSWORD_HASH;
  console.log("#Private password: using built-in default (set PRIVATE_PASSWORD to change — see README)");
}

// ─── Passkey vault encryption (AES-256-GCM at rest) ──────────────────────────

if (PRIVATE_PASSWORD_PLAIN) {
  const encKey = cryptoVault.deriveEncryptionKey(PRIVATE_PASSWORD_PLAIN);
  passkeyStore.setEncryptionKey(encKey);
  console.log("🔐 Passkey vault: AES-256-GCM encryption enabled (PBKDF2-derived key)");
} else {
  console.log("⚠️  Passkey vault: encryption disabled (set PRIVATE_PASSWORD to enable AES-256-GCM at rest)");
}

// ─── Other constants ──────────────────────────────────────────────────────────

const PASSKEY_RP_NAME = process.env.WEBAUTHN_RP_NAME || "Anon Chat";
const PASSKEY_USER_ID = crypto.createHash("sha256").update("anon-chat-private-room").digest();
const PASSKEY_USER_NAME = "private@anon-chat";
const PASSKEY_USER_DISPLAY_NAME = "#Private room";
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_TOKEN_TTL_MS = 5 * 60 * 1000;
const PASSKEY_TOKEN_SECRET = crypto.randomBytes(32);
const PASSKEY_SUPPORTED_ALGS = [-7, -257]; // ES256 and RS256 are broadly supported by iPhone and Chrome passkeys.
const MESSAGE_EXPIRY = null;
const FILE_EXPIRY = 180 * 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "Data");
const UPLOAD_DIR = "/tmp/chat-uploads";
const UPLOAD_PUBLIC = path.join(UPLOAD_DIR, "public");
const UPLOAD_PRIVATE = path.join(UPLOAD_DIR, "private");
const MAX_PUBLIC_MB = 200;

// Create Data/public and Data/private folders
const DATA_PUBLIC = path.join(DATA_DIR, "public");
const DATA_PRIVATE = path.join(DATA_DIR, "private");
[DATA_DIR, DATA_PUBLIC, DATA_PRIVATE, UPLOAD_DIR, UPLOAD_PUBLIC, UPLOAD_PRIVATE].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Auto-detect storage for private room upload limit
function getAvailableGB() {
  try {
    const out = execSync("df -k /tmp | tail -1", { encoding: "utf8" });
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
  try { return JSON.parse(fs.readFileSync(path.join(dir, "messages.json"), "utf8")); } catch { return []; }
}
function saveMessages(r) {
  const dir = r === "private" ? DATA_PRIVATE : DATA_PUBLIC;
  fs.writeFileSync(path.join(dir, "messages.json"), JSON.stringify(rooms[r].messages, null, 2));
}

/**
 * Verify a password against the stored hash.
 * Uses PBKDF2 (preferred) or sha256 (legacy) depending on the hash format.
 * Always timing-safe.
 */
function privatePasswordMatches(password) {
  return cryptoVault.verifyPassword(password, PRIVATE_PASSWORD_HASH);
}

/**
 * Compute a fingerprint of the active password hash so passkey records can be
 * scoped to a specific password (changing the password invalidates old passkeys).
 */
function passwordFingerprint() {
  return crypto.createHash("sha256").update(PRIVATE_PASSWORD_HASH).digest("hex");
}

function bytesToBase64URL(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function base64URLToBytes(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function publicOriginFromRequest(req) {
  if (req.headers.origin) return req.headers.origin;
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = (req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.headers.host;
  return `${protocol}://${host}`;
}

function webAuthnContextFromRequest(req) {
  const rawOrigin = process.env.WEBAUTHN_ORIGIN || publicOriginFromRequest(req);
  const parsedOrigin = new URL(rawOrigin);
  const origin = parsedOrigin.origin;
  const hostname = parsedOrigin.hostname.toLowerCase();
  const rpID = (process.env.WEBAUTHN_RP_ID || hostname).toLowerCase();
  return { origin, rpID };
}

const passkeyChallenges = new Map();
function savePasskeyChallenge(type, challenge, context, extra = {}) {
  const challengeId = uuidv4();
  passkeyChallenges.set(challengeId, {
    type,
    challenge,
    origin: context.origin,
    rpID: context.rpID,
    expiresAt: Date.now() + PASSKEY_CHALLENGE_TTL_MS,
    ...extra,
  });
  return challengeId;
}
function consumePasskeyChallenge(challengeId, type) {
  const record = passkeyChallenges.get(challengeId);
  passkeyChallenges.delete(challengeId);
  if (!record || record.type !== type || record.expiresAt < Date.now()) return null;
  return record;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, record] of passkeyChallenges) {
    if (record.expiresAt < now) passkeyChallenges.delete(id);
  }
}, PASSKEY_CHALLENGE_TTL_MS).unref?.();

function createPrivateAccessToken(authMethod, credentialId) {
  const payload = {
    room: "private",
    method: authMethod,
    credentialId,
    exp: Date.now() + PASSKEY_TOKEN_TTL_MS,
    nonce: uuidv4(),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", PASSKEY_TOKEN_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyPrivateAccessToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", PASSKEY_TOKEN_SECRET).update(data).digest("base64url");
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.room !== "private" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function safePasskeyLabel(label, fallback = "Passkey") {
  const trimmed = String(label || "").replace(/[\r\n\t]/g, " ").trim();
  return (trimmed || fallback).substring(0, 80);
}

try {
  fs.readdirSync(UPLOAD_DIR).forEach(f => {
    const fp = path.join(UPLOAD_DIR, f);
    try { if (Date.now() - fs.statSync(fp).mtimeMs > FILE_EXPIRY) fs.unlinkSync(fp); } catch {}
  });
} catch {}

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads/public", express.static(UPLOAD_PUBLIC));
app.use("/uploads/private", express.static(UPLOAD_PRIVATE));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// --- Web Push (VAPID) ---
// Generate a valid keypair at runtime so web-push never crashes on bogus/missing hardcoded keys.
let vapidKeys;
try {
  if (fs.existsSync(path.join(__dirname, ".vapidkeys"))) {
    vapidKeys = JSON.parse(fs.readFileSync(path.join(__dirname, ".vapidkeys"), "utf8"));
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(path.join(__dirname, ".vapidkeys"), JSON.stringify(vapidKeys));
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
const pushStore = require("./push-store");
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

// --- Passkeys (WebAuthn) for unlocking #Private ---
app.post("/passkey/register/options", async (req, res) => {
  try {
    const { password, label } = req.body || {};
    if (!privatePasswordMatches(password)) {
      return res.status(401).json({ error: "Wrong private room password" });
    }

    const context = webAuthnContextFromRequest(req);
    const pwFingerprint = passwordFingerprint();
    const existingCredentials = passkeyStore.getAll().filter(credential => credential.rpID === context.rpID && credential.passwordHash === pwFingerprint);
    const options = await generateRegistrationOptions({
      rpName: PASSKEY_RP_NAME,
      rpID: context.rpID,
      userID: PASSKEY_USER_ID,
      userName: PASSKEY_USER_NAME,
      userDisplayName: PASSKEY_USER_DISPLAY_NAME,
      timeout: 60000,
      attestationType: "none",
      excludeCredentials: existingCredentials.map(credential => ({ id: credential.id })),
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      supportedAlgorithmIDs: PASSKEY_SUPPORTED_ALGS,
    });

    const challengeId = savePasskeyChallenge("registration", options.challenge, context, {
      label: safePasskeyLabel(label, "Private room passkey"),
    });
    res.json({ challengeId, options });
  } catch (err) {
    console.error("Passkey registration options failed:", err);
    res.status(500).json({ error: "Could not start passkey setup" });
  }
});

app.post("/passkey/register/verify", async (req, res) => {
  try {
    const { challengeId, credential, label } = req.body || {};
    const challenge = consumePasskeyChallenge(challengeId, "registration");
    if (!challenge) return res.status(400).json({ error: "Passkey setup expired. Try again." });
    if (!credential) return res.status(400).json({ error: "Missing passkey response" });

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: PASSKEY_SUPPORTED_ALGS,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: "Passkey setup could not be verified" });
    }

    const info = verification.registrationInfo;
    const registeredCredential = info.credential;
    const pwFingerprint = passwordFingerprint();
    const record = passkeyStore.add({
      id: registeredCredential.id,
      publicKey: bytesToBase64URL(registeredCredential.publicKey),
      counter: registeredCredential.counter,
      transports: registeredCredential.transports || credential.response?.transports || [],
      rpID: challenge.rpID,
      origin: challenge.origin,
      passwordHash: pwFingerprint,
      label: safePasskeyLabel(label || challenge.label, "Private room passkey"),
      userVerified: info.userVerified,
      credentialDeviceType: info.credentialDeviceType,
      credentialBackedUp: info.credentialBackedUp,
    });

    const token = createPrivateAccessToken("passkey", record.id);
    res.json({ ok: true, token, credential: { id: record.id, label: record.label } });
  } catch (err) {
    console.error("Passkey registration verify failed:", err);
    res.status(400).json({ error: err.message || "Passkey setup failed" });
  }
});

app.post("/passkey/auth/options", async (req, res) => {
  try {
    const context = webAuthnContextFromRequest(req);
    const pwFingerprint = passwordFingerprint();
    const credentials = passkeyStore.getAll().filter(credential => credential.rpID === context.rpID && credential.passwordHash === pwFingerprint);
    if (!credentials.length) {
      return res.status(404).json({ error: "No passkey is saved for this site yet. Enter the private password and tap Save Passkey first." });
    }

    const options = await generateAuthenticationOptions({
      rpID: context.rpID,
      allowCredentials: credentials.map(credential => ({ id: credential.id })),
      timeout: 60000,
      userVerification: "required",
    });

    const challengeId = savePasskeyChallenge("authentication", options.challenge, context);
    res.json({ challengeId, options });
  } catch (err) {
    console.error("Passkey auth options failed:", err);
    res.status(500).json({ error: "Could not start passkey unlock" });
  }
});

app.post("/passkey/auth/verify", async (req, res) => {
  try {
    const { challengeId, credential } = req.body || {};
    const challenge = consumePasskeyChallenge(challengeId, "authentication");
    if (!challenge) return res.status(400).json({ error: "Passkey unlock expired. Try again." });
    if (!credential || !credential.id) return res.status(400).json({ error: "Missing passkey response" });

    const pwFingerprint = passwordFingerprint();
    const savedCredential = passkeyStore.get(credential.id);
    if (!savedCredential || savedCredential.rpID !== challenge.rpID || savedCredential.passwordHash !== pwFingerprint) {
      return res.status(404).json({ error: "This passkey is not registered for #Private on this site" });
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      credential: {
        id: savedCredential.id,
        publicKey: base64URLToBytes(savedCredential.publicKey),
        counter: savedCredential.counter || 0,
        transports: savedCredential.transports || [],
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return res.status(401).json({ error: "Passkey unlock was not verified" });
    }

    passkeyStore.update(savedCredential.id, {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: Date.now(),
      credentialDeviceType: verification.authenticationInfo.credentialDeviceType,
      credentialBackedUp: verification.authenticationInfo.credentialBackedUp,
    });

    const token = createPrivateAccessToken("passkey", savedCredential.id);
    res.json({ ok: true, token });
  } catch (err) {
    console.error("Passkey auth verify failed:", err);
    res.status(400).json({ error: err.message || "Passkey unlock failed" });
  }
});

const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const room = req.body.room || "public";
    const dir = room === "private" ? UPLOAD_PRIVATE : UPLOAD_PUBLIC;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage });
const uploadStore = require("./upload-store");

app.get("/limits", (req, res) => {
  res.json({ maxPrivateUploadMB, maxPublicMB: MAX_PUBLIC_MB });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const room = req.body.room || "public";
  if (room === "public" && req.file.size > MAX_PUBLIC_MB * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: "Public chat max " + MAX_PUBLIC_MB + "MB." });
  }
  if (room === "private" && req.file.size > maxPrivateUploadMB * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(413).json({ error: "File exceeds " + Math.round(maxPrivateUploadMB / 1024) + "GB storage limit." });
  }
  const id = path.parse(req.file.filename).name;
  const safeName = sanitize(req.file.originalname);
  uploadStore.saveFile(id, safeName, req.file.mimetype, req.file.filename, req.file.size);
  const uploadUrl = room === "private" ? "/uploads/private/" + req.file.filename : "/uploads/public/" + req.file.filename;
  console.log("Uploaded:", safeName, Math.round(req.file.size / 1024) + "KB", "[" + room + "]");
  res.json({ url: uploadUrl, name: safeName, type: req.file.mimetype, expires: Date.now() + FILE_EXPIRY });
});

app.get("/file/:id", (req, res) => {
  const file = uploadStore.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: "Not found" });
  res.redirect("/uploads/" + file.diskName);
});


const adjectives = ["Cool","Sneaky","Wild","Calm","Bold","Swift","Dark","Bright","Lone","Free","Happy","Clever"];
const nouns = ["Panda","Fox","Wolf","Eagle","Tiger","Owl","Bear","Hawk","Lynx","Raven","Cat","Dog"];
function randomName() {
  return adjectives[Math.floor(Math.random() * adjectives.length)] + nouns[Math.floor(Math.random() * nouns.length)] + Math.floor(Math.random() * 99);
}

io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  let username = randomName();
  usernames[socket.id] = username;
  console.log("Connect:", ip, "| Online:", Object.keys(usernames).length);
  socket.emit("welcome", { username });

  socket.on("set-name", (data) => {
    const oldName = usernames[socket.id];
    const newName = (data.name || "").trim().substring(0, 20) || randomName();
    usernames[socket.id] = newName;
    username = newName;
    socket.emit("name-changed", { username: newName });
    Object.keys(rooms).forEach(r => {
      if (rooms[r].users.has(socket.id)) io.to(r).emit("user-renamed", { oldName, newName });
    });
  });

  socket.on("join-room", (data = {}) => {
    const { room, password, passkeyToken } = data || {};
    if (!["public", "private"].includes(room)) {
      socket.emit("error-msg", { message: "Unknown room" });
      return;
    }
    let authMethod = room === "private" ? null : "open";
    if (room === "private") {
      if (privatePasswordMatches(password)) {
        authMethod = "password";
      } else {
        const tokenPayload = verifyPrivateAccessToken(passkeyToken);
        if (tokenPayload && tokenPayload.method === "passkey") authMethod = "passkey";
      }
      if (!authMethod) {
        socket.emit("error-msg", { message: passkeyToken ? "Passkey unlock expired. Try again." : "Wrong password" });
        return;
      }
    }
    if (socket.rooms.has(room) && rooms[room]?.users.has(socket.id)) {
      socket.emit("room-joined", { room, users: rooms[room].users.size, messages: rooms[room].messages.slice(-100), authMethod });
      return;
    }
    Array.from(socket.rooms).forEach(r => {
      if (r === socket.id) return;
      socket.leave(r);
      if (rooms[r]?.users.delete(socket.id)) {
        socket.to(r).emit("user-left", { username, users: rooms[r].users.size });
      }
    });
    socket.join(room);
    if (!rooms[room]) rooms[room] = { messages: [], users: new Set() };
    rooms[room].users.add(socket.id);
    socket.emit("room-joined", { room, users: rooms[room].users.size, messages: rooms[room].messages.slice(-100), authMethod });
    socket.to(room).emit("user-joined", { username, users: rooms[room].users.size });
  });

  socket.on("message", (data) => {
    const { room, text, file } = data;
    if (!rooms[room] || !socket.rooms.has(room)) {
      socket.emit("error-msg", { message: "Join the room before sending messages" });
      return;
    }
    const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "unknown";
    const now = Date.now();
    const sid = socket.id;
    if (room !== "private") {
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
      if (file) {
        if (!userUploads[sid]) userUploads[sid] = [];
        userUploads[sid] = userUploads[sid].filter(t => now - t < RATE_LIMIT.fileWindowMs);
        if (userUploads[sid].length >= RATE_LIMIT.maxFileUploads) {
          socket.emit("error-msg", { message: "Too many uploads! Wait 5 minutes." });
          return;
        }
        userUploads[sid].push(now);
      }
      if (text && rooms[room]) {
        const lastMsgs = rooms[room].messages.slice(-20);
        const dup = lastMsgs.filter(m => m.username === usernames[sid] && m.text === text).length;
        if (dup >= 6) { socket.emit("error-msg", { message: "Stop spamming!" }); return; }
      }
    }
    const msg = { id: uuidv4(), username: usernames[sid], text, file, ip, time: new Date().toISOString(), room };
    if (rooms[room]) {
      rooms[room].messages.push(msg);
      if (rooms[room].messages.length > 10000) rooms[room].messages.shift();
      saveMessages(room);
    }
    io.to(room).emit("message", msg);
    // Push notifications only fire for #private messages
    if (room === "private") {
      sendPushToAll(JSON.stringify({
        title: "Anon Chat",
        body: (msg.username ? msg.username + ": " : "") + (msg.text || (msg.file ? "📎 " + (msg.file.name || "File") : "New message")),
        room: "private"
      }));
    }
    if (MESSAGE_EXPIRY) {
      setTimeout(() => {
        if (rooms[room]) {
          rooms[room].messages = rooms[room].messages.filter(m => m.id !== msg.id);
          io.to(room).emit("message-deleted", { id: msg.id });
          saveMessages(room);
        }
      }, MESSAGE_EXPIRY);
    }
  });

  socket.on("disconnect", () => {
    Object.keys(rooms).forEach(r => {
      if (rooms[r].users.has(socket.id)) {
        rooms[r].users.delete(socket.id);
        io.to(r).emit("user-left", { username: usernames[socket.id], users: rooms[r].users.size });
      }
    });
    delete usernames[socket.id];
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Anon Chat on http://0.0.0.0:" + PORT);
});
