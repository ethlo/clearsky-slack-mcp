import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { messagesFrom, searchTool, parseArgs, options, READ_SCOPES } from '../lib/slack-mcp.mjs';
import makePlugin from '../source.mjs';
import { core } from './core.mjs';

const { sourceFromDir, PLUGIN_LENDS } = await core('lib/plugins.mjs');
const { tokenStore, discover, readToken } = await core('lib/mcp-oauth.mjs');
const { readOnly, fromSse } = await core('lib/mcp-client.mjs');
const { hook } = await core('lib/sources.mjs');
const { pluginItems } = await core('lib/items.mjs');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const freePort = async () => { const s = createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
const ts = (h) => (Date.now() - h * 36e5) / 1000;
const link = (ch, h) => { const [s, f] = ts(h).toFixed(6).split('.'); return `https://acme.slack.com/archives/${ch}/p${s}${f}`; };

const TOOLS = [
  { name: 'slack_search_public', description: 'Search public channels', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_search_public_and_private', description: 'Search all messages you can see', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, sort: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_read_thread', description: 'Read a thread', inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, message_ts: { type: 'string' } } } },
  { name: 'slack_send_message', description: 'Send a message', inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'slack_search_users', description: 'Find people', annotations: { readOnlyHint: true } },
];

// A fake Slack: OAuth metadata, an authorize page that comes straight back, a token endpoint
// that checks PKCE, and an MCP server (JSON and SSE answers, a session id).
async function fakeSlack() {
  const seen = { calls: [], tokenForms: [], challenge: null, auth: null };
  let base = '', tokenN = 0;
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/oauth-protected-resource') return send(200, { resource: base, authorization_servers: [base] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/authorize') {
      seen.auth = Object.fromEntries(u.searchParams);
      seen.challenge = u.searchParams.get('code_challenge');
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (u.pathname === '/token') {
      const f = Object.fromEntries(new URLSearchParams(await readBody(req)));
      seen.tokenForms.push(f);
      if (f.grant_type === 'authorization_code') {
        const ok = f.code === 'the-code' && createHash('sha256').update(f.code_verifier).digest('base64url') === seen.challenge;
        if (!ok) return send(200, { ok: false, error: 'invalid_code' });
      } else if (f.refresh_token !== 'refresh-1' && f.refresh_token !== 'refresh-2') return send(200, { ok: false, error: 'invalid_refresh_token' });
      tokenN++;
      return send(200, { ok: true, access_token: `xoxp-${tokenN}`, refresh_token: `refresh-${tokenN}`, expires_in: 43200, token_type: 'user', authed_user: { id: 'U1' }, team: { id: 'T1', name: 'Acme' } });
    }
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Bearer ') || auth === `Bearer ${seen.revoked}`) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); return res.end(); }
      const msg = JSON.parse(await readBody(req));
      seen.calls.push({ method: msg.method, session: req.headers['mcp-session-id'] || null, name: msg.params?.name, args: msg.params?.arguments, auth });
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') return send(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }, { 'Mcp-Session-Id': 'sess-1' });
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })}\n\n`);
      }
      if (msg.method === 'tools/call') {
        const text = msg.params.name.startsWith('slack_search_public_and_private')
          ? `# Results\n\n- From: Anna Berg\n  Channel: #payments\n  Text: <@U1> can you look at <#C2|deploys>?\n  Permalink: ${link('C1', 1)}\n\n- From: Bob\n  Text: ping <@U1>\n  Permalink: ${link('D9', 30)}\n\n- From: Old\n  Text: old <@U1>\n  Permalink: ${link('C1', 24 * 30)}\n`
          : `thread for ${JSON.stringify(msg.params.arguments)}`;
        return send(200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
      }
    }
    send(404, { error: 'not found' });
  });
  const port = await listen(srv);
  base = `http://127.0.0.1:${port}`;
  return { base, seen, close: () => srv.close() };
}

async function plugin(fake) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-mcp-'));
  const store = tokenStore(join(dir, 'token.json'));
  const opened = [];
  // The "browser": follows the authorize page back to the callback on localhost.
  const lends = { ...PLUGIN_LENDS, openUrl: (u) => { opened.push(u); fetch(u).catch(() => {}); } };
  const p = makePlugin(lends, { store });
  const env = { SLACK_MCP_CLIENT_ID: '111.222', SLACK_MCP_URL: `${fake.base}/mcp`, SLACK_MCP_REDIRECT_URI: `http://localhost:${await freePort()}/callback` };
  return { p, env, store, opened, file: join(dir, 'token.json') };
}

test('log in with PKCE through a localhost callback, keep the token only for you, read mentions', async (t) => {
  const fake = await fakeSlack();
  t.after(fake.close);
  const { p, env, store, opened, file } = await plugin(fake);
  assert.equal(p.logins.list(env)[0].loggedIn, false);
  const r = await p.logins.start('slack', env);
  assert.match(r.detail, /Logged in to Acme; 4 read-only tools/);
  assert.equal(opened.length, 1);
  assert.equal(fake.seen.auth.client_id, '111.222');
  assert.equal(fake.seen.auth.code_challenge_method, 'S256');
  assert.equal(fake.seen.auth.scope, READ_SCOPES);
  assert.equal(fake.seen.auth.resource, fake.base);
  assert.equal(fake.seen.tokenForms[0].client_secret, undefined, 'PKCE: no secret unless one is set');
  assert.equal(store.get().user, 'U1');
  assert.equal(statSync(file).mode & 0o077, 0, 'the token file is yours only');
  assert.equal(p.logins.list(env)[0].loggedIn, true);

  const d = await p.fetch({ env });
  assert.deepEqual(d.mentions.map((m) => [m.by, m.channel]), [['Anna Berg', '#payments'], ['Bob', 'DM']], 'newest first, not older than the window');
  assert.equal(d.mentions[0].excerpt, '@you can you look at #deploys?');
  const search = fake.seen.calls.find((c) => c.method === 'tools/call');
  assert.equal(search.name, 'slack_search_public_and_private');
  assert.match(search.args.query, /^<@U1> after:\d{4}-\d\d-\d\d$/);
  assert.equal(search.session, 'sess-1', 'the session id goes along');

  const s = await sourceFromDir(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(s.area, 'work');
  assert.equal(s.enabled({}), false);
  assert.equal(s.enabled({ SLACK_MCP_CLIENT_ID: '1.2' }), true);
  const rows = pluginItems(s, { ...d, items: hook(s, 'items', d) });
  assert.deepEqual(rows.map((x) => [x.kind, x.next.label]), [['mention', 'Reply'], ['mention', 'Reply']]);
  assert.deepEqual(hook(s, 'plan', d).map((x) => x.title), ['Reply to Anna Berg in #payments']);

  await p.logins.stop('slack', env);
  assert.equal(store.get(), null);
  await assert.rejects(p.fetch({ env }), (e) => e.auth === true);
});

test('the door reads with the tools that only read, and refuses the ones that write', async (t) => {
  const fake = await fakeSlack();
  t.after(fake.close);
  const { p, env } = await plugin(fake);
  await p.logins.start('slack', env);
  const door = p.doors.slack;
  const run = (...argv) => door.run(argv, { env, chat: { mode: 'sandboxed' } });
  const list = await run('tools');
  assert.match(list.stdout, /slack_read_thread \(channel_id\?, message_ts\?\)/);
  assert.doesNotMatch(list.stdout, /send_message/);
  const read = await run('slack_read_thread', 'channel_id=C1', 'message_ts=1700000000.000100');
  assert.equal(read.code, 0);
  assert.equal(read.decided, 'read');
  assert.match(read.stdout, /"message_ts":"1700000000.000100"/, 'string by the schema, not a number');
  const send = await run('slack_send_message', 'channel_id=C1', 'text=hi');
  assert.equal(send.code, 1);
  assert.equal(send.decided, 'refused');
  assert.ok(!fake.seen.calls.some((c) => c.name === 'slack_send_message'), 'never sent to Slack');
  assert.equal((await run('nope')).code, 2);
  assert.match((await run('help')).stdout, /door slack tools/);
  assert.match(door.hint(), /door slack/);
});

test('an expired token is refreshed; a refused one asks to log in again', async (t) => {
  const fake = await fakeSlack();
  t.after(fake.close);
  const { p, env, store } = await plugin(fake);
  await p.logins.start('slack', env);
  store.set({ ...store.get(), expires_at: Date.now() - 1000 });
  await p.fetch({ env });
  assert.equal(fake.seen.tokenForms.at(-1).grant_type, 'refresh_token');
  assert.equal(store.get().access_token, 'xoxp-2');
  assert.equal(store.get().user, 'U1', 'kept across the refresh');
  // Slack ends the token: one refresh on the 401, then on.
  fake.seen.revoked = 'xoxp-2';
  await p.fetch({ env });
  assert.equal(store.get().access_token, 'xoxp-3');
  store.set({ ...store.get(), refresh_token: null });
  fake.seen.revoked = 'xoxp-3';
  await assert.rejects(p.fetch({ env }), (e) => e.auth === true);
});

test('discovery follows the 401 hint; tokens in either shape', async (t) => {
  const fake = await fakeSlack();
  t.after(fake.close);
  const ep = await discover(`${fake.base}/mcp`);
  assert.equal(ep.token_endpoint, `${fake.base}/token`);
  const none = await discover('http://127.0.0.1:1/mcp', { defaults: { authorization_endpoint: 'https://a/x', token_endpoint: 'https://a/t' } });
  assert.equal(none.token_endpoint, 'https://a/t');
  assert.equal(readToken({ access_token: 'a', expires_in: 10 }, 0).expires_at, 10_000);
  assert.equal(readToken({ ok: true, authed_user: { id: 'U9', access_token: 'b' } }).access_token, 'b');
  assert.throws(() => readToken({ ok: false, error: 'invalid_code' }), (e) => e.auth === true);
});

test('read only, messages from structured content, arguments, settings', () => {
  assert.equal(readOnly({ name: 'slack_search_users' }), true);
  assert.equal(readOnly({ name: 'slack_send_message', annotations: { readOnlyHint: true } }), false, 'a name that writes wins over the hint');
  assert.equal(readOnly({ name: 'slack_get_file_upload_url' }), false);
  assert.equal(readOnly({ name: 'slack_create_canvas' }), false);
  assert.equal(readOnly({ name: 'mystery' }), false);
  assert.equal(readOnly({ name: 'mystery', annotations: { readOnlyHint: true } }), true);
  assert.equal(searchTool(TOOLS).name, 'slack_search_public_and_private');
  assert.deepEqual(fromSse('data: {"id":2}\n\ndata: {"id":1,"result":1}\n\n', 1), { id: 1, result: 1 });
  const m = messagesFrom({ structuredContent: { messages: [{ ts: '1700000000.000100', user: 'U2', username: 'anna', text: 'hi <@U1>', channel: { name: 'x' }, permalink: 'https://a.slack.com/archives/C1/p1700000000000100' }] } }, 'U1');
  assert.deepEqual([m[0].by, m[0].channel, m[0].excerpt], ['anna', '#x', 'hi @you']);
  assert.deepEqual(parseArgs(['{"a":1}']).value, { a: 1 });
  assert.deepEqual(parseArgs(['n=5', 'q=007'], { properties: { q: { type: 'string' } } }).value, { n: 5, q: '007' });
  assert.ok(parseArgs(['oops']).error);
  assert.equal(options({}).url, 'https://mcp.slack.com/mcp');
  assert.equal(options({ SLACK_MCP_SCOPES: 'a,b  c' }).scope, 'a b c');
});
