// Minimal Seam client (https://docs.seam.co). Seam connects to the Yale Access cloud, so the app never
// sees Yale credentials: the owner logs in to Yale through Seam's "Connect Webview".
const BASE = process.env.SEAM_BASE || 'https://connect.getseam.com';

export class SeamClient {
  constructor(apiKey, fetchImpl = fetch) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async call(path, body = {}) {
    if (!this.apiKey) throw Object.assign(new Error('Add your Seam API key in Settings first.'), { status: 400 });
    const res = await this.fetch(BASE + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),   // a hung request mustn't stall every lock
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error('Seam rejected the API key. Check it in Settings.'), { status: 400 });
    if (!res.ok) {
      const err = new Error(`Seam: ${json.error?.message || json.error?.type || `request failed (${res.status})`}`);
      err.seamType = json.error?.type;
      throw err;
    }
    return json;
  }

  async devices() { return (await this.call('/devices/list')).devices || []; }
  async accessCodes(deviceId) { return (await this.call('/access_codes/list', { device_id: deviceId })).access_codes || []; }
  /** Codes created outside Seam, e.g. in the Yale Access app. */
  async unmanagedCodes(deviceId) { return (await this.call('/access_codes/unmanaged/list', { device_id: deviceId })).access_codes || []; }
  async createCode(params) { return (await this.call('/access_codes/create', params)).access_code; }
  updateCode(params) { return this.call('/access_codes/update', params); }
  deleteCode(accessCodeId) { return this.call('/access_codes/delete', { access_code_id: accessCodeId }); }
  convertToManaged(accessCodeId) { return this.call('/access_codes/unmanaged/convert_to_managed', { access_code_id: accessCodeId }); }
  async connectWebview() {
    return (await this.call('/connect_webviews/create', { accepted_providers: ['yale'] })).connect_webview;
  }
}
