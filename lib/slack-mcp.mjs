// Slack through its MCP server: your login (lib/oauth.mjs), the read-only tools (lib/mcp.mjs),
// the messages that mention you, and the `door slack …` commands chats use.

// The generic parts are Clearsky's (lib/mcp-oauth.mjs, lib/mcp-client.mjs), lent to plugins.
let oauthLogin, refresh, expiresSoon, mcpClient, readOnly, resultText;
export function useLends(lends) {
  ({ login: oauthLogin, refresh, expiresSoon } = lends.mcpOAuth);
  ({ mcpClient, readOnly, resultText } = lends.mcpClient);
}

export const DEFAULT_URL = 'https://mcp.slack.com/mcp';
export const DEFAULT_REDIRECT = 'http://localhost:19876/callback';
export const READ_SCOPES = 'channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read search:read.public search:read.private search:read.im search:read.mpim search:read.files search:read.users files:read canvases:read lists:read reactions:read emoji:read users:read';
// Your mentions: `{me}` is your Slack user, `{after}` the day the window starts.
export const DEFAULT_QUERY = '<@{me}> after:{after}';
// Slack's own endpoints, for when the server doesn't publish its metadata.
export const SLACK_ENDPOINTS = {
  authorization_endpoint: 'https://slack.com/oauth/v2_user/authorize',
  token_endpoint: 'https://slack.com/api/oauth.v2.user.access',
};

// The settings, with their defaults.
export function options(env = {}) {
  return {
    url: env.SLACK_MCP_URL || DEFAULT_URL,
    clientId: (env.SLACK_MCP_CLIENT_ID || '').trim(),
    clientSecret: env.SLACK_MCP_CLIENT_SECRET || '',
    redirectUri: env.SLACK_MCP_REDIRECT_URI || DEFAULT_REDIRECT,
    scope: (env.SLACK_MCP_SCOPES || READ_SCOPES).split(/[\s,]+/).filter(Boolean).join(' '),
    query: env.SLACK_MCP_QUERY || DEFAULT_QUERY,
  };
}

export function slackText(text, me) {
  const plain = String(text || '')
    .replaceAll(`<@${me}>`, '@you')
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name) => `@${name || 'someone'}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 220 ? `${plain.slice(0, 217)}...` : plain;
}

const PERMALINK = /https:\/\/[\w.-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})\S*/;
const tsOf = (link) => { const m = String(link || '').match(PERMALINK); return m ? `${m[2]}.${m[3]}` : null; };
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((x, p) => x?.[p], o); if (v != null && v !== '') return v; } return null; };

// The messages in a search tool's answer. MCP tools mostly answer in text, so this takes
// structured content or JSON where there is some, and else one message per permalink.
export function messagesFrom(result, me) {
  const asList = (v) => (Array.isArray(v) ? v : Array.isArray(v?.messages) ? v.messages : Array.isArray(v?.messages?.matches) ? v.messages.matches
    : Array.isArray(v?.results) ? v.results : Array.isArray(v?.matches) ? v.matches : null);
  let list = asList(result?.structuredContent);
  if (!list) for (const c of result?.content || []) {
    if (c.type !== 'text') continue;
    try { list = asList(JSON.parse(c.text)); } catch { /* text */ }
    if (list) break;
  }
  if (list) {
    return list.map((m) => {
      const url = pick(m, 'permalink', 'url', 'link');
      const ts = pick(m, 'ts', 'message_ts') || tsOf(url);
      const ch = m.channel && typeof m.channel === 'object' ? m.channel : { name: pick(m, 'channel_name', 'channel') };
      return {
        url, stamp: ts ? String(ts) : url, at: ts ? new Date(Number(ts) * 1000).toISOString() : null,
        user: pick(m, 'user', 'user_id', 'author_id'),
        by: pick(m, 'username', 'user_name', 'author_name', 'author', 'real_name', 'user.name') || 'someone',
        channel: ch.is_im ? 'DM' : ch.is_mpim ? 'Group DM' : ch.name ? `#${String(ch.name).replace(/^#/, '')}` : 'Slack',
        excerpt: slackText(pick(m, 'text', 'message', 'content'), me),
      };
    }).filter((m) => m.url);
  }
  // Text: a block around each permalink.
  const text = resultText(result);
  const out = [];
  for (const block of text.split(/\n\s*\n|\n(?=[-*] |\d+\. |#{1,4} )/)) {
    const link = block.match(PERMALINK);
    if (!link) continue;
    const ts = `${link[2]}.${link[3]}`;
    const field = (re) => block.match(re)?.[1]?.trim();
    const chan = field(/(?:channel|in)\s*[:=]?\s*#?([\w.-]+)/i);
    const by = field(/(?:from|user|author)\s*[:=]\s*@?([^\n,;|()]+)/i);
    const body = field(/(?:text|message)\s*[:=]\s*([^\n]+)/i)
      || block.replace(PERMALINK, '').split('\n').map((l) => l.replace(/^[-*#\d.\s]+/, '').trim()).filter((l) => l && !/^(channel|from|user|author|time|date|ts|link|permalink)\s*[:=]/i.test(l)).join(' ');
    out.push({ url: link[0].replace(/[)\].,>]+$/, ''), stamp: ts, at: new Date(Number(ts) * 1000).toISOString(), user: null,
      by: by || 'someone', channel: /^D[A-Z0-9]+$/.test(link[1]) ? 'DM' : chan ? `#${chan}` : 'Slack', excerpt: slackText(body, me) });
  }
  return out;
}

// The search tool that reads messages: the widest one there is.
export function searchTool(tools) {
  const ro = tools.filter(readOnly).filter((t) => /search/i.test(t.name) && !/user|channel|emoji|file/i.test(t.name));
  const score = (t) => (/private/i.test(t.name) ? 2 : 0) + (/message|public/i.test(t.name) ? 1 : 0);
  return ro.sort((a, b) => score(b) - score(a))[0] || null;
}

export function createSlackMcp({ store, fetchImpl = fetch, open, now = () => Date.now() }) {
  let opts = options({}), client = null, clientFor = '';
  const use = (env) => { opts = options(env); };

  async function token() {
    let t = store.get();
    if (!t?.access_token) throw Object.assign(new Error('not logged in to Slack; log in in Settings → Plugins → Slack (MCP)'), { auth: true });
    if (expiresSoon(t, now())) { t = await refresh(t, { ...opts, fetchImpl, now: now() }); store.set(t); }
    return t.access_token;
  }
  function mcp() {
    const key = opts.url;
    if (!client || clientFor !== key) {
      client = mcpClient({ url: opts.url, token, fetchImpl,
        onAuth: async () => { const t = store.get(); if (!t?.refresh_token) throw Object.assign(new Error('Slack ended the login; log in again in Settings'), { auth: true }); store.set(await refresh(t, { ...opts, fetchImpl, now: now() })); } });
      clientFor = key;
    }
    return client;
  }
  let toolCache = null;
  async function tools() {
    if (toolCache && now() - toolCache.at < 10 * 60_000 && toolCache.url === opts.url) return toolCache.list;
    const list = await mcp().tools();
    toolCache = { at: now(), url: opts.url, list };
    return list;
  }

  return {
    use,
    status() {
      const t = store.get();
      if (!t?.access_token) return { loggedIn: false, detail: opts.clientId ? 'not logged in' : 'set the Slack app\'s client ID, then log in' };
      return { loggedIn: true, detail: `logged in${t.team ? ` to ${t.team}` : ''} ${new Date(t.at).toLocaleDateString()}` };
    },
    async login() {
      const t = await oauthLogin({ mcpUrl: opts.url, clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri: opts.redirectUri, scope: opts.scope, defaults: SLACK_ENDPOINTS, open, fetchImpl, now });
      store.set(t);
      client = null; toolCache = null;
      const ro = (await tools()).filter(readOnly);
      return { detail: `Logged in${t.team ? ` to ${t.team}` : ''}; ${ro.length} read-only tools.` };
    },
    logout() { store.set(null); client = null; toolCache = null; },
    tools,
    readTools: async () => (await tools()).filter(readOnly),

    // Messages that mention you, from the last `days` days, newest first.
    async mentions({ days = 14 } = {}) {
      const t = store.get();
      const tool = searchTool(await tools());
      if (!tool) return { mentions: [], note: 'Slack offers no search tool for messages' };
      const me = t?.user || '';
      const after = new Date(now() - (days + 1) * 864e5).toISOString().slice(0, 10);
      const query = opts.query.replaceAll('{me}', me).replaceAll('{after}', after);
      if (query.includes('<@>')) return { mentions: [], note: 'your Slack user is not known; log in again' };
      const args = { query, ...(tool.inputSchema?.properties?.sort && { sort: 'timestamp' }), ...(tool.inputSchema?.properties?.limit && { limit: 50 }) };
      const r = await mcp().callTool(tool.name, args);
      if (r?.isError) throw new Error(`Slack ${tool.name}: ${resultText(r).slice(0, 200)}`);
      const cutoff = now() - days * 864e5;
      const mentions = messagesFrom(r, me).filter((m) => (!me || m.user !== me) && (!m.at || Date.parse(m.at) >= cutoff))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return { team: t?.team || null, tool: tool.name, mentions };
    },

    // `door slack …` for chats.
    async run(argv) {
      const [cmd, ...rest] = argv;
      if (!cmd || cmd === 'help' || cmd === '--help') return { code: 0, stdout: USAGE };
      const all = await tools();
      const ro = all.filter(readOnly);
      if (cmd === 'tools') {
        return { code: 0, stdout: ro.map((t) => {
          const props = Object.keys(t.inputSchema?.properties || {});
          const req = new Set(t.inputSchema?.required || []);
          return `${t.name}${props.length ? ` (${props.map((p) => (req.has(p) ? p : `${p}?`)).join(', ')})` : ''}\n  ${String(t.description || '').split('\n')[0].slice(0, 200)}`;
        }).join('\n') + '\n' };
      }
      if (cmd === 'schema') {
        const t = ro.find((x) => x.name === rest[0]);
        if (!t) return { code: 2, stderr: `slack: no read-only tool called ${rest[0] || '(none)'}; \`door slack tools\` lists them\n` };
        return { code: 0, stdout: `${JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }, null, 2)}\n` };
      }
      const tool = all.find((x) => x.name === cmd);
      if (!tool) return { code: 2, stderr: `slack: no tool called ${cmd}; \`door slack tools\` lists them\n\n${USAGE}` };
      if (!readOnly(tool)) return { code: 1, stderr: `slack: ${cmd} would change something in Slack, and this door only reads. Tell the user what you'd send instead.\n`, decided: 'refused' };
      const args = parseArgs(rest, tool.inputSchema);
      if (args.error) return { code: 2, stderr: `slack: ${args.error}\n` };
      const r = await mcp().callTool(tool.name, args.value);
      return { code: r?.isError ? 1 : 0, stdout: `${resultText(r)}\n`, target: tool.name };
    },
  };
}

export const USAGE = `door slack tools                    the read-only Slack tools and their arguments (? = optional)
door slack schema <tool>            one tool's full input schema
door slack <tool> key=value …       call a tool; values that look like numbers or true/false are typed
door slack <tool> '{"json": "args"}'  or give the arguments as one JSON object
Reads only, as the user: tools that send, react, create or change anything are refused.
`;

// key=value pairs or one JSON object, typed by the tool's schema where it says.
export function parseArgs(rest, schema = {}) {
  if (!rest.length) return { value: {} };
  if (rest.length === 1 && rest[0].trim().startsWith('{')) {
    try { const v = JSON.parse(rest[0]); return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { error: 'the JSON arguments must be an object' }; } catch { return { error: 'the JSON arguments are not valid JSON' }; }
  }
  const props = schema?.properties || {};
  const value = {};
  for (const a of rest) {
    const i = a.indexOf('=');
    if (i < 1) return { error: `"${a}" is not key=value` };
    const k = a.slice(0, i), raw = a.slice(i + 1);
    const type = props[k]?.type;
    value[k] = type === 'string' ? raw
      : type === 'array' ? (raw.trim().startsWith('[') ? (() => { try { return JSON.parse(raw); } catch { return [raw]; } })() : raw.split(',').map((x) => x.trim()))
        : raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) && type !== 'string' ? Number(raw) : raw;
  }
  return { value };
}
