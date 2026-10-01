#!/usr/bin/env node
// Shared pre-start checks for start.sh and start.ps1. Run from the repository
// root with: node --env-file=.env scripts/startup-check.js

const { existsSync } = require('node:fs');
const { networkInterfaces } = require('node:os');
const { isIP } = require('node:net');

function printClientDnsHint(issuer) {
  console.log(`SERVICE_ISSUER=${issuer}`);
  try {
    const hostname = new URL(issuer).hostname;
    if (hostname === 'localhost' || isIP(hostname.replace(/^\[|\]$/g, ''))) {
      console.log('Client DNS hint: use a .biztechro.com hostname for shared-cookie browser testing.');
      return;
    }
    const addresses = [...new Set(Object.values(networkInterfaces()).flat()
      .filter(address => address && !address.internal && address.family === 'IPv4')
      .map(address => address.address))];
    if (addresses.length === 0) {
      console.log(`Client DNS hint: no external IPv4 detected; map ${hostname} to this server's reachable IP.`);
      return;
    }
    console.log('Make sure DNS or the hosts file on each CLIENT computer maps this hostname to this server.');
    console.log('Suggested hosts-file entry (choose the IP reachable from your clients if several are listed):');
    for (const address of addresses) console.log(`  ${address}  ${hostname}`);
    console.log('Windows 11 client: open PowerShell as Administrator, then run:');
    console.log('  notepad "$env:SystemRoot\\System32\\drivers\\etc\\hosts"');
    console.log('  Add one reachable IP/hostname entry shown above, or update its existing entry, then save.');
    console.log('  Run: ipconfig /flushdns');
    console.log('Debian 13 client: open a terminal, then run:');
    console.log('  sudo nano /etc/hosts');
    console.log('  Add one reachable IP/hostname entry shown above, or update its existing entry.');
    console.log('  Save with Ctrl+O, Enter; exit with Ctrl+X.');
    console.log(`On either client, reopen the browser and visit ${issuer}`);
    console.log('These are detected local addresses; client DNS has not been verified.');
  } catch {
    console.log('Client DNS hint unavailable: check the issuer URL and this server\'s network addresses.');
  }
}

async function check() {
  let loadConfig, prepareDataDirectory, openDatabase, createSecretsStore;
  try {
    for (const name of Object.keys(require('../package.json').dependencies)) {
      require.resolve(name);
    }
    ({ loadConfig } = require('../dist/config.js'));
    ({ prepareDataDirectory, openDatabase } = require('../dist/database.js'));
    ({ createSecretsStore } = require('../dist/secrets.js'));
    require('../dist/index.js');
  } catch {
    throw new Error('Dependencies or compiled files are missing/incompatible. Run npm ci and npm run build.');
  }
  const config = loadConfig(process.env);
  printClientDnsHint(config.issuer);
  if (!existsSync(config.pgliteDataDir)) {
    throw new Error('Database is missing. Run npm run seed as the service user before starting.');
  }
  await prepareDataDirectory(config.pgliteDataDir);
  const handle = await openDatabase(config.pgliteDataDir);
  try {
    const store = createSecretsStore(handle.database, config.dbEncryptionKey);
    try {
      await store.getCurrentSigningKey();
      if (!config.localLogin) await store.getSecret('CLIENT_SECRET');
    } catch {
      throw new Error('Required signing key or Entra secret is missing or cannot be decrypted. Check DB_ENCRYPTION_KEY; for incomplete bootstrap run npm run seed as the service user.');
    }
    if (config.localLogin) {
      const result = await handle.database.query('SELECT 1 FROM local_users WHERE is_active = true LIMIT 1');
      if (result.rows.length === 0) {
        throw new Error('Local login requires an active user. Run npm run seed for first-user setup, or enable an existing user using the admin API.');
      }
    }
  } finally {
    await handle.close();
  }
}

check().catch(error => {
  console.error(`Startup check failed: ${error.message}`);
  process.exitCode = 1;
});
