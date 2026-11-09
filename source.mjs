// Slack through Slack's own MCP server, read only: you log in from Settings in your browser
// (OAuth with PKCE, back to a callback on localhost), so there's no token to create or paste.
// Messages that mention you show up like the Slack plugin's, and Copilot chats read Slack with
// `door slack …`, which runs here with your login: the login never goes in the sandbox, and
// tools that send or change anything are refused. What it reaches and keeps is in
// clearsky-plugin.json. The MCP and OAuth parts are Clearsky's (lends.mcpOAuth, lends.mcpClient).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createSlackMcp, useLends, USAGE } from './lib/slack-mcp.mjs';

const recent = (iso, hours, now = Date.now()) => now - Date.parse(iso) < hours * 36e5;
const ago = (iso) => { const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 6e4)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

export default (lends, { store, fetchImpl = fetch } = {}) => {
  useLends(lends);
  store ||= lends.mcpOAuth.tokenStore(join(homedir(), '.config', 'clearsky', 'slack-mcp-token.json'));
  const slack = createSlackMcp({ store, fetchImpl, open: (u) => lends.openUrl(u) });
  const mentions = (m) => m.mentions || [];

  return {
    async fetch(ctx) {
      slack.use(ctx.env);
      return slack.mentions({ days: Math.max(1, Number(process.env.CLEARSKY_MENTION_DAYS) || 14) });
    },

    // One login, with a Log out next to it (Settings → Plugins → Slack (MCP)).
    logins: {
      list(env) { slack.use(env); const s = slack.status(); return [{ id: 'slack', label: 'Slack', ...s, canLogOut: s.loggedIn }]; },
      async start(id, env) { slack.use(env); return slack.login(); },
      async stop(id, env) { slack.use(env); slack.logout(); },
    },

    items: (d) => mentions(d).map((m) => ({
      key: m.url, stamp: m.stamp, url: m.url, at: m.at, ref: m.channel,
      kind: 'mention', next: 'reply', open: 'Open in Slack', quoteLabel: 'Message',
      title: `${m.by} in ${m.channel}`, quote: m.excerpt, meta: m.excerpt,
      why: `${m.by} mentioned you in ${m.channel}.`,
    })),
    attention: (d) => mentions(d).map((m) => ({ key: m.url, stamp: m.stamp, at: m.at, url: m.url, title: `${m.by} in ${m.channel}`, body: m.excerpt })),
    plan: (d) => mentions(d).filter((m) => m.at && recent(m.at, 24))
      .map((m) => ({ key: m.url, title: `Reply to ${m.by} in ${m.channel}`, detail: m.excerpt, url: m.url, stamp: m.stamp, minutes: 5, why: 'Slack mention' })),
    markdown: (d) => ({ title: 'Slack mentions', lines: mentions(d).map((m) => `[${m.channel}](${m.url}) ${m.by}${m.at ? `, ${ago(m.at)}` : ''}: "${m.excerpt}"`) }),

    doors: {
      slack: {
        usage: USAGE,
        hint: () => 'To read Slack (search messages, read a channel or thread, look up people, canvases and files), use `door slack` (`door slack tools` lists what it can do): it calls Slack\'s MCP server read only, as me, through Clearsky, which holds the login. It can\'t send or change anything in Slack; write out what to send instead.',
        async run(argv, door) {
          slack.use(door.env);
          try { const r = await slack.run(argv); return { stdout: '', stderr: '', decided: r.code ? 'failed' : 'read', ...r }; }
          catch (e) { return { code: 1, stdout: '', stderr: `Clearsky: ${e.message}\n`, decided: e.auth ? 'not logged in' : 'failed' }; }
        },
      },
    },
  };
};
