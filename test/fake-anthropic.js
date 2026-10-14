// Stand-in for the Anthropic Messages API, used by the tests (and handy for trying the UI without a key).
// Records every request; answers tool-using requests by calling the first client tool once (or the one `toolCall`
// picks), then replying with text. `pauseFirst` makes the first reply a paused server-tool turn; `searches` adds
// web-search counts to the usage.
import { createServer } from 'node:http';

export function fakeAnthropic({ reply = req => `Draft for: ${JSON.stringify(req.messages.at(-1).content).slice(0, 80)}`, refuse = false,
  toolCall = null, pauseFirst = false, searches = 0 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: json });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if ((req.headers['x-api-key'] || '').includes('bad')) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (req.method === 'GET' && req.url.startsWith('/v1/models/')) return send(200, { type: 'model', id: req.url.split('/').pop(), display_name: 'Claude', created_at: '2026-01-01T00:00:00Z' });
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'nope' } });
      const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        ...(searches && { server_tool_use: { web_search_requests: searches } }) };
      const base = { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: json.model, stop_sequence: null, usage };
      if (refuse) return send(200, { ...base, content: [], stop_reason: 'refusal', stop_details: { category: 'general_harms', explanation: 'no' } });
      const last = json.messages.at(-1);
      const hasResult = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result');
      if (pauseFirst && requests.filter(r => r.url.startsWith('/v1/messages')).length === 1) {
        return send(200, { ...base, content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'events' } }], stop_reason: 'pause_turn' });
      }
      const clientTools = (json.tools || []).filter(x => !x.type || x.type === 'custom');
      if (toolCall && clientTools.length && !hasResult) {
        const c = toolCall(json);
        if (c) return send(200, { ...base, content: [{ type: 'tool_use', id: 'tu_' + requests.length, name: c.name, input: c.input }], stop_reason: 'tool_use' });
      }
      if (!toolCall && clientTools.length && !hasResult) {
        const t = clientTools.find(x => x.name === 'period_stats') || clientTools[0];
        const input = Object.fromEntries(Object.keys(t.input_schema.properties).map(k => [k,
          k === 'from' ? '2026-01-01' : k === 'to' ? '2026-02-01' : k === 'limit' ? 10 : t.input_schema.properties[k].enum?.[0] ?? '']));
        return send(200, { ...base, content: [{ type: 'tool_use', id: 'tu_' + requests.length, name: t.name, input }], stop_reason: 'tool_use' });
      }
      const text = hasResult ? `From the data: ${last.content.find(b => b.type === 'tool_result').content.slice(0, 200)}` : reply(json);
      send(200, { ...base, content: [{ type: 'text', text }], stop_reason: 'end_turn' });
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
