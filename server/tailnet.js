// Private route to Home Assistant over the owner's Tailscale network, so Home Assistant never has to be on the
// public internet. When TS_AUTHKEY is set, this runs Tailscale's daemon in userspace mode (no special container
// permissions), keeps its identity on the data volume so redeploys stay the same machine, and sends requests for
// tailnet addresses (*.ts.net, 100.64.0.0/10, short MagicDNS names) through its local proxy. Everything else
// (Beds24, Claude, ntfy, a public Home Assistant address) still goes direct.
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const PROXY = { host: '127.0.0.1', port: 1055 };   // Tailscale's outbound proxy (port changeable for tests)
const t = { enabled: false, state: 'off', name: null, ip: null, tailnet: null, health: [], error: null, checkedAt: null };
let ctl = null;   // the running manager (see startTailnet)
// Tailnet machines by MagicDNS name (full and short) -> Tailscale IP, from `tailscale status`. Requests connect to the
// IP, because Tailscale's proxy falls back to public DNS for names it doesn't know; the name is still used for the
// certificate check and the Host header.
let peers = new Map();

/** Addresses that only exist inside a tailnet. */
export function isTailnetHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (/\.ts\.net\.?$/.test(h)) return true;
  if (isIP(h) === 4) { const [a, b] = h.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; }
  if (isIP(h) === 6) return h.startsWith('fd7a:115c:a1e0:');
  return !!h && !h.includes('.') && h !== 'localhost';
}

export const tailnetStatus = () => ({ ...t, health: [...t.health] });
export const routesViaTailnet = url => { try { return t.enabled && isTailnetHost(new URL(url).hostname); } catch { return false; } };

/**
 * fetch() for Home Assistant: tailnet addresses go through Tailscale when it's switched on; anything else is a
 * normal fetch. Errors explain what's wrong with the Tailscale side, so the Smart home page can say so.
 */
export function haFetch(url, opts) {
  if (!routesViaTailnet(url)) return fetch(url, opts);
  if (t.state !== 'Running') {
    return Promise.reject(new Error(`Tailscale isn't connected yet: ${describeState()}`));
  }
  const name = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return proxyFetch(PROXY, url, { ...opts, via: peers.get(name) });
}

function describeState() {
  const s = { off: 'off', starting: 'starting', NoState: 'starting', Starting: 'starting', NeedsLogin: 'needs a new auth key',
    NeedsMachineAuth: 'waiting for approval in the Tailscale admin console', Stopped: 'stopped' }[t.state] || t.state;
  return t.error ? `${s}: ${t.error}` : s;
}

/**
 * A minimal fetch() through an HTTP CONNECT proxy (Tailscale's outbound proxy), returning a standard Response.
 * Node's built-in fetch can't use a proxy for one request only, and this keeps the app free of extra packages.
 * `via` is the address to connect to instead of the URL's host (which is still used for TLS and Host). A timeout
 * says which step stalled. `ca` is only for tests.
 */
export function proxyFetch(proxy, url, { method = 'GET', headers = {}, body, signal, ca, via } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let done = false, sock = null, req = null, phase = 'connecting through Tailscale';
    const finish = (fn, v) => {
      if (done) return;
      done = true; signal?.removeEventListener('abort', onAbort);
      if (fn === reject) { tunnel.destroy(); req?.destroy(); sock?.destroy(); }
      fn(v);
    };
    const onAbort = () => finish(reject, signal.reason?.name === 'TimeoutError'
      ? Object.assign(new Error(`Timed out ${phase}`), { name: 'TimeoutError', phase }) : signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    const target = `${via ? (isIP(via) === 6 ? `[${via}]` : via) : u.hostname}:${port}`;
    const tunnel = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: target, headers: { host: target } });
    tunnel.on('error', e => finish(reject, new Error(`Tailscale's proxy isn't answering (${e.code || e.message})`)));
    tunnel.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const why = head?.length ? head.toString().trim().slice(0, 200) : `proxy answered ${res.statusCode}`;
        return finish(reject, new Error(`Tailscale couldn't reach ${u.host} (${why})`));
      }
      phase = secure ? 'during the secure (TLS) handshake' : 'waiting for Home Assistant to answer';
      sock = secure ? tlsConnect({ socket, servername: isIP(host) ? undefined : host, ca }) : socket;
      if (secure) sock.once('secureConnect', () => { phase = 'waiting for Home Assistant to answer'; });
      const payload = body == null ? null : Buffer.from(body);
      req = httpRequest({
        method, path: u.pathname + u.search, createConnection: () => sock,
        headers: { host: u.host, ...headers, ...(payload ? { 'content-length': payload.length } : {}), connection: 'close' },
      });
      req.on('error', e => finish(reject, new Error(e.code || e.message, { cause: e })));
      req.on('response', r => {
        phase = 'reading the answer';
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('error', e => finish(reject, e));
        r.on('end', () => {
          const h = new Headers();
          for (let i = 0; i < r.rawHeaders.length; i += 2) h.append(r.rawHeaders[i], r.rawHeaders[i + 1]);
          const empty = [101, 204, 205, 304].includes(r.statusCode);
          finish(resolve, new Response(empty ? null : Buffer.concat(chunks), { status: r.statusCode, headers: h }));
          sock.destroy();
        });
      });
      req.end(payload);
    });
    tunnel.end();
  });
}

// ---------- Running Tailscale ----------

const realCli = (bin, socket) => args => new Promise((resolve, reject) =>
  execFile(join(bin, 'tailscale'), [`--socket=${socket}`, ...args], { timeout: 90000 }, (e, stdout, stderr) =>
    e ? reject(new Error((stderr || e.message).trim().split('\n').pop())) : resolve(stdout)));

/**
 * Start Tailscale (once) and keep it connected. Returns a controller (for tests and shutdown).
 * Traffic goes through Tailscale's relay (DERP) servers over TCP rather than direct UDP: from Railway, direct
 * connections passed small packets but stalled on the first large reply (the TLS certificate), the classic sign of a
 * path dropping full-size packets. It's still end-to-end encrypted; TS_DIRECT=1 allows direct connections.
 * Options are for tests: `spawn` starts the daemon, `cli(args)` runs the tailscale command and resolves its stdout.
 */
export function startTailnet({ authKey = process.env.TS_AUTHKEY, hostname = process.env.TS_HOSTNAME || 'str-dashboard', dataDir,
  direct = process.env.TS_DIRECT === '1', bin = '/usr/local/bin', socket = join(tmpdir(), 'tailscaled.sock'), proxyPort = 1055,
  spawn = nodeSpawn, cli, checkEvery = 30000, restartAfter = 15000 } = {}) {
  if (ctl || !authKey) return ctl;
  PROXY.port = proxyPort;
  cli ||= realCli(bin, socket);
  const stateDir = join(dataDir || 'data', 'tailscale');
  mkdirSync(stateDir, { recursive: true });
  Object.assign(t, { enabled: true, state: 'starting', error: null });
  let child = null, stopped = false, timer = null, lastLogin = 0, backoff = restartAfter, lastLog = '';

  const launch = () => {
    lastLog = '';
    const { TS_AUTHKEY, ...env } = process.env;   // the daemon doesn't need the key
    if (!direct) env.TS_DEBUG_ALWAYS_USE_DERP = 'true';
    child = spawn(join(bin, 'tailscaled'), ['--tun=userspace-networking', `--statedir=${stateDir}`, `--socket=${socket}`,
      `--outbound-http-proxy-listen=${PROXY.host}:${PROXY.port}`], { stdio: ['ignore', 'ignore', 'pipe'], env });
    // tailscaled logs a lot; keep only the last line so a crash can be explained.
    child.stderr?.on('data', d => { const l = String(d).trim().split('\n').pop(); if (l) lastLog = l.replace(/^\S+ \S+ /, ''); });
    child.on('error', e => { t.state = 'off'; t.error = `couldn't start Tailscale (${e.code || e.message})`; });
    child.on('exit', code => {
      child = null;
      if (stopped) return;
      Object.assign(t, { state: 'off', error: `Tailscale stopped (${lastLog || `exit ${code}`}); restarting` });
      console.error(`tailscale: daemon exited (${code}): ${lastLog}`);
      setTimeout(() => { if (!stopped) { launch(); backoff = Math.min(backoff * 2, 300000); } }, backoff).unref?.();
    });
  };

  const check = async () => {
    if (stopped || !child) return;
    let s;
    try { s = JSON.parse(await cli(['status', '--json'])); }
    catch (e) { if (t.state !== 'off') t.error = `waiting for Tailscale (${e.message})`; return; }
    t.checkedAt = new Date().toISOString();
    t.state = s.BackendState || 'NoState';
    t.name = s.Self?.DNSName?.replace(/\.$/, '') || null;
    t.ip = s.Self?.TailscaleIPs?.find(ip => isIP(ip) === 4) || s.Self?.TailscaleIPs?.[0] || null;
    t.tailnet = s.CurrentTailnet?.Name || null;
    t.health = Array.isArray(s.Health) ? s.Health.slice(0, 5) : [];
    const known = new Map();
    for (const p of Object.values(s.Peer || {})) {
      const ip = p.TailscaleIPs?.find(a => isIP(a) === 4) || p.TailscaleIPs?.[0];
      const full = String(p.DNSName || '').toLowerCase().replace(/\.$/, '');
      if (!ip || !full) continue;
      known.set(full, ip);
      if (!known.has(full.split('.')[0])) known.set(full.split('.')[0], ip);
    }
    peers = known;
    if (t.state === 'Running') { t.error = null; backoff = restartAfter; return; }
    if (['NeedsLogin', 'Stopped'].includes(t.state) && Date.now() - lastLogin > 5 * 60000) {
      lastLogin = Date.now();
      await up(t.state === 'NeedsLogin');
    }
  };

  // The key goes in a short-lived file rather than on the command line, where any process listing would show it.
  const up = async withKey => {
    const keyFile = join(tmpdir(), `ts-key-${randomBytes(6).toString('hex')}`);
    try {
      const args = ['up', `--hostname=${hostname}`, '--timeout=60s'];
      if (withKey) { writeFileSync(keyFile, authKey, { mode: 0o600 }); args.push(`--auth-key=file:${keyFile}`); }
      await cli(args);
      t.error = null;
      console.log(`tailscale: connected as ${hostname}`);
    } catch (e) {
      t.error = /invalid key|not valid|expired/i.test(e.message)
        ? 'the auth key was refused (expired, already used, or revoked); create a new one and update TS_AUTHKEY'
        : e.message;
      console.error(`tailscale: couldn't connect: ${e.message}`);
    } finally { rmSync(keyFile, { force: true }); }
    await check().catch(() => {});
  };

  launch();
  timer = setInterval(() => check().catch(() => {}), checkEvery);
  timer.unref?.();
  // First check soon after the daemon starts, then on the interval.
  const first = setTimeout(() => check().catch(() => {}), Math.min(2000, checkEvery));
  first.unref?.();

  ctl = {
    check,
    stop() { stopped = true; clearInterval(timer); clearTimeout(first); child?.kill('SIGTERM'); ctl = null; peers = new Map(); Object.assign(t, { enabled: false, state: 'off' }); },
  };
  return ctl;
}
