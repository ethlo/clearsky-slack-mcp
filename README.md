# Slack (MCP) for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. Add it with `clearsky add slack-mcp --trust` (or Add under Settings → Plugins): that's `github:ethlo/clearsky-slack-mcp` at the version Clearsky's catalog pins. It needs `--trust` because it lends chats a door with your login, so it runs inside Clearsky.

Slack through Slack's own MCP server (`https://mcp.slack.com/mcp`), read only, with no token to create or paste:

- **Log in from Settings.** Settings → Plugins → Slack (MCP) → Log in opens Slack in your browser (OAuth with PKCE). Slack sends you back to a callback on this machine (`http://localhost:19876/callback` unless you set another), and the token is kept in `~/.config/clearsky/slack-mcp-token.json`, readable by you only. It's refreshed when it runs out; Log out deletes it.
- **Mentions.** Messages that mention you from the last two weeks (`CLEARSKY_MENTION_DAYS`) show under Needs you with Reply, notify you when new, and the ones from the last day go into Now / Next. They come from Slack's message search with `<@{me}> after:{after}`; change it under **Mentions search**.
- **Copilot chats** read Slack with `door slack …`, which Clearsky runs with your login, so the login never goes in the sandbox. `door slack tools` lists the tools that only read; tools that send, react, create, upload or change anything are refused, whatever the server says about them. Every call is in Copilot's changes.

## Setting it up

Slack's MCP server only takes registered Slack apps, so you need the client ID of one (from your Slack admins, or an app of your own: Basic Information → App Credentials). The app needs:

- `http://localhost:19876/callback` (or your **Redirect URL**) under OAuth & Permissions → Redirect URLs,
- PKCE turned on, or else put its client secret under **Client secret**,
- the user scopes you ask for. The default is read only: `channels:history channels:read groups:history groups:read im:history im:read mpim:history mpim:read search:read.public search:read.private search:read.im search:read.mpim search:read.files search:read.users files:read canvases:read lists:read reactions:read emoji:read users:read`.

Then `clearsky add slack-mcp` (or Add under Settings → Plugins), fill in **Slack app client ID**, and Log in.

The client ID is your workspace's: it lives in your settings file only, never in a repo.

## Next to the Slack plugin

The `slack` plugin does mentions with a user token you paste. This one needs no token and also gives chats Slack to read. Use one of them for mentions, or you'll see each twice.

## Develop

```sh
git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
CLEARSKY_CORE=.clearsky npm test
```

The tests load the plugin the way Clearsky does, so they need a Clearsky checkout (see `test/core.mjs`). Release by bumping `version` in `clearsky-plugin.json` and `package.json` and tagging `v<version>`.
