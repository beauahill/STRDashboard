// Minimal Beds24 API v2 client. Docs: https://wiki.beds24.com/index.php/API_V2.0
// Auth flow: one-time invite code -> long-lived refresh token -> short-lived (24h) access token.
import { getSetting, setSetting } from './db.js';

const BASE = process.env.BEDS24_BASE || 'https://beds24.com/api/v2';
// How far each sync has got; cleared on connect so a new connection (maybe another account) starts with a full sync.
const SYNC_MARKS = ['last_sync', 'messages_synced', 'last_full_check'];

export class Beds24Client {
  constructor(db, fetchImpl = fetch, { timeoutMs = 30000 } = {}) {
    this.db = db;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get connected() { return !!getSetting(this.db, 'beds24_refresh_token'); }

  /** Every request has a deadline: a connection Beds24 accepts but never answers must not wedge syncing for minutes. */
  async #call(url, opts) {
    try { return await this.fetch(url, { ...opts, signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`Beds24 didn't answer within ${this.timeoutMs / 1000} s`);
      throw e;
    }
  }

  /** Exchange a one-time invite code (Beds24: Settings > Apps & Integrations > API) for tokens. */
  async connect(inviteCode) {
    const res = await this.#call(`${BASE}/authentication/setup`, { headers: { code: inviteCode.trim(), deviceName: 'STR Dashboard' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.refreshToken) throw new Error(body.error || `Beds24 setup failed (${res.status})`);
    setSetting(this.db, 'beds24_refresh_token', body.refreshToken);
    for (const k of SYNC_MARKS) setSetting(this.db, k, null);
    this.#cacheToken(body.token, body.expiresIn);
    await this.refreshScopes().catch(() => {});
  }

  disconnect() {
    for (const k of ['beds24_refresh_token', 'beds24_token', 'beds24_token_exp', 'beds24_scopes']) setSetting(this.db, k, null);
  }

  /** Permissions granted to the invite code, e.g. ["read:bookings", "write:inventory"]. */
  async refreshScopes() {
    const body = await this.get('/authentication/details');
    setSetting(this.db, 'beds24_scopes', JSON.stringify(body.token?.scopes || []));
  }

  get scopes() {
    try { return JSON.parse(getSetting(this.db, 'beds24_scopes') || 'null'); } catch { return null; }
  }

  /** true/false when Beds24 told us the scopes, null when unknown (older connections). */
  get canWriteInventory() { return this.#canWrite('inventory'); }
  get canWriteProperties() { return this.#canWrite('properties'); }
  #canWrite(area) {
    const s = this.scopes;
    if (!s) return null;
    return s.some(x => new RegExp(area, 'i').test(x) && !/^read/i.test(x));
  }

  #cacheToken(token, expiresIn = 86400) {
    setSetting(this.db, 'beds24_token', token);
    setSetting(this.db, 'beds24_token_exp', Date.now() + (expiresIn - 300) * 1000);
  }

  async #token(force = false) {
    const cached = getSetting(this.db, 'beds24_token');
    if (!force && cached && Number(getSetting(this.db, 'beds24_token_exp')) > Date.now()) return cached;
    const refresh = getSetting(this.db, 'beds24_refresh_token');
    if (!refresh) throw Object.assign(new Error('Not connected to Beds24'), { status: 400 });
    const res = await this.#call(`${BASE}/authentication/token`, { headers: { refreshToken: refresh } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) throw new Error(body.error || `Beds24 token refresh failed (${res.status})`);
    this.#cacheToken(body.token, body.expiresIn);
    return body.token;
  }

  async #request(method, path, { query = {}, body } = {}, retried = false) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x)); else url.searchParams.set(k, v);
    }
    const headers = { token: await this.#token(retried) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.#call(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && !retried) return this.#request(method, path, { query, body }, true);
    if (res.status === 429) throw new Error('Beds24 rate limit hit - try again in a few minutes');
    const json = await res.json().catch(() => undefined);
    if (res.status === 403) {
      throw Object.assign(new Error(json?.error || 'Beds24 refused this: the invite code doesn\'t have permission for it.'), { status: 403 });
    }
    if (!res.ok) throw new Error(json?.error || `Beds24 ${path} failed (${res.status})`);
    // A 2xx that isn't Beds24's JSON (a maintenance page, a proxy) or says success:false is an error, not an empty
    // result: taken as data it would move the sync watermark past changes that were never fetched.
    if (json == null || typeof json !== 'object') throw new Error(`Beds24 ${path} returned ${res.headers?.get?.('content-type') || 'no content type'} instead of JSON (${res.status})`);
    if (json.success === false) throw new Error(json.error || `Beds24 ${path} failed`);
    return json;
  }

  get(path, query = {}) { return this.#request('GET', path, { query }); }
  post(path, body) { return this.#request('POST', path, { body }); }
  patch(path, query, body) { return this.#request('PATCH', path, { query, body }); }

  /** Follow Beds24 pagination, returning every row from `data`. */
  async getAll(path, query = {}) {
    const rows = [];
    for (let page = 1; page < 200; page++) {
      const body = await this.get(path, { ...query, page });
      if (!Array.isArray(body.data)) throw new Error(`Beds24 ${path} returned no data list`);
      rows.push(...body.data);
      if (!body.pages?.nextPageExists) break;
    }
    return rows;
  }
}
