// File metadata store — files are on disk, only metadata here
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'Data', 'uploads.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store));
}

function saveFile(id, name, type, diskName, size) {
  const store = loadStore();
  store[id] = { name, type, diskName, size, time: Date.now() };
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

module.exports = { saveFile, getFile, getAllFiles };
