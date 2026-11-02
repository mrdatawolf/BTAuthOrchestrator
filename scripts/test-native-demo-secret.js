// Run after npm run build. All databases, input files and fault hooks are temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { openDatabase, prepareDataDirectory } = require('../dist/database.js');
const { createSecretsStore } = require('../dist/secrets.js');
const { GENERATED_CLIENT_SECRET_PREFIX: prefix } = require('../dist/clientSecretPlaceholder.js');
const root = resolve(__dirname, '..');
let passed = 0;
function pass(label) { console.log(`PASS: ${label}`); passed++; }

async function main() {
  const scratch = await fs.mkdtemp(join(tmpdir(), 'bt-native-demo-'));
  const outputs = [];
  const placeholders = [];
  const env = {
    PATH: process.env.PATH, HOME: scratch, PORT: '32987', LOCAL_LOGIN: 'true',
    COOKIE_SECURE: 'false', SERVICE_ISSUER: 'http://localhost:32987',
    DB_ENCRYPTION_KEY: 'ab'.repeat(32), EMERGENCY_ROTATION_TOKEN: 'e'.repeat(32),
    LOCAL_USER_ADMIN_TOKEN: 'a'.repeat(32), TENANT_ID: 'test-tenant', CLIENT_ID: 'test-client',
  };
  const portProbe = require('node:net').createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  env.PORT = String(portProbe.address().port);
  env.SERVICE_ISSUER = 'http://localhost:' + env.PORT;
  await new Promise(resolve => portProbe.close(resolve));
  const hook = join(scratch, 'fault.cjs');
  const ptyDriver = join(scratch, 'drive-hidden-prompt.py');
  // Real TTY, fed only after the hidden prompt is ready. Payload is pipe input,
  // never a command argument, shell command or persistent file.
  await fs.writeFile(ptyDriver, `import os,pty,subprocess,sys,json,select,time\np=json.load(sys.stdin)\nm,s=pty.openpty()\nc=subprocess.Popen(p['command'],stdin=s,stdout=s,stderr=s,env=p['env'],cwd=p['cwd'])\nos.close(s)\nout=b''; sent=False; deadline=time.time()+40\nwhile time.time()<deadline:\n if select.select([m],[],[],0.1)[0]:\n  try: chunk=os.read(m,65536)\n  except OSError: break\n  if not chunk: break\n  out+=chunk\n  if not sent and b'CLIENT_SECRET: ' in out:\n   ps=subprocess.check_output(['ps','-eo','args']).decode()\n   assert not p['input'].strip() or p['input'].strip() not in ps\n   os.write(m,p['input'].encode()); sent=True\n if c.poll() is not None: break\nif c.poll() is None:\n try: c.wait(timeout=5)\n except subprocess.TimeoutExpired: c.kill(); c.wait()\nos.close(m)\nsys.stdout.buffer.write(out)\nsys.exit(c.returncode if c.returncode>=0 else 1)\n`);
  await fs.writeFile(hook, `
const path = require('node:path');
const root = process.env.TEST_ROOT;
if (process.env.TEST_FAULT === 'random') require('node:crypto').randomBytes = () => { throw new Error('injected CSPRNG failure'); };
if (process.env.TEST_FAULT === 'unlink') require('node:fs/promises').unlink = async () => { throw new Error('injected unlink failure'); };
// Keep container configuration/storage checks real elsewhere (existing suite).
// Redirect just their boundary here so the placeholder policy uses scratch data.
if (process.env.TEST_CONTAINER) {
 const c = require(path.join(root,'dist/container.js'));
 c.validateContainerIdentity = () => {};
 c.checkContainerStorage = async () => {};
}
const secrets = require(path.join(root,'dist/secrets.js'));
const original = secrets.createSecretsStore;
secrets.createSecretsStore = (...args) => {
 const store = original(...args);
 for (const [method, before, after] of [['setSecret','before-secret','after-secret'],['insertSigningKey','before-key','after-key']]) {
  const write = store[method];
  store[method] = async (...values) => {
   if (method === 'setSecret' && process.env.TEST_PS) {
    const ps = require('node:child_process').execFileSync('ps',['-eo','args'],{encoding:'utf8'});
    if (ps.includes(values[1])) throw new Error('Process-list leakage detected');
    console.log('Process-list check passed.');
   }
   if (process.env.TEST_FAULT === before) process.kill(process.pid,'SIGKILL');
   await write(...values);
   if (process.env.TEST_FAULT === after) process.kill(process.pid,'SIGKILL');
  };
 }
 return store;
};
`);
  let data;
  async function fresh(name) {
    data = join(scratch, name);
    await prepareDataDirectory(data);
    const h = await openDatabase(data); await h.close();
    await fs.writeFile(join(scratch, '.env'), '');
  }
  function run(args = [], extra = {}, input, entry = 'scripts/seed.js') {
    const childEnv = { ...env, PGLITE_DATA_DIR: data, TEST_ROOT: root, ...extra };
    if (extra.TEST_FAULT || extra.TEST_CONTAINER || extra.TEST_PS) childEnv.NODE_OPTIONS = `--require=${hook}`;
    const command = [process.execPath, join(root, entry), ...args];
    const result = input === undefined
      ? spawnSync(command[0], command.slice(1), { cwd: scratch, env: childEnv, encoding: 'utf8', timeout: 45000 })
      : spawnSync('python3', [ptyDriver], { input: JSON.stringify({command, env: childEnv, cwd: scratch, input}), encoding: 'utf8', timeout: 50000 });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    outputs.push(output);
    return { status: result.status, output };
  }
  async function db(fn) { const h = await openDatabase(data); try { return await fn(h.database, createSecretsStore(h.database, env.DB_ENCRYPTION_KEY)); } finally { await h.close(); } }
  async function snapshot() { return db(async d => {
    const result = {};
    for (const table of ['secrets','signing_keys','local_users']) result[table] = (await d.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    return result;
  }); }
  async function userFile() { const p = join(scratch,'user-input'); await fs.writeFile(p,'demo\ndemo@example.com\nlong-demo-password\n'); return `--local-user-file=${p}`; }
  async function secretFile(value) { const p = join(scratch,'secret-input'); await fs.writeFile(p,value); return `--client-secret-file=${p}`; }
  async function absent(p) { await assert.rejects(fs.stat(p), { code: 'ENOENT' }); }
  async function refusal(label, args, extra = {}, input, pattern) {
    const before = await snapshot(); const result = run(args,extra,input);
    assert.notEqual(result.status,0,label);
    if (pattern) assert.match(result.output,pattern);
    assert.deepEqual(await snapshot(),before,label);
    pass(label);
    return result;
  }
  async function remember() {
    const value = await db((d,s) => s.getSecret('CLIENT_SECRET'));
    assert.ok(value.startsWith(prefix));
    const suffix = value.slice(prefix.length);
    assert.match(suffix,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(suffix,'base64url').length,32);
    placeholders.push(value); return value;
  }
  let service;
  try {
    await fresh('interactive');
    let r = run([await userFile()], {}, '  \r');
    assert.equal(r.status,0,r.output); assert.match(r.output,/Press Enter.*replace later/);
    await remember(); pass('real hidden TTY whitespace entry generates; explanation and full bootstrap');
    await refusal('fully seeded second run refuses unchanged', ['--generate-client-secret'], {}, undefined, /already seeded/);
    const first = await snapshot();
    assert.equal(first.secrets.length,1); assert.equal(first.signing_keys.length,1); assert.equal(first.local_users.length,1);
    assert.notDeepEqual(first.secrets[0].iv,first.signing_keys[0].private_key_iv);
    await db(async (d,s) => {
      await assert.rejects(createSecretsStore(d,'cd'.repeat(32)).getSecret('CLIENT_SECRET'));
      const row = first.secrets[0];
      assert.throws(() => s.decryptValue({ciphertext:Buffer.from(row.ciphertext),iv:Buffer.from(row.iv),authTag:Buffer.from(row.auth_tag)},'OTHER'));
    }); pass('encrypted rows use fresh IVs; wrong encryption key and wrong AAD fail');
    const mode = await fs.stat(data); assert.equal(mode.mode & 0o777,0o700); assert.equal(mode.uid,process.getuid());
    await fs.chmod(data,0o755); r=run(['--generate-client-secret']); assert.notEqual(r.status,0); assert.match(r.output,/0700/); await fs.chmod(data,0o700);
    pass('directory ownership/mode and permission refusal');

    // Actual service: refusal before listen, then one informational line in local mode.
    r=run([], {LOCAL_LOGIN:'false'},undefined,'scripts/startup-check.js'); assert.notEqual(r.status,0); assert.match(r.output,/service stopped.*node scripts\/seed.js --replace-client-secret/);
    r=run([], {LOCAL_LOGIN:'false'},undefined,'dist/index.js'); assert.notEqual(r.status,0); assert.doesNotMatch(r.output,/listening on port/);
    r=run([], {LOCAL_LOGIN:'false',BT_CONTAINER_MODE:'1',TEST_CONTAINER:'1'},undefined,'scripts/startup-check.js');
    assert.notEqual(r.status,0); assert.match(r.output,/native demo install.*new, empty \/data volume/); assert.doesNotMatch(r.output,/node scripts\/seed|\.env/);
    pass('native and container Entra startup reject placeholders before listening');
    async function start(extra = {}) {
      service=spawn(process.execPath,[join(root,'dist/index.js')],{cwd:scratch,env:{...env,PGLITE_DATA_DIR:data,...extra},stdio:['ignore','pipe','pipe']});
      service.output=''; service.stdout.on('data', b=>service.output+=b); service.stderr.on('data',b=>service.output+=b);
      service.done=once(service,'exit');
      for(let i=0;i<200 && !service.output.includes('listening on port');i++) {
        if(service.exitCode!==null) throw new Error(service.output);
        await new Promise(r=>setTimeout(r,50));
      }
      assert.match(service.output,/listening on port/);
      const response=await fetch('http://localhost:'+env.PORT+'/health'); assert.equal(response.status,200);
    }
    async function stop() { service.kill('SIGTERM'); await service.done; outputs.push(service.output); service=undefined; }
    r=run([],{},undefined,'scripts/startup-check.js'); assert.equal(r.status,0,r.output);
    await start(); assert.equal((service.output.match(/CLIENT_SECRET is a generated placeholder/g)||[]).length,1);
    const beforeLock=first;
    r=run(['--replace-client-secret']); assert.notEqual(r.status,0); assert.match(r.output,/another instance|already.*running|second instance/i);
    await stop(); assert.deepEqual(await snapshot(),beforeLock);
    pass('local startup healthy with exactly one info line; replacement while running fails unchanged');

    for (const local of ['true','false']) {
      for(const value of ['',prefix+'reserved']) {
        await refusal(`replacement prompt ${local} rejects empty/reserved ${value ? 'reserved':'empty'}`,['--replace-client-secret'],{LOCAL_LOGIN:local},value+'\r');
        await refusal(`replacement file ${local} rejects ${value ? 'reserved':'empty'}`,['--replace-client-secret',await secretFile(value)],{LOCAL_LOGIN:local});
        await absent(join(scratch,'secret-input'));
      }
    }
    await refusal('replacement unlink failure aborts unchanged',['--replace-client-secret',await secretFile('real-secret')],{TEST_FAULT:'unlink'},undefined,/Delete it manually/);
    await fs.unlink(join(scratch,'secret-input'));
    await refusal('replacement interrupted before row write keeps placeholder',['--replace-client-secret',await secretFile('replacement-before')],{TEST_FAULT:'before-secret'});
    const beforeReplace=await snapshot();
    r=run(['--replace-client-secret'],{LOCAL_LOGIN:'false'},'real-operator-tty-secret\r');
    assert.equal(r.status,0,r.output);
    let after=await snapshot(); assert.deepEqual(after.signing_keys,beforeReplace.signing_keys); assert.deepEqual(after.local_users,beforeReplace.local_users);
    assert.ok(after.secrets[0].updated_at > beforeReplace.secrets[0].updated_at);
    assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'real-operator-tty-secret');
    r=run([],{LOCAL_LOGIN:'false'},undefined,'scripts/startup-check.js'); assert.equal(r.status,0,r.output);
    await start({LOCAL_LOGIN:'false'}); await stop();
    pass('TTY replacement in Entra mode changes only secret, advances timestamp; Entra starts');
    await refusal('replacement cannot rotate operator secret',['--replace-client-secret'],{},undefined,/Only a generated placeholder/);

    await fresh('flag');
    r=run(['--generate-client-secret',await userFile()]); assert.equal(r.status,0,r.output);
    const second=await remember(); assert.notEqual(second,placeholders[0]); pass('no-TTY flag bootstrap; independent 256-bit base64url generations differ');
    const beforeFile=await snapshot();
    r=run(['--replace-client-secret',await secretFile('real-file-secret\r\n')]); assert.equal(r.status,0,r.output); await absent(join(scratch,'secret-input'));
    after=await snapshot(); assert.deepEqual(after.signing_keys,beforeFile.signing_keys); assert.deepEqual(after.local_users,beforeFile.local_users); assert.ok(after.secrets[0].updated_at>beforeFile.secrets[0].updated_at);
    assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'real-file-secret'); pass('file replacement strips one newline, deletes input, changes only secret and timestamp');
    // Missing and undecryptable values remain permitted in native local startup.
    await db(d=>d.query("UPDATE secrets SET auth_tag = decode('00000000000000000000000000000000','hex')"));
    r=run([],{},undefined,'scripts/startup-check.js'); assert.equal(r.status,0,r.output); await start(); await stop();
    await db(d=>d.query('DELETE FROM secrets'));
    r=run([],{},undefined,'scripts/startup-check.js'); assert.equal(r.status,0,r.output); await start(); await stop();
    pass('native local startup still works with missing and undecryptable CLIENT_SECRET');
    await refusal('replacement refuses missing secret',['--replace-client-secret'],{},undefined,/normal seed/);
    for (const local of ['true','false']) {
      for (const value of ['', ' \n',prefix+'operator']) {
        await refusal(`normal file ${local} refuses ${value.startsWith(prefix)?'reserved':'empty '+value.length}`, [await secretFile(value)],{LOCAL_LOGIN:local});
        await absent(join(scratch,'secret-input'));
      }
      await refusal(`normal prompt ${local} refuses reserved`,[],{LOCAL_LOGIN:local},prefix+'operator\r');
    }
    await refusal('hidden prompt cancellation leaves all rows unchanged',[],{},'\x03',/cancelled/);
    await refusal('Entra empty prompt asks for secret',[],{LOCAL_LOGIN:'false'},' \r',/Supply the Entra client secret/);
    await refusal('generation disabled in Entra',['--generate-client-secret'],{LOCAL_LOGIN:'false'},undefined,/only for LOCAL_LOGIN=true/);
    const conflictFile=await secretFile('untouched');
    await refusal('generate/file conflict preserves file',['--generate-client-secret',conflictFile]);
    assert.equal(await fs.readFile(join(scratch,'secret-input'),'utf8'),'untouched'); await fs.unlink(join(scratch,'secret-input'));
    await refusal('generate/replace conflict',['--generate-client-secret','--replace-client-secret']);
    const unreadUserFile=await userFile();
    await refusal('replace/local-user-file conflict preserves file',['--replace-client-secret',unreadUserFile]);
    await fs.stat(join(scratch,'user-input')); await fs.unlink(join(scratch,'user-input'));
    for(const flag of ['--generate-client-secret','--replace-client-secret']) {
      await refusal(`${flag} refused non-interactively`,[flag,'--non-interactive']);
      await refusal(`${flag} refused in container`,[flag],{BT_CONTAINER_MODE:'1'});
      await refusal(`${flag} refused container non-interactively`,[flag,'--non-interactive'],{BT_CONTAINER_MODE:'1'});
    }
    await refusal('CSPRNG failure aborts unchanged',['--generate-client-secret'],{TEST_FAULT:'random'},undefined,/Secure random generation failed/);
    await refusal('generation interrupted before storing has no row',['--generate-client-secret'],{TEST_FAULT:'before-secret'});
    await refusal('normal file unlink failure aborts unchanged',[await secretFile('operator-unlink')],{TEST_FAULT:'unlink'},undefined,/Delete it manually/);
    await fs.unlink(join(scratch,'secret-input'));
    await refusal('command line secret rejected without echo',['--client-secret=never-echo-this']); assert.ok(!outputs.at(-1).includes('never-echo-this'));
    r=run([],{},'normal-operator-tty-secret\r'); assert.equal(r.status,0,r.output); assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'normal-operator-tty-secret');
    pass('native local non-empty TTY entry stores operator value');
    // A stored secret makes generation a no-op while a missing key is completed.
    await db(d=>d.query('DELETE FROM signing_keys'));
    const oldSecret=(await snapshot()).secrets;
    r=run(['--generate-client-secret']); assert.equal(r.status,0,r.output); assert.match(r.output,/CLIENT_SECRET already stored/); assert.deepEqual((await snapshot()).secrets,oldSecret);
    pass('generate flag leaves existing operator value untouched during partial bootstrap');

    await fresh('operator-file');
    r=run([await secretFile('operator-file-value\n'),await userFile()],{TEST_PS:'1'}); assert.equal(r.status,0,r.output); await absent(join(scratch,'secret-input')); assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'operator-file-value');
    assert.match(r.output,/Process-list check passed/); pass('normal native local file stores operator value, unlinks, and keeps plaintext out of ps');
    await fresh('interrupted-key');
    r=run(['--generate-client-secret',await userFile()],{TEST_FAULT:'before-key'}); assert.notEqual(r.status,0);
    after=await snapshot(); assert.equal(after.signing_keys.length,0); assert.equal(after.secrets.length,1); await remember();
    r=run(['--generate-client-secret',await userFile()]); assert.equal(r.status,0,r.output); assert.deepEqual((await snapshot()).secrets,after.secrets);
    pass('SIGKILL between key generation/storage leaves no partial key; next seed completes');
    const beforeCrashReplace=await snapshot();
    r=run(['--replace-client-secret',await secretFile('committed-before-kill')],{TEST_FAULT:'after-secret'}); assert.notEqual(r.status,0);
    after=await snapshot(); assert.deepEqual(after.signing_keys,beforeCrashReplace.signing_keys); assert.deepEqual(after.local_users,beforeCrashReplace.local_users); assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'committed-before-kill');
    pass('replacement SIGKILL after commit leaves complete unmarked row');

    await fresh('container');
    const container={BT_CONTAINER_MODE:'1',TEST_CONTAINER:'1',INITIAL_LOCAL_USER_USERNAME:'demo',INITIAL_LOCAL_USER_EMAIL:'demo@example.com',INITIAL_LOCAL_USER_PASSWORD:'long-demo-password'};
    await refusal('container local demo missing CLIENT_SECRET still fails',['--non-interactive'],container,undefined,/Missing seed input\(s\): CLIENT_SECRET/);
    r=run(['--non-interactive'],{...container,CLIENT_SECRET:'container-operator-secret'}); assert.equal(r.status,0,r.output); assert.equal(await db((d,s)=>s.getSecret('CLIENT_SECRET')),'container-operator-secret');
    pass('container non-interactive stores supplied operator value');

    // Decrypt above, then scan every file created, including PGlite/WAL and
    // harness artifacts. Neither whole plaintext nor its random suffix may leak.
    const combined=outputs.join('\n');
    for(const value of placeholders) { assert.ok(!combined.includes(value)); assert.ok(!combined.includes(value.slice(prefix.length))); }
    async function scan(dir) { for(const entry of await fs.readdir(dir,{withFileTypes:true})) { const p=join(dir,entry.name); if(entry.isDirectory()) await scan(p); else if(entry.isFile()) { const contents=await fs.readFile(p); for(const value of placeholders) { assert.ok(!contents.includes(Buffer.from(value)),`plaintext leak in ${entry.name}`); assert.ok(!contents.includes(Buffer.from(value.slice(prefix.length))),`random suffix leak in ${entry.name}`); } } } }
    await scan(scratch);
    for(const secret of ['real-operator-tty-secret','normal-operator-tty-secret','operator-file-value','real-file-secret']) assert.ok(!combined.includes(secret));
    // No shell was invoked by either path; inspect any history files created in
    // the isolated HOME too, rather than touching the operator's real history.
    for(const filename of ['.bash_history','.zsh_history']) {
      const history=await fs.readFile(join(scratch,filename),'utf8').catch(e=> {if(e.code==='ENOENT') return ''; throw e;});
      for(const secret of ['normal-operator-tty-secret','operator-file-value',...placeholders]) assert.ok(!history.includes(secret));
    }
    pass('decrypted placeholders and random suffixes absent from all captured output and every written file; operator output/history clean');
    console.log(`${passed} passed; 0 failed`);
  } finally {
    if(service) { service.kill('SIGKILL'); await service.done; }
    await fs.rm(scratch,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);console.error(`${passed} passed; 1 failed`);process.exitCode=1;});
