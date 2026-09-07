const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const multer = require("multer");
const webpush = require("web-push");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10 * 1024 * 1024 * 1024 });

const PORT = 3000;
const crypto = require("crypto");
const PRIVATE_PASSWORD_HASH = "8d23cf6c86e834a7aa6eded54c26ce2bb2e74903538c61bdd5d2197997ab2f72";
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

  socket.on("join-room", (data) => {
    const { room, password } = data;
    if (room === "private") {
      const hashed = crypto.createHash('sha256').update(password || '').digest('hex');
      if (hashed !== PRIVATE_PASSWORD_HASH) {
        socket.emit("error-msg", { message: "Wrong password" });
        return;
      }
    }
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join(room);
    if (!rooms[room]) rooms[room] = { messages: [], users: new Set() };
    rooms[room].users.add(socket.id);
    socket.emit("room-joined", { room, users: rooms[room].users.size, messages: rooms[room].messages.slice(-100) });
    socket.to(room).emit("user-joined", { username, users: rooms[room].users.size });
  });

  socket.on("message", (data) => {
    const { room, text, file } = data;
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
