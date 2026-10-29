// Run after compilation, Node 22. CONTRACT-013 isolated ingress tests.
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const { mkdtemp, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createServer } = require('node:http');
const { connect } = require('node:net');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { loadConfig } = require('../dist/config.js');
const { withIngressAdmission, reportIngressMode, MAX_REFUSAL_PEERS } = require('../dist/ingress.js');
const { withRequestMonitoring } = require('../dist/logging.js');
const { createRequestHandler } = require('../dist/index.js');
const { createClientAddressResolver } = require('../dist/clientAddress.js');
const environment = {
  PORT: '3210', PGLITE_DATA_DIR: 'unused', DB_ENCRYPTION_KEY: 'a'.repeat(64),
  COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://orca.biztechro.com:3210',
  EMERGENCY_ROTATION_TOKEN: 'b'.repeat(32), LOCAL_USER_ADMIN_TOKEN: 'c'.repeat(32), LOCAL_LOGIN: 'true',
};
const config = overrides => loadConfig({ ...environment, ...overrides });
const proxy = config({ TRUSTED_PROXIES: '192.168.1.40,fd00::40' });
const body = 'Forbidden. This service only accepts requests through its configured proxy.\n';
const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' };
async function request(handler, peer, url = '/', method = 'GET', extra = {}) {
  const req = new Readable({ read() { throw new Error('Body must not be read'); } });
  Object.assign(req, { socket: { remoteAddress: peer }, url, method, headers: extra });
  let result;
  await handler(req, {
    writeHead(status, h) { result = { status, headers: h }; },
    end(value) { result.body = value; },
    on() { throw new Error('Monitoring must not run'); },
  });
  return result;
}
async function main() {
  for (const trusted of [undefined, '', '192.168.1.40']) {
    for (const raw of [undefined, '', '  ', 'true', 'TRUE', 'false', ' false ']) {
      if (!trusted && raw?.trim().toLowerCase() === 'true') {
        assert.throws(() => config({ TRUSTED_PROXIES: trusted, PROXY_ONLY: raw }), /Configuration error:.*PROXY_ONLY.*TRUSTED_PROXIES/);
      } else {
        const c = config({ TRUSTED_PROXIES: trusted, PROXY_ONLY: raw });
        assert.equal(c.proxyOnly, raw?.trim() ? raw.trim().toLowerCase() === 'true' : !!trusted);
        assert.equal(c.proxyOnlyExplicit, !!raw?.trim());
        const logs = [], warnings = [];
        reportIngressMode(c, line => logs.push(line), line => warnings.push(line));
        assert.equal(logs.length, 1);
        assert.ok(logs[0].includes(`Ingress mode: ${c.proxyOnly ? 'proxy-only' : trusted ? 'tunnel plus direct LAN' : 'local-only'}.`));
        assert.ok(logs[0].includes(c.proxyOnlyExplicit ? `set to ${c.proxyOnly}` : 'derived from TRUSTED_PROXIES'));
        assert.equal(warnings.length, c.proxyOnly ? 2 : 0);
      }
    }
  }
  for (const raw of ['1', 'yes', 'on']) {
    assert.throws(() => config({ PROXY_ONLY: raw }), /Configuration error:.*PROXY_ONLY.*true.*false/);
  }
  for (const overrides of [{ PROXY_ONLY: 'yes' }, { PROXY_ONLY: 'true' }, { TRUSTED_PROXIES: 'bad' }]) {
    const child = spawnSync(process.execPath, ['dist/index.js'], { env: { ...environment, ...overrides }, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Configuration error/);
    assert.doesNotMatch(child.stdout, /listening/);
  }
  console.log('PASS: mode matrix, explicit/derived mode lines, startup failures before listening');

  const gate = withIngressAdmission(() => { throw new Error('Handler ran'); }, proxy, { warn() {} });
  for (const peer of ['192.168.1.41', '2001:db8::1', '::ffff:192.168.1.41', undefined, '']) {
    for (const path of ['/health', '/admin/console', '/.well-known/jwks.json', '/unknown', '%%%']) {
      for (const method of ['GET', 'POST', 'HEAD']) assert.deepEqual(await request(gate, peer, path, method, { 'cf-connecting-ip': '192.168.1.40' }), { status: 403, headers, body });
    }
  }
  let calls = 0;
  const admitted = withIngressAdmission(() => { calls++; }, proxy, { warn() {} });
  for (const peer of ['127.0.0.1', '127.7.8.9', '::1', '::ffff:127.0.0.1']) {
    for (const method of ['GET', 'HEAD']) await request(admitted, peer, '/health', method);
    for (const path of ['/health?x=1', '/health/', '/admin/console', '/.well-known/jwks.json']) assert.equal((await request(admitted, peer, path)).status, 403);
    assert.equal((await request(admitted, peer, '/health', 'POST')).status, 403);
  }
  assert.equal(calls, 8);
  for (const peer of ['192.168.1.40', '::ffff:192.168.1.40', 'fd00::40']) {
    for (const path of ['/health', '/admin/console', '/.well-known/jwks.json', '/auth/local-login']) await request(admitted, peer, path);
  }
  assert.equal(calls, 20);
  for (const c of [config({}), config({ TRUSTED_PROXIES: '192.168.1.40', PROXY_ONLY: 'false' })]) {
    let count = 0;
    const open = withIngressAdmission(() => count++, c);
    for (const peer of [undefined, '127.0.0.1', '::1', '192.168.1.50', '2001:db8::1']) {
      for (const path of ['/health', '/health?x=1', '/admin/console', '/.well-known/jwks.json', '/auth/local-login']) await request(open, peer, path);
    }
    assert.equal(count, 25);
  }
  // The actual monitoring/route pipeline is unreachable, including all store
  // calls and the private login/password-change throttle state it owns.
  const unavailable = new Proxy({}, { get() { throw new Error('Store touched'); } });
  const real = withIngressAdmission(withRequestMonitoring(createRequestHandler(unavailable, proxy, unavailable)), proxy, { warn() {} });
  for (let i = 0; i < 25; i++) {
    for (const path of ['/auth/local-login', '/auth/local-change-password', '/admin/users', '/admin/emergency-rotate-keys']) {
      assert.equal((await request(real, '192.168.1.50', path, 'POST')).status, 403);
    }
  }
  console.log('PASS: admission matrix; exact refusal; no handler, body, store, audit, throttle or monitoring access');

  let time = 0;
  const lines = [];
  const limited = withIngressAdmission(() => {}, proxy, { now: () => time, warn: line => lines.push(line) });
  for (let i = 0; i < 20; i++) await request(limited, '192.168.2.1', '/test?secret=query', 'GET', { secret: 'header-secret' });
  assert.equal(lines.length, 1);
  time = 59999;
  await request(limited, '192.168.2.1');
  assert.equal(lines.length, 1);
  time++;
  await request(limited, '192.168.2.1');
  assert.match(lines[1], /suppressed=20/);
  await request(limited, '192.168.2.2', '/\n\r\t\u007f\u2028' + 'x'.repeat(10000) + '?secret=query');
  assert.equal(lines.length, 3);
  assert.match(lines[2], /\\n\\r\\t\\u007f\\u2028/);
  assert.match(lines[2], /truncated/);
  assert.ok(lines[2].length < 500);
  assert.doesNotMatch(lines.join(''), /secret|[\n\r\t\u2028]/);
  await request(limited, undefined);
  assert.match(lines[3], /peer=<no-peer>/);
  const flood = [];
  const bounded = withIngressAdmission(() => {}, proxy, { now: () => time, warn: line => flood.push(line) });
  for (let i = 0; i < MAX_REFUSAL_PEERS * 2; i++) await request(bounded, `10.0.${i >> 8}.${i & 255}`);
  assert.equal(flood.length, MAX_REFUSAL_PEERS);
  await request(bounded, '10.0.0.0');
  assert.equal(flood.length, MAX_REFUSAL_PEERS);
  time += 60000;
  await request(bounded, '11.0.0.1');
  assert.equal(flood.length, MAX_REFUSAL_PEERS + 1);
  // Saturation must recover even when every tracked peer has a pending count.
  const pendingLines = [];
  const pending = withIngressAdmission(() => {}, proxy, { now: () => time, warn: line => pendingLines.push(line) });
  for (let i = 0; i < MAX_REFUSAL_PEERS; i++) {
    const peer = `10.1.${i >> 8}.${i & 255}`;
    await request(pending, peer);
    await request(pending, peer);
  }
  await request(pending, '192.168.2.99');
  assert.equal(pendingLines.length, MAX_REFUSAL_PEERS);
  time += 60001;
  await request(pending, '192.168.2.99');
  assert.equal(pendingLines.length, MAX_REFUSAL_PEERS + 1);
  assert.match(pendingLines.at(-1), /peer=192\.168\.2\.99 .*suppressed=0/);
  console.log('PASS: refusal intervals, suppressed counts, escaping, truncation and bounded peer tracking');

  for (const header of ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop']) {
    for (const mode of ['local', 'direct', 'proxy']) {
      const c = config(mode === 'local' ? {} : { TRUSTED_PROXIES: '192.168.1.40', PROXY_ONLY: String(mode === 'proxy') });
      const warnings = [];
      time = 0;
      const warnGate = withIngressAdmission(() => {}, c, { now: () => time, warn: line => warnings.push(line) });
      const h = { [header]: header === 'cdn-loop' ? 'cloudflare; secret-value' : 'secret-value' };
      if (mode === 'direct') { await request(warnGate, '192.168.1.40', '/', 'GET', h); assert.equal(warnings.length, 0); }
      await request(warnGate, '192.168.1.50', '/', 'GET', h);
      if (mode === 'proxy') { assert.match(warnings[0], /refusal/); continue; }
      assert.match(warnings[0], mode === 'local' ? /missing TRUSTED_PROXIES.*proxy-only mode is off/ : /address may have changed.*TRUSTED_PROXIES/);
      assert.equal(createClientAddressResolver(c.trustedProxies)({ socket: { remoteAddress: '192.168.1.50' }, headers: h }), '192.168.1.50');
      await request(warnGate, '192.168.1.51', '/', 'GET', h);
      time = 599999;
      await request(warnGate, '192.168.1.52', '/', 'GET', h);
      assert.equal(warnings.length, 1);
      time++;
      await request(warnGate, '192.168.1.53', '/', 'GET', h);
      assert.equal(warnings.length, 2);
      assert.doesNotMatch(warnings.join(''), /secret-value/);
    }
  }
  const noWarning = withIngressAdmission(() => {}, config({}), { warn() { assert.fail('Unexpected warning'); } });
  await request(noWarning, '192.168.1.50', '/', 'GET', { 'cdn-loop': 'other', 'x-forwarded-for': 'secret' });
  for (const entry of ['192.168.1.0/24', 'fd00::/64', '192.168.1.40', '192.168.1.40/32', 'fd00::40/128']) {
    const warnings = [];
    reportIngressMode(config({ TRUSTED_PROXIES: entry, SERVICE_ISSUER: 'https://orca.biztechro.com', COOKIE_SECURE: 'true' }), () => {}, line => warnings.push(line));
    assert.equal(warnings.length, ['/24', '/64'].some(suffix => entry.endsWith(suffix)) ? 1 : 0);
    if (warnings.length) { assert.ok(warnings[0].includes(entry)); assert.match(warnings[0], /every host/); }
  }
  for (const [issuer, cookie, expected] of [
    ['http://orca.biztechro.com', 'true', 'SERVICE_ISSUER'],
    ['https://orca.biztechro.com', 'false', 'COOKIE_SECURE'],
  ]) {
    const warnings = [];
    reportIngressMode(config({ TRUSTED_PROXIES: '192.168.1.40', SERVICE_ISSUER: issuer, COOKIE_SECURE: cookie }), () => {}, line => warnings.push(line));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(expected));
  }
  console.log('PASS: missing-proxy/drift warnings, process-wide intervals, header privacy, range and Cloudflare-settings warnings');

  const server = createServer(withIngressAdmission(withRequestMonitoring(() => assert.fail('HTTP handler ran')), proxy, { warn() {} }));
  server.on('checkContinue', server.listeners('request')[0]);
  server.on('checkExpectation', server.listeners('request')[0]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const expectation of ['', 'Expect: 100-continue\r\n', 'Expect: other\r\n']) {
    const socket = connect(server.address().port, '127.0.0.1');
    socket.setTimeout(2000, () => socket.destroy(new Error('Refusal did not close promptly')));
    let wire = '';
    socket.on('data', chunk => { wire += chunk; });
    socket.write('POST /auth/local-login HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000000\r\n' + expectation + '\r\nx');
    await once(socket, 'close');
    assert.match(wire, /^HTTP\/1.1 403/);
    assert.match(wire, /Connection: close/i);
    assert.ok(wire.includes(body));
    assert.doesNotMatch(wire, /Set-Cookie|100 Continue/i);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: unfinished large POST receives prompt refusal and connection closure');

  for (const admitted of [false, true]) {
    let handled = 0;
    const listener = withIngressAdmission((req, res) => {
      handled++;
      res.writeHead(200, { Connection: 'close' });
      res.end('normal processing');
    }, admitted ? config({ TRUSTED_PROXIES: '127.0.0.1' }) : proxy, { warn() {} });
    const expectServer = createServer(listener);
    expectServer.on('checkContinue', listener);
    expectServer.on('checkExpectation', listener);
    await new Promise(resolve => expectServer.listen(0, '127.0.0.1', resolve));
    try {
      for (const version of ['1.0', '1.1']) {
        for (const expectation of ['100-continue', 'foo']) {
          const before = handled;
          const socket = connect(expectServer.address().port, '127.0.0.1');
          socket.setTimeout(2000, () => socket.destroy(new Error('Expect request did not close promptly')));
          let wire = '';
          socket.on('data', chunk => { wire += chunk; });
          socket.write(`GET / HTTP/${version}\r\nHost: localhost\r\nConnection: close\r\nExpect: ${expectation}\r\n\r\n`);
          await once(socket, 'close');
          const rejectedExpectation = admitted && version === '1.1' && expectation === 'foo';
          const status = !admitted ? 403 : rejectedExpectation ? 417 : 200;
          assert.match(wire, new RegExp(`HTTP/1\\.1 ${status}`));
          assert.equal(handled - before, admitted && !rejectedExpectation ? 1 : 0);
          if (admitted && version === '1.1' && expectation === '100-continue') {
            assert.match(wire, /^HTTP\/1\.1 100 Continue/);
          } else {
            assert.doesNotMatch(wire, /100 Continue/);
          }
          if (!rejectedExpectation) assert.doesNotMatch(wire, /417/);
          if (status === 200) assert.ok(wire.includes('normal processing'));
          if (status === 403) assert.ok(wire.includes(body));
        }
      }
    } finally { await new Promise(resolve => expectServer.close(resolve)); }
  }
  console.log('PASS: HTTP/1.0 ignores Expect; HTTP/1.1 preserves admission and expectation handling');

  // Real native process: startup reporting precedes listening, local-only routes.
  const directory = await mkdtemp(join(tmpdir(), 'bt-proxy-only-'));
  try {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    // Redirect only container filesystem boundaries; real container validation,
    // config, database, startup and HTTP pipeline still execute (no Docker needed).
    const mounted = join(directory, 'mount');
    await mkdir(mounted);
    const preload = join(directory, 'container-preload.cjs');
    await writeFile(preload, `
      const fs = require('node:fs/promises');
      const original = Object.fromEntries(['readFile', 'stat', 'mkdir', 'access'].map(k => [k, fs[k]]));
      const root = process.env.TEST_DATA;
      const map = p => p === '/data' ? root : p === '/data/pglite' ? root + '/pglite' : p;
      for (const k of ['stat', 'mkdir', 'access']) fs[k] = (p, ...args) => original[k](map(p), ...args);
      fs.readFile = (p, ...args) => p === '/proc/self/mountinfo'
        ? Promise.resolve('1 2 3:4 / /data rw - zfs tank/data rw') : original.readFile(p, ...args);
      const db = require(${JSON.stringify(resolve('dist/database.js'))});
      const open = db.openDatabase;
      db.openDatabase = p => open(map(p));
    `);
    for (const [container, overrides, mode] of [
      [false, {}, 'local-only'], [true, {}, 'local-only'],
      [false, { PROXY_ONLY: 'false' }, 'local-only'],
      [false, { TRUSTED_PROXIES: '127.0.0.1' }, 'proxy-only'],
      [false, { TRUSTED_PROXIES: '127.0.0.1', PROXY_ONLY: 'true' }, 'proxy-only'],
      [false, { TRUSTED_PROXIES: '127.0.0.1', PROXY_ONLY: 'false' }, 'tunnel plus direct LAN'],
      [false, { TRUSTED_PROXIES: '192.168.1.40' }, 'proxy-only'],
    ]) {
      const child = spawn(process.execPath, [...(container ? ['--require', preload] : []), 'dist/index.js'], {
        env: { ...environment, PORT: String(port), PGLITE_DATA_DIR: container ? '/data/pglite' : join(directory, 'native'),
          ...(container ? { BT_CONTAINER_MODE: '1', TEST_DATA: mounted } : {}), ...overrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = once(child, 'exit');
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      try {
        for (let i = 0; i < 200 && !output.includes('listening on port'); i++) {
          assert.equal(child.exitCode, null, output);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.match(output, /listening on port/);
        assert.ok(output.indexOf(`Ingress mode: ${mode}`) < output.indexOf('listening on port'));
        assert.ok(output.includes(`Ingress mode: ${mode}`));
        assert.ok(output.includes(`proxyOnly=${mode === 'proxy-only'}`));
        for (const path of ['/auth/local-login', '/.well-known/jwks.json', '/admin/console']) {
          const response = await fetch(`http://127.0.0.1:${port}${path}`);
          const refused = overrides.TRUSTED_PROXIES === '192.168.1.40';
          assert.equal(response.status, refused ? 403 : 200, path);
          if (refused) {
            assert.equal(await response.text(), body);
            assert.equal(response.headers.get('set-cookie'), null);
          }
        }
        if (overrides.TRUSTED_PROXIES === '192.168.1.40') {
          assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
          assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { method: 'HEAD' })).status, 404);
        }
      } finally { child.kill('SIGTERM'); await exited; }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  console.log('PASS: native and container local-only startup/routes (container filesystem redirected); production gate precedes monitoring');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
