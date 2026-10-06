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

For an interactive session, keep the listener in a visible terminal and stop it with Ctrl-C. It survives Slack reconnects and
recovers recent history on startup, but it does not run while the machine or terminal is off.

Private configuration and conversation mappings live under `~/tmp/cc`. Set `DREBOT_STATE` to
choose another directory. This default preserves the original HQ installation's credentials and
SQLite mappings during migration. Never commit this directory.

### Linux startup

Run the same CLI under a systemd user service. T3's `t3 service install` supervises T3 itself;
this fork also has `scripts/hq-linux.sh` for its checkout build. There is no configurable T3
app-start hook for arbitrary sidecars; `runOnWorktreeCreate` prepares individual worktrees.

Create `~/.config/systemd/user/drebot.service`, replacing the Node and checkout paths with their
absolute Linux paths. Pin Node 24, and choose the actual T3 origin and a private state directory:

```ini
[Unit]
Description=Drebot Slack bridge
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=%h
Environment=DREBOT_STATE=%h/.local/share/drebot
Environment=DREBOT_T3_URL=http://127.0.0.1:3773
ExecStart=/absolute/path/to/node24 /absolute/path/to/t3code/scripts/drebot/cli.mjs watch
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
UMask=0077

[Install]
WantedBy=default.target
```

Put the private configuration in that state's `config` directory and pair with the Linux T3
environment. The listener checks T3 before connecting, so restart supervision also handles a
boot race with T3. Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now drebot.service
journalctl --user -u drebot.service -f
```

Enable lingering with `loginctl enable-linger "$USER"` if the service should run without a login.
Stop with `systemctl --user stop drebot.service`; inspect status with `systemctl --user status drebot.service`.
On migration, stop the Mac listener before starting Linux. Use fresh bridge state unless the
corresponding T3 thread IDs were also migrated; copying mappings alone cannot restore their threads.
This service supervises transport; it does not provide coworker worker isolation.

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
thread accepts later replies without another mention. This personal-environment adapter admits
only `ownerUserId`; every `allowedUsers` entry must match it. A broad or coworker allowlist fails
startup. Coworker replies in an existing owner thread also fail admission.
Restart the listener after configuration changes. Current route authorization also applies to
existing mapped conversations; their project and model binding stays fixed. Slack Connect events
and events identifying a sender from another team are refused.

Choose a registered project, a live model and effort, workspace strategy, and runtime mode explicitly.
Use `{ "type": "worktree", "baseRef": "main", "startFromOrigin": true }` for isolated code work.
Approval requests stay in T3; Drebot tells the requester when a run is waiting there.

Coworker repository questions, coding threads and draft PRs require a separate worker environment
containing fresh clones of committed repository contents and its own task changes. Keep the owner's
home, dirty checkouts, private T3 history, personal connectors and bridge credentials outside it.
A worktree or `workspace-write` setting does not enforce read isolation. This adapter does not yet
provide that worker, so keep coworker intake disabled until its isolation and restricted draft-PR
publishing path pass real acceptance checks.

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
An agent that already queued its final milestone returns `DREBOT_NO_REPLY` as the first meaningful
line after any AI attribution to suppress automatic relay. Markdown emphasis is accepted; any
following internal notes also stay in T3.
Later delegated-task, background, PR-watch and restart continuations must explicitly use `reply`;
their answers are not automatically relayed. Coding inbox turns wait for their launched code threads.

Check `status` for actual Slack identity, T3 authentication, listener freshness, mappings, waiting
threads, recovery failures, and quarantined sends. T3 transport outages retry with stable command IDs.
Explicit command refusals wait for inspection; after fixing one, use `retry --event <event-id>`.

Slack writes with an unknown outcome are quarantined rather than retried. Inspect the Slack thread
before deciding to send again. Explicit rate limits honor Retry-After.

Recovery checks channel history every minute and polls watched threads plus linked threads with
activity in the last 24 hours. Startup, Socket Mode reconnects, and a sweep every 30 minutes also
check linked threads with activity in the last 30 days. Activity includes accepted human messages
and delivered bot milestones. Separate cursors preserve older-thread replies between full sweeps;
a quiet linked thread can take up to 30 minutes to recover a missed reply while the listener stays
connected. Recovery passes run one at a time, so rate limits can extend those intervals.
Set `mappedRecoveryWindowSeconds` and `recoveryWindowSeconds` to expand the full-sweep and fast/history
windows. Messages before activation or before a thread was linked are not replayed as new work.
A new mention in an older, unlinked root while the bridge is offline can fall outside the history
lookback. An offline follow-up in a linked thread last active over 30 days ago can also fall outside
the full sweep.

## Verify changes

```sh
node --test scripts/drebot/*.test.mjs
```

Then send a real DM or channel mention, verify a single T3 thread and an actual bot reply, and check a
follow-up in the same Slack thread. Stop the listener, send a follow-up, restart, and verify recovery.
Keep private tokens out of evidence and screenshots.
