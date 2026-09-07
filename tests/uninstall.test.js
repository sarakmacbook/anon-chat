const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, { namedVolumes = false, project = 'anon-chat', container = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-chat-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const app = path.join(home, 'anon-chat');
  const data = path.join(home, 'chat data');
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'tmp');
  for (const dir of [home, app, data, bin, temp, path.join(app, '.git'), path.join(data, 'uploads')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const file of ['uninstall.sh', 'install.sh', 'docker-compose.yml']) {
    fs.copyFileSync(path.join(repo, file), path.join(app, file));
  }
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"anon-chat"}');
  fs.writeFileSync(path.join(app, 'server.js'), '// fixture, not a running server');
  fs.writeFileSync(path.join(app, '.env'), 'PRIVATE_PASSWORD=test-secret');
  fs.writeFileSync(path.join(app, '.vapidkeys'), 'test-keys');
  fs.writeFileSync(path.join(data, 'messages.json'), '["private data"]');
  fs.writeFileSync(path.join(home, 'unrelated.txt'), 'keep me');
  if (!namedVolumes) {
    fs.writeFileSync(path.join(app, 'docker-compose.deploy.yml'), `services:\n  anon-chat:\n    volumes:\n      - "${data}:/app/Data"\n      - "${data}/uploads:/tmp/chat-uploads"\n`);
  }

  const owned = { project, service: 'anon-chat', workingDir: app };
  const state = {
    available: true,
    expectedProject: project,
    containers: [
      ...(container ? [{ ...owned, id: 'container-chat', name: 'anon-chat', mounts: namedVolumes ? [
        { type: 'volume', source: `${project}_chat-data`, target: '/app/Data' },
        { type: 'volume', source: `${project}_chat-uploads`, target: '/tmp/chat-uploads' },
      ] : [
        { type: 'bind', source: data, target: '/app/Data' },
        { type: 'bind', source: `${data}/uploads`, target: '/tmp/chat-uploads' },
      ] }] : []),
      { id: 'container-other', name: 'other-app', project: 'other-app', service: 'other-app', mounts: [] },
    ],
    images: [
      { ...owned, id: 'image-chat' },
      { id: 'image-other', project: 'other-app', service: 'other-app' },
      { id: 'image-other-service', project, service: 'other-service' },
    ],
    networks: [
      { id: 'network-chat', project, key: 'default' },
      { id: 'network-other', project: 'other-app', key: 'default' },
    ],
    volumes: [
      ...(namedVolumes ? ['chat-data', 'chat-uploads'].map((key) => ({ name: `${project}_${key}`, project, key })) : []),
      { name: 'volume-other', project: 'other-app', key: 'chat-data' },
      { name: 'volume-other-service', project, key: 'database' },
    ],
  };
  const stateFile = path.join(root, 'docker-state.json');
  const logFile = path.join(root, 'docker.log');
  const writeState = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  writeState();
  fs.writeFileSync(logFile, '');

  function executable(name, content) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }
  executable('docker', `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(__dirname, 'fixtures/docker.cjs'))} "$@"\n`);
  executable('sudo', '#!/bin/sh\n[ "$TEST_ALLOW_SUDO" = 1 ] || exit 1\nexport TEST_USING_SUDO=1\nexec "$@"\n');
  // A second safety boundary: even if a regression gets past the script's
  // guards, rm in this suite can only touch the disposable fixture directory.
  executable('rm', `#!${process.execPath}\nconst path = require('node:path');\nconst {spawnSync} = require('node:child_process');\nconst args = process.argv.slice(2);\nfor (const arg of args.filter(a => !a.startsWith('-'))) {\n  const target = path.resolve(arg);\n  if (!target.startsWith(process.env.TEST_ROOT + '/')) throw new Error('Unsafe test deletion: ' + target);\n}\nprocess.exit(spawnSync('/bin/rm', args, {stdio: 'inherit'}).status);\n`);
  executable('curl', `#!/bin/sh\n[ "$1" = -fsSL ] && [ "$3" = -o ] || exit 1\ncp ${quote(path.join(repo, 'uninstall.sh'))} "$4"\n`);
  const env = { ...process.env, HOME: home, TMPDIR: temp, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TEST_DOCKER_STATE: stateFile, TEST_DOCKER_LOG: logFile };
  for (const key of ['ANON_CHAT_DIR', 'ANON_CHAT_DATA', 'ANON_CHAT_PROJECT', 'COMPOSE_PROJECT_NAME', 'TEST_ALLOW_SUDO', 'TEST_USING_SUDO']) delete env[key];
  function run(args = [], overrides = {}, { installer = false, piped = false, tty = false } = {}) {
    const script = path.join(app, installer ? 'install.sh' : 'uninstall.sh');
    let command = 'bash';
    let argv = piped ? ['-s', '--', ...args] : [script, ...args];
    let input = piped ? fs.readFileSync(script, 'utf8') : undefined;
    if (tty) {
      command = 'script';
      argv = ['-q', '-e', '-c', ['bash', script, ...args].map(quote).join(' '), '/dev/null'];
      input = tty;
    }
    const result = spawnSync(command, argv, {
      cwd: home, env: { ...env, ...overrides }, input, encoding: 'utf8', timeout: 15000,
      // Avoid accidentally prompting on the test runner's own terminal.
      detached: true,
    });
    if (result.error) throw result.error;
    result.output = result.stdout + result.stderr;
    return result;
  }
  const logs = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const removals = () => logs().filter((args) => args[1] === 'rm');
  return { root, home, app, data, temp, bin, state, writeState, run, logs, removals, readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
}

function succeeded(result) { assert.equal(result.status, 0, result.output); }
function failed(result, pattern) { assert.notEqual(result.status, 0, result.output); assert.match(result.output, pattern); }
function untouched(f) {
  assert.ok(fs.existsSync(path.join(f.app, '.env')));
  assert.ok(fs.existsSync(path.join(f.data, 'messages.json')));
  assert.equal(f.removals().length, 0);
}

test('help and unknown options do not inspect Docker or delete files', (t) => {
  const f = fixture(t);
  succeeded(f.run(['--help']));
  failed(f.run(['--purge-everything']), /Unknown option/);
  assert.deepEqual(f.logs(), []);
  untouched(f);
});

test('dry-run previews live custom bind mounts and all owned Docker resources', (t) => {
  const f = fixture(t);
  const result = f.run(['--dry-run', '--yes']);
  succeeded(result);
  assert.ok(result.stdout.includes(f.data));
  for (const id of ['container-chat', 'image-chat', 'network-chat']) assert.ok(result.stdout.includes(id));
  assert.match(result.stdout, /Nothing was removed/);
  assert.ok(!result.stdout.includes('image-other'));
  untouched(f);
});

test('requires explicit confirmation without a terminal (piped input is not consent)', (t) => {
  const f = fixture(t);
  failed(f.run([], {}, { piped: true }), /No interactive terminal/);
  untouched(f);
});

test('complete uninstall removes app, secrets, custom data and only its Docker resources', (t) => {
  const f = fixture(t);
  succeeded(f.run(['--yes']));
  assert.ok(!fs.existsSync(f.app));
  assert.ok(!fs.existsSync(f.data));
  assert.ok(fs.existsSync(path.join(f.home, 'unrelated.txt')));
  const remaining = f.readState();
  assert.deepEqual(remaining.containers.map((item) => item.id), ['container-other']);
  assert.deepEqual(remaining.images.map((item) => item.id), ['image-other', 'image-other-service']);
  assert.deepEqual(remaining.networks.map((item) => item.id), ['network-other']);
  assert.equal(remaining.volumes.length, 2);
  assert.deepEqual(f.removals().map((args) => args[0]), ['container', 'network', 'image']);
});

test('manual Compose installation deletes named volumes, not unrelated bind data', (t) => {
  const f = fixture(t, { namedVolumes: true });
  succeeded(f.run(['--yes']));
  assert.ok(!fs.existsSync(f.app));
  assert.ok(fs.existsSync(f.data));
  assert.deepEqual(f.readState().volumes.map((item) => item.name), ['volume-other', 'volume-other-service']);
  assert.deepEqual(f.removals().at(-1), ['volume', 'rm', '--', 'anon-chat_chat-data', 'anon-chat_chat-uploads']);
});

test('discovers a custom Compose project from the live container', (t) => {
  const f = fixture(t, { project: 'custom-project' });
  const result = f.run(['--yes']);
  succeeded(result);
  assert.match(result.stdout, /Compose project: custom-project/);
  assert.ok(!fs.existsSync(f.data));
});

test('discovers old installer bind mounts without a container or install record', (t) => {
  const f = fixture(t, { container: false });
  succeeded(f.run(['--yes']));
  assert.ok(!fs.existsSync(f.app));
  assert.ok(!fs.existsSync(f.data));
});

test('removes stopped manual Compose volumes even after its container is gone', (t) => {
  const f = fixture(t, { container: false, namedVolumes: true });
  succeeded(f.run(['--yes']));
  assert.deepEqual(f.readState().volumes.map((item) => item.name), ['volume-other', 'volume-other-service']);
});

test('uses the installation record when deployment file and container are missing', (t) => {
  const f = fixture(t, { container: false, project: 'recorded-project' });
  fs.unlinkSync(path.join(f.app, 'docker-compose.deploy.yml'));
  fs.writeFileSync(path.join(f.app, '.anon-chat-install'), `data_dir=${f.data}\nproject_name=recorded-project\n`);
  succeeded(f.run(['--yes']));
  assert.ok(!fs.existsSync(f.data));
  assert.deepEqual(f.readState().images.map((item) => item.id), ['image-other', 'image-other-service']);
});

test('honors explicit app/data/project overrides for missing deployment metadata', (t) => {
  const f = fixture(t, { container: false, project: 'custom-project' });
  fs.unlinkSync(path.join(f.app, 'docker-compose.deploy.yml'));
  const customApp = path.join(f.home, 'custom app');
  fs.renameSync(f.app, customApp);
  const result = spawnSync('bash', [path.join(customApp, 'uninstall.sh'), '--yes'], {
    encoding: 'utf8', env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, TEST_ROOT: f.root,
      TEST_DOCKER_STATE: path.join(f.root, 'docker-state.json'), TEST_DOCKER_LOG: path.join(f.root, 'docker.log'),
      ANON_CHAT_DIR: customApp, ANON_CHAT_DATA: f.data, ANON_CHAT_PROJECT: 'custom-project' },
    detached: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!fs.existsSync(customApp));
  assert.ok(!fs.existsSync(f.data));
});

for (const unsafe of ['/', '/tmp', '/var/lib/docker', '/var/log', '/etc/ssh', 'HOME', 'HOME/..']) {
  test(`rejects unsafe removal target ${unsafe}`, (t) => {
    const f = fixture(t);
    const target = unsafe.replace('HOME', f.home);
    failed(f.run(['--yes'], { ANON_CHAT_DATA: target }), /Refusing/);
    untouched(f);
  });
}

test('rejects data that is the application directory or its parent', (t) => {
  const f = fixture(t, { container: false });
  failed(f.run(['--yes'], { ANON_CHAT_DATA: `${f.app}/.` }), /must not be the application directory/);
  untouched(f);
});

test('rejects a symlink or a symlink followed by .. in data paths', (t) => {
  const f = fixture(t);
  const link = path.join(f.home, 'data-link');
  fs.symlinkSync(f.data, link);
  failed(f.run(['--yes'], { ANON_CHAT_DATA: link }), /symlink/);
  failed(f.run(['--yes'], { ANON_CHAT_DATA: `${link}/../another-directory` }), /symlink/);
  untouched(f);
});

test('refuses a directory without the Anon Chat application identity', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.app, 'package.json'), '{"name":"unrelated-app"}');
  failed(f.run(['--yes']), /does not look like an Anon Chat/);
  untouched(f);
});

test('refuses a same-named container belonging to another checkout', (t) => {
  const f = fixture(t);
  f.state.containers[0].workingDir = path.join(f.home, 'other-chat');
  f.writeState();
  failed(f.run(['--yes']), /belongs to another/);
  untouched(f);
});

test('refuses an explicit data override that disagrees with live mounts', (t) => {
  const f = fixture(t);
  failed(f.run(['--yes'], { ANON_CHAT_DATA: path.join(f.home, 'other-data') }), /does not match this container/);
  untouched(f);
});

test('refuses a conflicting explicit project name', (t) => {
  const f = fixture(t);
  failed(f.run(['--yes'], { ANON_CHAT_PROJECT: 'wrong-project' }), /does not match/);
  untouched(f);
});

test('refuses external/shared volumes before stopping any container', (t) => {
  const f = fixture(t, { namedVolumes: true });
  f.state.volumes[0].project = 'other-project';
  f.writeState();
  failed(f.run(['--yes']), /external\/shared/);
  untouched(f);
});

test('does not delete files when Docker is unavailable', (t) => {
  const f = fixture(t);
  f.state.available = false;
  f.writeState();
  failed(f.run(['--yes']), /Cannot access Docker/);
  untouched(f);
});

test('uses sudo for Docker only when regular access fails', (t) => {
  const f = fixture(t);
  if (process.getuid?.() === 0) return t.skip('Root does not need sudo');
  f.state.needsSudo = true;
  f.writeState();
  succeeded(f.run(['--yes'], { TEST_ALLOW_SUDO: '1' }));
  assert.ok(!fs.existsSync(f.app));
});

for (const kind of ['container', 'network', 'image', 'volume']) {
  test(`stops before filesystem cleanup if ${kind} removal fails`, (t) => {
    const f = fixture(t, { namedVolumes: kind === 'volume' });
    f.state.failRemoval = kind;
    f.writeState();
    failed(f.run(['--yes']), /cleanup failed/);
    assert.ok(fs.existsSync(path.join(f.app, '.env')));
    assert.ok(fs.existsSync(path.join(f.data, 'messages.json')));
  });
}

test('files-only requires opt-in and never invokes Docker', (t) => {
  const f = fixture(t);
  f.state.available = false;
  f.writeState();
  succeeded(f.run(['--files-only', '--dry-run']));
  untouched(f);
  const result = f.run(['--files-only', '--yes']);
  succeeded(result);
  assert.match(result.stdout, /Docker cleanup was explicitly skipped/);
  assert.ok(!fs.existsSync(f.app));
  assert.ok(!fs.existsSync(f.data));
  assert.deepEqual(f.logs(), []);
});

test('metadata is never executed as shell code', (t) => {
  const f = fixture(t, { container: false });
  const sentinel = path.join(f.home, 'injected');
  fs.writeFileSync(path.join(f.app, '.anon-chat-install'), `touch ${sentinel}\ndata_dir=${f.data}\nproject_name=anon-chat\n`);
  succeeded(f.run(['--dry-run']));
  assert.ok(!fs.existsSync(sentinel));
  untouched(f);
});

test('ambiguous edited Compose mounts are not silently ignored', (t) => {
  const f = fixture(t, { container: false });
  fs.writeFileSync(path.join(f.app, 'docker-compose.deploy.yml'), 'services:\n  anon-chat:\n    volumes:\n      - type: bind\n        source: /somewhere\n        target: /app/Data\n');
  failed(f.run(['--yes']), /Cannot discover both data mounts/);
  untouched(f);
});

test('fallback discovery never deletes another service\'s bind-mounted data', (t) => {
  const f = fixture(t, { container: false });
  const otherData = path.join(f.home, 'other-data');
  fs.mkdirSync(otherData);
  fs.writeFileSync(path.join(otherData, 'keep.txt'), 'unrelated data');
  fs.appendFileSync(path.join(f.app, 'docker-compose.deploy.yml'), `  other-service:\n    volumes:\n      - "${otherData}:/app/Data"\n      - "${otherData}/uploads:/tmp/chat-uploads"\n`);
  succeeded(f.run(['--yes']));
  assert.ok(!fs.existsSync(f.data));
  assert.equal(fs.readFileSync(path.join(otherData, 'keep.txt'), 'utf8'), 'unrelated data');
});

test('fallback refuses edited external/named resources it cannot safely discover', (t) => {
  const f = fixture(t, { namedVolumes: true, container: false });
  fs.appendFileSync(path.join(f.app, 'docker-compose.yml'), '    external: true\n');
  failed(f.run(['--yes']), /require a container to inspect/);
  untouched(f);
});

test('local installer dispatches uninstall before doing installation work', (t) => {
  const f = fixture(t);
  succeeded(f.run(['--uninstall', '--files-only', '--dry-run'], {}, { installer: true }));
  succeeded(f.run(['--uninstall', '--help'], {}, { installer: true }));
  assert.deepEqual(f.logs(), []);
  untouched(f);
});

test('piped installer downloads and dispatches the standalone uninstaller, then cleans its temp file', (t) => {
  const f = fixture(t);
  succeeded(f.run(['--uninstall', '--files-only', '--dry-run'], {}, { installer: true, piped: true }));
  assert.deepEqual(fs.readdirSync(f.temp), []);
  assert.deepEqual(f.logs(), []);
  untouched(f);
});

test('repeat uninstall after successful removal is harmless', (t) => {
  const f = fixture(t);
  const script = fs.readFileSync(path.join(f.app, 'uninstall.sh'), 'utf8');
  succeeded(f.run(['--yes']));
  // Run the downloaded script via stdin without recreating the installation.
  const result = spawnSync('bash', ['-s', '--', '--yes'], {
    input: script, encoding: 'utf8', detached: true, timeout: 15000,
    env: { ...process.env, HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, TEST_ROOT: f.root,
      TEST_DOCKER_STATE: path.join(f.root, 'docker-state.json'), TEST_DOCKER_LOG: path.join(f.root, 'docker.log') },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(f.home, 'unrelated.txt')));
});

test('installer records absolute paths and project, then preserves custom data on updates', { skip: !fs.existsSync('/etc/os-release') }, (t) => {
  const f = fixture(t);
  const stub = (name, content) => fs.writeFileSync(path.join(f.bin, name), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  // Every system/package/network command is stubbed. Nothing is installed and
  // no real Git or Docker command can be reached by this installer smoke test.
  for (const command of ['apt-get', 'yum', 'dnf', 'pacman', 'apk', 'git', 'ss']) stub(command, 'exit 0');
  stub('id', 'echo 0');
  stub('docker', `case "$*" in
    --version) echo 'Docker fixture' ;;
    'compose version'|'compose -f docker-compose.deploy.yml down --remove-orphans'|'compose -f docker-compose.deploy.yml build'|'compose -f docker-compose.deploy.yml up -d') exit 0 ;;
    'container inspect '*) echo 'custom-project' ;;
    'ps --filter name=anon-chat --format {{.Status}}') echo 'Up 1 minute' ;;
    *) echo "Unexpected installer Docker command: $*" >&2; exit 1 ;;
  esac`);
  stub('curl', `case "$*" in
    '-fsS -o /dev/null --max-time 3 http://127.0.0.1:32123/') exit 0 ;;
    '-s --max-time 5 ifconfig.me') echo '192.0.2.1' ;;
    *) echo "Unexpected installer curl command: $*" >&2; exit 1 ;;
  esac`);
  succeeded(f.run([], { ANON_CHAT_DIR: 'anon-chat', ANON_CHAT_DATA: 'chat data', ANON_CHAT_PORT: '32123', PRIVATE_PASSWORD: 'test-secret' }, { installer: true }));
  const record = path.join(f.app, '.anon-chat-install');
  const expected = `data_dir=${f.data}\nproject_name=custom-project\n`;
  assert.equal(fs.readFileSync(record, 'utf8'), expected);
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  succeeded(f.run([], { ANON_CHAT_PORT: '32123', PRIVATE_PASSWORD: 'test-secret' }, { installer: true }));
  assert.equal(fs.readFileSync(record, 'utf8'), expected);
  assert.ok(fs.readFileSync(path.join(f.app, 'docker-compose.deploy.yml'), 'utf8').includes(`"${f.data}:/app/Data"`));
  assert.ok(fs.existsSync(path.join(f.data, 'messages.json')));
});

const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;
for (const [answer, deleted] of [['no\n', false], ['uninstall\n', true]]) {
  test(`interactive confirmation ${deleted ? 'accepts exact phrase' : 'cancels safely'}`, { skip: !hasScript }, (t) => {
    const f = fixture(t);
    const result = f.run(['--files-only'], {}, { tty: answer });
    succeeded(result);
    assert.match(result.stdout, /Type 'uninstall'/);
    assert.equal(fs.existsSync(f.app), !deleted);
    assert.equal(fs.existsSync(f.data), !deleted);
    assert.deepEqual(f.logs(), []);
  });
}
