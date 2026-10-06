🤖 AI: Directed

# Drebot Slack bridge

Drebot is an optional local sidecar for this HQ fork. It posts as a Slack bot and routes accepted
human messages into T3 threads through the public orchestration API. The bridge can be removed
without changing the T3 server when native messaging support is ready.

## Start

Use Node 24.13.1 or newer in the Node 24 line. No package installation is required.

```sh
node scripts/drebot/cli.mjs status
node scripts/drebot/cli.mjs watch
```

Keep the listener in a visible terminal. Stop it with Ctrl-C. It survives Slack reconnects and
recovers recent history on startup, but it does not run while the machine or terminal is off.

Private configuration and conversation mappings live under `~/tmp/cc`. Set `DREBOT_STATE` to
choose another directory. This default preserves the original HQ installation's credentials and
SQLite mappings during migration. Never commit this directory.

## Configure

Create a Slack app with a bot user, a writable Messages tab, and Socket Mode. Install it in the
workspace and invite it to each configured channel. Give the bot these scopes:
`chat:write`, `app_mentions:read`, `channels:history`, `channels:read`, `im:history`,
`im:read`, and `im:write`. Subscribe to `app_mention`, `message.channels`, and
`message.im`. Generate an app-level token with `connections:write`.

Save `config/drebot.json` under the private state directory with mode 0600. An example:

```json
{
  "teamId": "T123",
  "botUserId": "UBOT123",
  "ownerUserId": "UOWNER123",
  "botToken": "xoxb-replace-me",
  "appToken": "xapp-replace-me",
  "activatedAt": "1791300000",
  "allowedUsers": ["UOWNER123"],
  "allowDms": true,
  "defaultRoute": {
    "projectId": "registered-t3-project-id",
    "modelSelection": {
      "instanceId": "codex",
      "model": "gpt-6.1-sol",
      "options": [{ "id": "reasoningEffort", "value": "xhigh" }]
    },
    "workspaceStrategy": { "type": "root" },
    "runtimeMode": "auto-accept-edits",
    "prompt": "Read the installed drebot skill and handle this request."
  },
  "channels": {}
}
```

Channel routes use the same shape, with `listen: "mentions"` or `listen: "all"`. A mapped
thread accepts later replies without another mention. Each route can override `allowedUsers`;
`["*"]` explicitly permits all human workspace members in that route. Keep DMs owner-only unless
you intend to grant others access to agents running on your machine.
Restart the listener after configuration changes. Current route authorization also applies to
existing mapped conversations; their project and model binding stays fixed. Slack Connect events
and events identifying a sender from another team are refused.

Choose a registered project, a live model and effort, workspace strategy, and runtime mode explicitly.
Use `{ "type": "worktree", "baseRef": "main", "startFromOrigin": true }` for isolated code work.
Approval requests stay in T3; Drebot tells the requester when a run is waiting there.

Reusable behavior belongs to the `drebot` and `drebot-drive-feedback` skills in Andre Skills.
Route prompts should point to the installed skill. Bot identity, requester identity, and the pinned
reply command are supplied by the bridge.

Pair once using a fresh link from T3's Connections settings:

```sh
node scripts/drebot/cli.mjs pair '<pairing-link>'
```

The credential is saved privately, with the previous credential archived recoverably. The bridge
uses `DREBOT_T3_URL`, the configured `t3Url`, the local T3 runtime origin, or the paired origin,
in that order. Hosted links with a `host` query parameter are supported.

## Post and inspect

The bridge automatically relays final answers only from turns started by Slack. A T3-only turn in a
mapped thread stays in T3. To post a progress update, write attributed text to a UTF-8 file:

```sh
node scripts/drebot/cli.mjs reply --thread-id <mapped-T3-id> --file <absolute-text-file>
node scripts/drebot/cli.mjs send --channel <channel-id> --file <absolute-text-file>
node scripts/drebot/cli.mjs send --channel <channel-id> --thread-ts <parent-ts> --file <absolute-text-file>
```

`send` also supports `--t3-thread` to link an existing T3 conversation. A T3 thread can be linked
to one Slack thread. Destinations must be configured routes and authorized by the existing private
`config/outward-send.json` policy. Commands report queued acceptance; `status` reports delivery issues.
An agent that already queued its final milestone returns `DREBOT_NO_REPLY` to suppress automatic relay.
Later delegated-task, background, PR-watch and restart continuations must explicitly use `reply`;
their answers are not automatically relayed. Coding inbox turns wait for their launched code threads.

Check `status` for actual Slack identity, T3 authentication, listener freshness, mappings, waiting
threads, recovery failures, and quarantined sends. T3 transport outages retry with stable command IDs.
Explicit command refusals wait for inspection; after fixing one, use `retry --event <event-id>`.

Slack writes with an unknown outcome are quarantined rather than retried. Inspect the Slack thread
before deciding to send again. Explicit rate limits honor Retry-After.

Recovery polls active mapped threads and linked threads with activity in the last 30 days, plus
recent roots with a 24-hour lookback for newly mentioned unlinked threads.
Set `mappedRecoveryWindowSeconds` and `recoveryWindowSeconds` to expand those windows. Messages before
activation or before a thread was linked are not replayed as new work. A new mention in an older,
unlinked root while the bridge is offline can fall outside this bounded recovery window.
An offline follow-up in a linked thread last active over 30 days ago can also fall outside it.

## Verify changes

```sh
node --test scripts/drebot/*.test.mjs
```

Then send a real DM or channel mention, verify a single T3 thread and an actual bot reply, and check a
follow-up in the same Slack thread. Stop the listener, send a follow-up, restart, and verify recovery.
Keep private tokens out of evidence and screenshots.
