import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTailnetHost, proxyFetch, haFetch, startTailnet, tailnetStatus, routesViaTailnet } from '../server/tailnet.js';
import { HAClient } from '../server/ha.js';

const listen = (server, t) => new Promise(ok => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); ok(server.address().port); }));

// A tiny CONNECT proxy like Tailscale's: tunnels to 127.0.0.1 whatever the requested name, refuses "nowhere".
async function fakeProxy(t, seen = []) {
  const proxy = createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, client, head) => {
    seen.push(req.url);
    const [name, port] = [req.url.slice(0, req.url.lastIndexOf(':')), req.url.slice(req.url.lastIndexOf(':') + 1)];
    if (name.startsWith('nowhere')) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\nno route to host'); return; }
    const up = connect(Number(port), '127.0.0.1', () => { client.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  return listen(proxy, t);
}

// A stand-in for Home Assistant's API.
async function fakeHA(t, log = []) {
  const ha = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      log.push({ method: req.method, url: req.url, auth: req.headers.authorization, host: req.headers.host, body: b });
      if (req.url === '/slow') return;
      if (req.url === '/api/denied') { res.writeHead(401); return res.end('401: Unauthorized'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  return listen(ha, t);
}

test('tailnet addresses: *.ts.net, 100.64.0.0/10, Tailscale IPv6 and short MagicDNS names', () => {
  for (const h of ['homeassistant.tail1ebd8f.ts.net', 'HOMEASSISTANT.TAIL1EBD8F.TS.NET', '100.64.0.1', '100.101.102.103', '100.127.255.254', '[fd7a:115c:a1e0::1]', 'homeassistant'])
    assert.equal(isTailnetHost(h), true, h);
  for (const h of ['home.example.com', 'ts.net.example.com', '100.63.0.1', '100.128.0.1', '192.168.4.141', 'localhost', '127.0.0.1', '::1', ''])
    assert.equal(isTailnetHost(h), false, h);
});

test('proxyFetch: requests go through the CONNECT proxy with headers, body and status intact', async t => {
  const seen = [], log = [];
  const proxyPort = await fakeProxy(t, seen), haPort = await fakeHA(t, log);
  const proxy = { host: '127.0.0.1', port: proxyPort };
  const url = `http://homeassistant.tail1ebd8f.ts.net:${haPort}`;
  const r = await proxyFetch(proxy, `${url}/api/states?x=1`, { headers: { authorization: 'Bearer abc' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, path: '/api/states?x=1' });
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual(seen, [`homeassistant.tail1ebd8f.ts.net:${haPort}`], 'the proxy is asked for the tailnet name, which Tailscale resolves');
  assert.equal(log[0].auth, 'Bearer abc');
  assert.equal(log[0].host, `homeassistant.tail1ebd8f.ts.net:${haPort}`);

  const post = await proxyFetch(proxy, `${url}/api/services/lock/lock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entity_id: 'lock.front' }) });
  assert.equal(post.status, 200);
  assert.deepEqual(log[1], { method: 'POST', url: '/api/services/lock/lock', auth: undefined, host: `homeassistant.tail1ebd8f.ts.net:${haPort}`, body: '{"entity_id":"lock.front"}' });
  assert.equal((await proxyFetch(proxy, `${url}/api/denied`)).status, 401, 'error statuses come back as responses, like fetch');

  await assert.rejects(proxyFetch(proxy, `http://nowhere.tail1ebd8f.ts.net:${haPort}/`), /Tailscale couldn't reach nowhere\.tail1ebd8f\.ts\.net.*no route to host/);
  await assert.rejects(proxyFetch({ host: '127.0.0.1', port: 1 }, `${url}/`), /Tailscale's proxy isn't answering \(ECONNREFUSED\)/);
  await assert.rejects(proxyFetch(proxy, `${url}/slow`, { signal: AbortSignal.timeout(150) }), e => e.name === 'TimeoutError');
});

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('proxyFetch: https through the tunnel checks the certificate against the name', { skip: !hasOpenssl && 'openssl not installed' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=homeassistant.tail1ebd8f.ts.net',
    '-addext', 'subjectAltName=DNS:homeassistant.tail1ebd8f.ts.net', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const cert = readFileSync(join(dir, 'cert.pem')), key = readFileSync(join(dir, 'key.pem'));
  const ha = createTlsServer({ cert, key }, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"secure":true}'); });
  const haPort = await listen(ha, t);
  const proxy = { host: '127.0.0.1', port: await fakeProxy(t) };
  const r = await proxyFetch(proxy, `https://homeassistant.tail1ebd8f.ts.net:${haPort}/api/`, { ca: cert });
  assert.deepEqual(await r.json(), { secure: true });
  await assert.rejects(proxyFetch(proxy, `https://homeassistant.tail1ebd8f.ts.net:${haPort}/api/`), /SELF_SIGNED|self[- ]signed|unable to verify/i, 'an untrusted certificate is refused');
  await assert.rejects(proxyFetch(proxy, `https://other.tail1ebd8f.ts.net:${haPort}/api/`, { ca: cert }), /altnames|does not match|ERR_TLS_CERT_ALTNAME_INVALID/i, 'the name must match');
});

test('a Tailscale address without Tailscale explains what to do', async () => {
  const notFound = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
  await assert.rejects(new HAClient('https://homeassistant.tail1ebd8f.ts.net', 'x', notFound).config(),
    /Couldn't find homeassistant\.tail1ebd8f\.ts\.net: that's a Tailscale address.*TS_AUTHKEY.*Funnel/);
  await assert.rejects(new HAClient('https://home.example.com', 'x', notFound).config(), /Couldn't reach Home Assistant at https:\/\/home\.example\.com \(ENOTFOUND\)/);
  assert.equal(routesViaTailnet('https://homeassistant.tail1ebd8f.ts.net'), false, 'off without TS_AUTHKEY');
});

// Fakes for the daemon and the tailscale command.
function fakeTailscale({ statuses, upFails } = {}) {
  const calls = [], children = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => child.emit('exit', null);
    children.push({ cmd, args, child });
    return child;
  };
  let i = 0;
  const cli = async args => {
    const keyFile = args.find(a => a.startsWith('--auth-key=file:'))?.slice('--auth-key=file:'.length);
    calls.push({ args, key: keyFile && readFileSync(keyFile, 'utf8'), keyFile });
    if (args[0] === 'up') { if (upFails) throw new Error(upFails); return ''; }
    return JSON.stringify(statuses[Math.min(i++, statuses.length - 1)]);
  };
  return { spawn, cli, calls, children };
}
const running = { BackendState: 'Running', Self: { DNSName: 'str-dashboard.tail1ebd8f.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::9', '100.90.1.2'] }, CurrentTailnet: { Name: 'beau@example.com' }, Health: [] };

test('Tailscale: starts in userspace mode, signs in once with the key from a temporary file, then routes tailnet requests', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tailnet-'));
  const fake = fakeTailscale({ statuses: [{ BackendState: 'NeedsLogin' }, running] });
  const log = [];
  const proxyPort = await fakeProxy(t), haPort = await fakeHA(t, log);
  assert.equal(startTailnet({ authKey: '', dataDir }), null, 'nothing runs without TS_AUTHKEY');
  const ctl = startTailnet({ authKey: 'tskey-auth-test123', hostname: 'str-dashboard', dataDir, proxyPort, socket: '/tmp/x.sock', spawn: fake.spawn, cli: fake.cli, checkEvery: 60000, restartAfter: 10 });
  t.after(() => ctl?.stop());
  assert.equal(startTailnet({ authKey: 'tskey-again', dataDir }), ctl, 'only one Tailscale');

  const [{ cmd, args }] = fake.children;
  assert.equal(cmd, '/usr/local/bin/tailscaled');
  assert.deepEqual(args, ['--tun=userspace-networking', `--statedir=${join(dataDir, 'tailscale')}`, '--socket=/tmp/x.sock', `--outbound-http-proxy-listen=127.0.0.1:${proxyPort}`]);
  assert.equal(tailnetStatus().state, 'starting');
  await assert.rejects(haFetch(`http://homeassistant.tail1ebd8f.ts.net:${haPort}/api/`), /Tailscale isn't connected yet: starting/);

  await ctl.check();
  const up = fake.calls.find(c => c.args[0] === 'up');
  assert.deepEqual(up.args.slice(0, 3), ['up', '--hostname=str-dashboard', '--timeout=60s']);
  assert.equal(up.key, 'tskey-auth-test123', 'the key is handed over in a file');
  assert.ok(!up.args.join(' ').includes('tskey-auth-test123'), 'never on the command line');
  assert.ok(!existsSync(up.keyFile), 'and the file is gone afterwards');
  const s = tailnetStatus();
  assert.deepEqual([s.enabled, s.state, s.name, s.ip, s.tailnet, s.error], [true, 'Running', 'str-dashboard.tail1ebd8f.ts.net', '100.90.1.2', 'beau@example.com', null]);

  // Tailnet addresses now go through Tailscale; others still go direct.
  assert.equal(routesViaTailnet('https://homeassistant.tail1ebd8f.ts.net'), true);
  const r = await new HAClient(`http://homeassistant.tail1ebd8f.ts.net:${haPort}`, 'tok').config();
  assert.deepEqual(r, { ok: true, path: '/api/config' });
  assert.equal(log.at(-1).host, `homeassistant.tail1ebd8f.ts.net:${haPort}`);
  assert.deepEqual(await new HAClient(`http://127.0.0.1:${haPort}`, 'tok').config(), { ok: true, path: '/api/config' }, 'a non-tailnet address is fetched directly');

  // Already signed in: later checks don't sign in again.
  await ctl.check();
  assert.equal(fake.calls.filter(c => c.args[0] === 'up').length, 1);

  // If the daemon dies it's restarted, and the page says so meanwhile.
  fake.children[0].child.stderr.emit('data', '2026/10/13 05:00:00 magicsock: fatal thing happened\n');
  fake.children[0].child.emit('exit', 1);
  assert.equal(tailnetStatus().state, 'off');
  assert.match(tailnetStatus().error, /Tailscale stopped \(magicsock: fatal thing happened\); restarting/);
  await new Promise(ok => setTimeout(ok, 30));
  assert.equal(fake.children.length, 2, 'restarted');

  ctl.stop();
  assert.deepEqual([tailnetStatus().enabled, tailnetStatus().state], [false, 'off']);
  assert.equal(routesViaTailnet('https://homeassistant.tail1ebd8f.ts.net'), false);
});

test('Tailscale: a refused key is explained', async t => {
  const fake = fakeTailscale({ statuses: [{ BackendState: 'NeedsLogin' }], upFails: 'backend error: invalid key: unable to validate API key' });
  const ctl = startTailnet({ authKey: 'tskey-old', dataDir: mkdtempSync(join(tmpdir(), 'tailnet-')), spawn: fake.spawn, cli: fake.cli, checkEvery: 60000 });
  t.after(() => ctl.stop());
  await ctl.check();
  assert.equal(tailnetStatus().state, 'NeedsLogin');
  assert.match(tailnetStatus().error, /auth key was refused.*update TS_AUTHKEY/);
  await assert.rejects(haFetch('https://homeassistant.tail1ebd8f.ts.net/api/'), /needs a new auth key: the auth key was refused/);
  await ctl.check();
  assert.equal(fake.calls.filter(c => c.args[0] === 'up').length, 1, 'no hammering: at most one sign-in attempt every 5 minutes');
});
