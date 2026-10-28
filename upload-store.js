// File metadata store — files are on disk, only metadata here
const fs = require('fs');
const path = require('path');
const DATA_ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'Data');
const DATA_FILE = path.join(DATA_ROOT, 'uploads.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
}

function saveFile(id, name, type, diskName, size, room) {
  const store = loadStore();
  store[id] = { name, type, diskName, size, room: room === 'private' ? 'private' : 'public', time: Date.now() };
  saveStore(store);
  return id;
}

function getFile(id) {
  const store = loadStore();
  return store[id];
}

function getAllFiles() {
  const store = loadStore();
  return Object.keys(store).map(id => ({ id, ...store[id] }));
}

/** Drop a record. Returns it so the caller can unlink the file on disk. */
function removeFile(id) {
  const store = loadStore();
  const record = store[id];
  if (!record) return null;
  delete store[id];
  saveStore(store);
  return record;
}

/** Drop every record belonging to a room. Used by "clear room history". */
function removeByRoom(room) {
  const store = loadStore();
  const removed = [];
  for (const id of Object.keys(store)) {
    const record = store[id];
    const recordRoom = record.room === 'private' ? 'private' : 'public';
    if (recordRoom === room) {
      removed.push({ id, ...record, room: recordRoom });
      delete store[id];
    }
  }
  if (removed.length) saveStore(store);
  return removed;
}

module.exports = { saveFile, getFile, getAllFiles, removeFile, removeByRoom };
