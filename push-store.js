// Push subscription store — subscriptions on disk, only metadata here
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'Data', 'push-subscriptions.json');

function loadStore() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveStore(store) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch {}
}

function add(sub) {
  const store = loadStore();
  if (store.find(s => s.endpoint === sub.endpoint)) return;
  store.push(sub);
  saveStore(store);
}

function remove(endpoint) {
  const store = loadStore().filter(s => s.endpoint !== endpoint);
  saveStore(store);
}

function getAll() {
  return loadStore();
}

module.exports = { add, remove, getAll };
