import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-port-'));
process.env.CODEX_SHIM_PORT_REGISTRY = path.join(root, 'registry.json');
const { choosePort, configuredPort, syncLoopbackProfile } = await import('./bin/dsv4shim-port-manager.mjs');

const sibling = path.join(root, 'sibling');
const configDir = path.join(root, 'dsv4shim-config');
const dataDir = path.join(root, 'dsv4shim-data');
fs.mkdirSync(sibling, { recursive: true });
fs.writeFileSync(path.join(sibling, 'config.json'), JSON.stringify({ name: 'novacore', port: 45010 }));

const first = await choosePort({ app: 'dsv4shim-test', configDir, dataDir, configPort: 45010, scanRoots: [root] });
assert.equal(first.preferredPort, 45010);
assert.equal(first.port, 45011, 'an installed sibling config reserves the preferred port');
assert.equal(configuredPort({ envVar: 'DSV4SHIM_TEST_PORT', app: 'dsv4shim-test', dataDir, configPort: 45010 }), 45011);

const settingsPath = path.join(root, 'profile', 'settings.json');
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:45010',
  ANTHROPIC_AUTH_TOKEN: 'sentinel',
} }));
assert.equal(syncLoopbackProfile(settingsPath, first.port), true);
assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45011');
assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'sentinel');

const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(45011, '127.0.0.1', resolve); });
try {
  const second = await choosePort({ app: 'dsv4shim-test', configDir, dataDir, configPort: 45010, scanRoots: [root] });
  assert.equal(second.port, 45012, 'a live listener advances to the next free port');
} finally {
  await new Promise(resolve => listener.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

// dsv4shim-usage must find the shim on the port it actually bound (active-port.json), not just
// cfg.port/8788. Before the fix it printed "shim not running" whenever the shim had shifted ports.
{
  const http = await import('node:http');
  const { execFile } = await import('node:child_process');
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const uroot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-usage-port-'));
  const ucfg = path.join(uroot, 'config'), udata = path.join(uroot, 'data');
  fs.mkdirSync(ucfg, { recursive: true }); fs.mkdirSync(udata, { recursive: true });
  const defaults = JSON.parse(fs.readFileSync(path.join(here, 'config.default.json'), 'utf8'));
  fs.writeFileSync(path.join(ucfg, 'config.json'), JSON.stringify({ ...defaults, port: 8788 }));
  fs.writeFileSync(path.join(ucfg, 'sentinel'), 'usage-test-sentinel\n');
  let sawAuth = '';
  const fake = http.createServer((req, res) => {
    sawAuth = req.headers.authorization || '';
    if (req.url !== '/_dsv4shim/usage') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ todayUsd: 0.25, capUsd: 10, burn: { tokensPerMin: 0, usdPerHour: 0 } }));
  });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(0, '127.0.0.1', resolve); });
  const shiftedPort = fake.address().port;
  fs.writeFileSync(path.join(udata, 'active-port.json'), JSON.stringify({ app: 'dsv4shim', port: shiftedPort, preferredPort: 8788 }));
  try {
    const env = { ...process.env, DSV4SHIM_CONFIG_DIR: ucfg, DSV4SHIM_DATA_DIR: udata };
    delete env.DSV4SHIM_PORT;
    const out = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(here, 'bin', 'dsv4shim-usage')],
      { env, timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    assert.ok(!out.includes('shim not running'), `usage report missed the shifted shim on ${shiftedPort}:\n${out}`);
    assert.match(out, /today\s+: \$0\.25/, 'live panel comes from the shim on the active port');
    assert.equal(sawAuth, 'Bearer usage-test-sentinel', 'usage request carries the local sentinel');
  } finally {
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(uroot, { recursive: true, force: true });
  }
}

console.log('port manager: 3 passed, 0 failed');
