// A stateful Docker double: uninstall tests must never talk to a real daemon.
const fs = require('node:fs');
const assert = require('node:assert/strict');

const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.TEST_DOCKER_STATE, 'utf8'));
fs.appendFileSync(process.env.TEST_DOCKER_LOG, `${JSON.stringify(args)}\n`);
const [kind, action] = args;
const fail = (message) => { console.error(message); process.exit(1); };
const print = (values) => { if (values.length) console.log(values.join('\n')); };
const labels = (item) => ({
  'com.docker.compose.project': item.project,
  'com.docker.compose.service': item.service,
  'com.docker.compose.project.working_dir': item.workingDir,
  'com.docker.compose.volume': item.key,
  'com.docker.compose.network': item.key,
});

if (kind === 'info') {
  if (!state.available || (state.needsSudo && !process.env.TEST_USING_SUDO)) fail('Cannot access Docker');
  process.exit(0);
}
assert.ok(state.available, 'Unexpected Docker command while daemon is unavailable');
const collections = { container: 'containers', image: 'images', network: 'networks', volume: 'volumes' };
assert.ok(collections[kind], `Unexpected Docker command: ${args}`);
let items = state[collections[kind]];

if (action === 'ls') {
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--filter') continue;
    const filter = args[++i];
    if (filter === 'name=^/anon-chat$') items = items.filter((item) => item.name === 'anon-chat');
    else if (filter.startsWith('label=')) {
      const [key, value] = filter.slice(6).split('=');
      items = items.filter((item) => labels(item)[key] === value);
    } else fail(`Unsupported filter: ${filter}`);
  }
  print(items.map((item) => kind === 'volume' ? item.name : item.id));
} else if (action === 'inspect') {
  const item = items.find((item) => item.id === args.at(-1) || item.name === args.at(-1));
  assert.ok(item, `No such ${kind}: ${args.at(-1)}`);
  const format = args[args.indexOf('--format') + 1];
  if (format.includes('.Mounts')) {
    print(item.mounts.map((mount) => [mount.type, mount.source, mount.target].join('\t')));
  } else {
    const label = format.match(/"([\w.]+)"/)[1];
    console.log(labels(item)[label] || '<no value>');
  }
} else if (action === 'rm') {
  if (state.failRemoval === kind) fail(`Simulated ${kind} removal failure`);
  assert.ok(args.includes('--'), 'Resource arguments must be separated from flags');
  assert.equal(args.includes('--force'), kind === 'container', 'Never force-remove shared Docker resources');
  const ids = args.slice(args.indexOf('--') + 1);
  for (const id of ids) {
    const item = items.find((item) => item.id === id || item.name === id);
    assert.ok(item, `No such ${kind}: ${id}`);
    assert.equal(item.project, state.expectedProject, `Attempt to delete an unrelated ${kind}`);
    if (kind === 'container' || kind === 'image') assert.equal(item.service, 'anon-chat');
  }
  state[collections[kind]] = items.filter((item) => !ids.includes(item.id) && !ids.includes(item.name));
  fs.writeFileSync(process.env.TEST_DOCKER_STATE, JSON.stringify(state));
  print(ids);
} else {
  fail(`Unexpected Docker command: ${args}`);
}
