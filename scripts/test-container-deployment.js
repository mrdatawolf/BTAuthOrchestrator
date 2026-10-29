// Run after npm run build on Node 22. Isolated /tmp data, never loads repo .env.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { acquireProcessLock } = require('../dist/processLock.js');
const { openDatabase, prepareDataDirectory } = require('../dist/database.js');
const { validateContainerIdentity, hasDataMount, checkContainerStorage } = require('../dist/container.js');
const { createSecretsStore } = require('../dist/secrets.js');
const { verifyPassword } = require('../dist/password.js');
const { createLocalUserStore } = require('../dist/localUsers.js');

if (process.argv[2] === 'holder') {
  (async () => {
    const held = await acquireProcessLock(process.argv[3]);
    process.send('ready');
    process.on('message', async () => { await held.close(); process.exit(0); });
  })().catch(error => { console.error(error.message); process.exit(1); });
} else main().catch(error => { console.error(error); process.exitCode = 1; });

const children = new Set();
function holder(path) {
  const child = spawn(process.execPath, [__filename, 'holder', path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child);
  child.output = '';
  child.stdout.on('data', b => { child.output += b; });
  child.stderr.on('data', b => { child.output += b; });
  child.done = once(child, 'exit').then(([status, signal]) => { children.delete(child); return { status, signal }; });
  child.ready = new Promise(resolveReady => {
    child.once('message', () => resolveReady(true));
    child.once('exit', () => resolveReady(false));
  });
  return child;
}
async function stop(child, signal) {
  if (signal) child.kill(signal); else child.send('close');
  return child.done;
}

async function main() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bt-deploy-'));
  const lockPath = join(directory, '.btauthorchestrator.lock');
  try {
    assert.throws(() => validateContainerIdentity('/data', 0), /non-root/);
    assert.throws(() => validateContainerIdentity('/wrong', 568), /PGLITE_DATA_DIR/);
    validateContainerIdentity('/data', 568);
    validateContainerIdentity('/data', 1234);
    assert.equal(hasDataMount('1 2 3:4 / / rw - overlay overlay rw'), false);
    assert.equal(hasDataMount('1 2 3:4 /dataset /data rw - zfs tank/data rw'), true);
    assert.equal(hasDataMount('1 2 3:4 / /data-other rw - ext4 /dev/sda rw'), false);
    process.env.BT_CONTAINER_MODE = '1';
    await assert.rejects(checkContainerStorage('/data'), /operator-supplied storage|non-root/);
    delete process.env.BT_CONTAINER_MODE;
    console.log('PASS: container root/path guards, non-default UID, mount detection and actual missing mount fail closed');

    if (process.platform !== 'win32') {
      let first = holder(lockPath);
      assert.equal(await first.ready, true, first.output);
      let second = holder(lockPath);
      assert.equal(await second.ready, false);
      assert.match(second.output, /still running/);
      first.kill('SIGSTOP');
      second = holder(lockPath);
      assert.equal(await second.ready, false);
      assert.match(second.output, /still running/);
      first.kill('SIGCONT');
      await stop(first, 'SIGKILL');
      first = holder(lockPath);
      assert.equal(await first.ready, true, first.output);
      assert.match(first.output, /Recovered stale lock.*pid/);
      await stop(first);
      await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
      console.log('PASS: live and paused holders refused, SIGKILL recovered, clean close releases');

      for (let iteration = 0; iteration < 8; iteration++) {
        first = holder(lockPath);
        assert.equal(await first.ready, true, first.output);
        await stop(first, 'SIGKILL');
        const racers = Array.from({ length: 4 }, () => holder(lockPath));
        const ready = await Promise.all(racers.map(c => c.ready));
        assert.equal(ready.filter(Boolean).length, 1, racers.map(c => c.output).join('\n'));
        await stop(racers[ready.indexOf(true)]);
      }
      console.log('PASS: eight four-process simultaneous stale-lock races each admit exactly one holder');

      first = holder(lockPath);
      assert.equal(await first.ready, true);
      const old = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      await stop(first, 'SIGKILL');
      const guard = holder(join(directory, `.bt-recover-${old.id}`));
      assert.equal(await guard.ready, true);
      await stop(guard, 'SIGKILL');
      first = holder(lockPath);
      assert.equal(await first.ready, true, first.output);
      assert.match(first.output, /Recovered stale lock.*bt-recover/);
      await stop(first);
      console.log('PASS: interrupted takeover guard is itself recovered');

      await fs.writeFile(lockPath, '123\n');
      await assert.rejects(acquireProcessLock(lockPath), /legacy.*Stop every instance/);
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, JSON.stringify({ id: old.id, socket: old.socket, pid: old.pid }));
      await assert.rejects(acquireProcessLock(lockPath), /Cannot determine holder liveness/);
      await fs.unlink(lockPath);
      await assert.rejects(acquireProcessLock(join(directory, 'x'.repeat(100), 'lock')), /103 bytes/);
      await fs.chmod(directory, 0o755);
      await assert.rejects(prepareDataDirectory(directory), /chmod 700/);
      await fs.chmod(directory, 0o700);
      console.log('PASS: legacy/missing socket/overlong paths and wrong permissions fail closed');
    }

    const data = join(directory, 'data');
    const env = {
      PATH: process.env.PATH, PORT: '3210', PGLITE_DATA_DIR: data,
      DB_ENCRYPTION_KEY: 'a'.repeat(64), COOKIE_SECURE: 'true',
      SERVICE_ISSUER: 'https://orca.biztechro.com', LOCAL_LOGIN: 'true',
      EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: 'c'.repeat(32),
      CLIENT_SECRET: 'throwaway-client-secret', INITIAL_LOCAL_USER_USERNAME: ' Test.User ',
      INITIAL_LOCAL_USER_EMAIL: 'test@example.test', INITIAL_LOCAL_USER_PASSWORD: 'throwaway-password-123',
    };
    const seed = (overrides = {}, args = ['--non-interactive'], cwd = directory) => {
      const result = spawnSync(process.execPath, [resolve('scripts/seed.js'), ...args], {
        env: { ...env, ...overrides }, cwd, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(result.error, undefined);
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const snapshot = async () => {
      const handle = await openDatabase(data);
      try {
        const rows = {};
        for (const table of ['secrets', 'signing_keys', 'local_users']) rows[table] = (await handle.database.query(`SELECT * FROM ${table}`)).rows;
        return JSON.stringify(rows);
      } finally { await handle.close(); }
    };
    for (const [name, value] of [
      ['CLIENT_SECRET', ''], ['INITIAL_LOCAL_USER_USERNAME', ''], ['INITIAL_LOCAL_USER_EMAIL', ''],
      ['INITIAL_LOCAL_USER_PASSWORD', ''], ['INITIAL_LOCAL_USER_USERNAME', '!'],
      ['INITIAL_LOCAL_USER_EMAIL', 'bad'], ['INITIAL_LOCAL_USER_PASSWORD', '12345678901'],
    ]) {
      const failed = seed({ [name]: value });
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, new RegExp(name));
      assert.deepEqual(JSON.parse(await snapshot()), { secrets: [], signing_keys: [], local_users: [] });
    }
    const inputFile = join(directory, 'untouched');
    await fs.writeFile(inputFile, 'do not consume');
    for (const flag of ['--client-secret-file', '--local-user-file']) {
      const failed = seed({}, ['--non-interactive', `${flag}=${inputFile}`]);
      assert.equal(failed.status, 1);
      assert.equal(await fs.readFile(inputFile, 'utf8'), 'do not consume');
    }
    const noFileChannel = seed({ CLIENT_SECRET: '', CLIENT_SECRET_FILE: inputFile });
    assert.equal(noFileChannel.status, 1);
    assert.equal(await fs.readFile(inputFile, 'utf8'), 'do not consume');
    console.log('PASS: missing/invalid inputs write no seed rows; non-interactive file flags rejected; no *_FILE channel');

    const fresh = seed();
    assert.equal(fresh.status, 0, fresh.output);
    for (const text of ['CLIENT_SECRET stored', 'Signing key', 'Local user test.user created']) assert.ok(fresh.output.includes(text));
    const before = await snapshot();
    const repeat = seed({ INITIAL_LOCAL_USER_PASSWORD: 'bad' });
    assert.equal(repeat.status, 0, repeat.output);
    assert.match(repeat.output, /Database already seeded/);
    for (const name of ['CLIENT_SECRET', 'INITIAL_LOCAL_USER_USERNAME', 'INITIAL_LOCAL_USER_EMAIL', 'INITIAL_LOCAL_USER_PASSWORD']) assert.ok(repeat.output.includes(`${name} ignored`));
    assert.equal(await snapshot(), before);
    const removed = Object.fromEntries(['CLIENT_SECRET', 'INITIAL_LOCAL_USER_USERNAME', 'INITIAL_LOCAL_USER_EMAIL', 'INITIAL_LOCAL_USER_PASSWORD'].map(n => [n, undefined]));
    assert.equal(seed(removed).status, 0);
    assert.equal(await snapshot(), before);
    for (const result of [fresh, repeat]) {
      for (const name of ['CLIENT_SECRET', 'INITIAL_LOCAL_USER_PASSWORD', 'DB_ENCRYPTION_KEY']) assert.equal(result.output.includes(env[name]), false);
    }
    let handle = await openDatabase(data);
    try {
      const store = createSecretsStore(handle.database, env.DB_ENCRYPTION_KEY);
      assert.equal(await store.getSecret('CLIENT_SECRET'), env.CLIENT_SECRET);
      await store.getCurrentSigningKey();
      const user = await createLocalUserStore(handle.database).findByUsername('test.user');
      assert.equal(await verifyPassword(env.INITIAL_LOCAL_USER_PASSWORD, { hash: user.passwordHash, salt: user.passwordSalt, algorithm: user.passwordAlgorithm, costN: user.passwordCostN, blockSizeR: user.passwordBlockSizeR, parallelizationP: user.passwordParallelizationP, keyLength: user.passwordKeyLength }), true);
      assert.equal((await handle.database.query('SELECT created_by FROM local_users')).rows[0].created_by, 'seed-script');
      // A partial bootstrap must preserve existing ciphertext and key rows.
      await handle.database.exec('DELETE FROM local_users');
    } finally { await handle.close(); }
    const partial = JSON.parse(await snapshot());
    assert.equal(seed({ CLIENT_SECRET: undefined }).status, 0);
    const completed = JSON.parse(await snapshot());
    assert.deepEqual(completed.secrets, partial.secrets);
    assert.deepEqual(completed.signing_keys, partial.signing_keys);
    console.log('PASS: first boot, unchanged restart, ignored-input warnings, input removal, encryption/password checks and partial bootstrap');

    // Plain launcher retains .env loading and read-then-unlink, even on a no-op.
    await fs.writeFile(join(directory, '.env'), '');
    const secretFile = join(directory, 'secret');
    const userFile = join(directory, 'user');
    await fs.writeFile(secretFile, 'throwaway\n');
    await fs.writeFile(userFile, 'another\nother@example.test\nthrowaway-password-456\n');
    const prior = await snapshot();
    const plain = seed({}, [`--client-secret-file=${secretFile}`, `--local-user-file=${userFile}`]);
    assert.equal(plain.status, 1, plain.output);
    assert.match(plain.output, /Database already seeded/);
    await assert.rejects(fs.stat(secretFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(userFile), { code: 'ENOENT' });
    assert.equal(await snapshot(), prior);
    console.log('PASS: plain CLI still exits non-zero when seeded and consumes both one-time files');
    for (const [flag, content] of [
      ['--client-secret-file', 'throwaway-file-secret\n'],
      ['--local-user-file', 'file.user\nfile@example.test\nthrowaway-password-789\n'],
    ]) {
      await fs.writeFile(inputFile, content);
      const failureData = join(directory, flag.slice(2));
      // Inject the actual OS failure at the file-system boundary, before the
      // seed module imports it. No container input-file channel is involved.
      const failed = spawnSync(process.execPath, ['-e', `
        require('node:fs/promises').unlink = async () => { throw new Error('simulated read-only mount'); };
        require(${JSON.stringify(resolve('dist/seed.js'))}).main(process.argv.slice(1));
      `, '--', `${flag}=${inputFile}`], {
        env: { ...env, PGLITE_DATA_DIR: failureData }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(failed.status, 1, failed.stdout + failed.stderr);
      assert.match(failed.stderr, /Delete it manually.*nothing was written/);
      assert.equal(await fs.readFile(inputFile, 'utf8'), content);
      assert.deepEqual(await fs.readdir(failureData), [], 'unlink failure must precede database opening');
    }
    await fs.writeFile(secretFile, 'throwaway-file-secret\n');
    await fs.writeFile(userFile, 'file.user\nfile@example.test\nthrowaway-password-789\n');
    const fileSeed = seed({ PGLITE_DATA_DIR: join(directory, 'file-seed') },
      [`--client-secret-file=${secretFile}`, `--local-user-file=${userFile}`]);
    assert.equal(fileSeed.status, 0, fileSeed.output);
    await assert.rejects(fs.stat(secretFile), { code: 'ENOENT' });
    await assert.rejects(fs.stat(userFile), { code: 'ENOENT' });
    console.log('PASS: both CLI unlink failures abort before database opening; first-run file bootstrap succeeds');

    const check = overrides => spawnSync(process.execPath, [resolve('scripts/startup-check.js')], {
      env: { ...env, ...overrides }, cwd: directory, encoding: 'utf8', timeout: 15000,
    });
    const checked = check({});
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const wrongKey = check({ DB_ENCRYPTION_KEY: 'd'.repeat(64) });
    assert.equal(wrongKey.status, 1);
    assert.match(wrongKey.stderr, /cannot be decrypted/);
    console.log('PASS: startup check accepts seeded data and rejects a wrong decryption key');


    if (process.platform !== 'win32') {
      const probe = require('node:net').createServer();
      await new Promise(res => probe.listen(0, '127.0.0.1', res));
      const port = probe.address().port;
      await new Promise(res => probe.close(res));
      const start = () => {
        const child = spawn(process.execPath, [resolve('dist/index.js')], {
          env: { ...env, PORT: String(port) }, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.add(child);
        child.output = '';
        child.stdout.on('data', b => { child.output += b; });
        child.stderr.on('data', b => { child.output += b; });
        child.done = once(child, 'exit').then(([status, signal]) => { children.delete(child); return { status, signal }; });
        return child;
      };
      const healthy = async child => {
        for (let attempt = 0; attempt < 100; attempt++) {
          assert.equal(child.exitCode, null, child.output);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 200) return;
          } catch {}
          await new Promise(res => setTimeout(res, 100));
        }
        assert.fail(`Service never became healthy: ${child.output}`);
      };
      const stable = await snapshot();
      let server = start();
      await healthy(server);
      const health = spawnSync(process.execPath, [resolve('scripts/container-healthcheck.js')], {
        env: { ...env, PORT: String(port) }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(health.status, 0, health.stderr);
      const competing = start();
      assert.equal((await competing.done).status, 1, competing.output);
      assert.match(competing.output, /Single-process error/);
      await stop(server, 'SIGKILL');
      server = start();
      await healthy(server);
      assert.match(server.output, /Recovered stale lock/);
      assert.equal((await stop(server, 'SIGTERM')).status, 0);
      await assert.rejects(fs.stat(join(data, '.btauthorchestrator.lock')), { code: 'ENOENT' });
      assert.equal(await snapshot(), stable);
      console.log('PASS: real HTTP healthcheck, concurrent server refusal, PGlite SIGKILL recovery/persistence and clean SIGTERM');

      // Run the documented offline verifier using only this scratch .env.
      await fs.writeFile(join(directory, '.env'), Object.entries({ ...env, PORT: String(port) })
        .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
      const offline = spawnSync(process.execPath, [resolve('scripts/verify-offline.js')], {
        cwd: directory, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000,
      });
      assert.equal(offline.status, 0, offline.stdout + offline.stderr);
      console.log(offline.stdout.trim());
      console.log('PASS: scripts/verify-offline.js with throwaway seeded data and scratch .env');
    }

  } finally {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map(c => c.done));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
