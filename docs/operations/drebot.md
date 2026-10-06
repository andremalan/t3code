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
choose another directory for every CLI invocation, including `pair` and `status`. Agent reply
commands pin the listener's absolute state directory. This default preserves the original HQ installation's credentials and
SQLite mappings during migration. Never commit this directory.

### Linux startup

Run the same CLI under a systemd user service. T3's `t3 service install` supervises T3 itself;
this fork also has `scripts/hq-linux.sh` for its checkout build. There is no configurable T3
app-start hook for arbitrary sidecars; `runOnWorktreeCreate` prepares individual worktrees.

Create `~/.config/systemd/user/drebot.service`, replacing the Node and checkout paths with their
absolute Linux paths. Pin Node 24, choose a private state directory, and set the actual T3 origin
in private configuration's `t3Url` so service, terminal and agent commands use the same environment:

```ini
[Unit]
Description=Drebot Slack bridge

[Service]
WorkingDirectory=%h
Environment=DREBOT_STATE=%h/.local/share/drebot
ExecStart=/absolute/path/to/node24 /absolute/path/to/t3code/scripts/drebot/cli.mjs watch
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
UMask=0077

[Install]
WantedBy=default.target
```

Put the private configuration in that state's `config` directory. Use the same state when pairing
and inspecting it from your terminal:

```sh
export DREBOT_STATE="$HOME/.local/share/drebot"
/absolute/path/to/node24 /absolute/path/to/t3code/scripts/drebot/cli.mjs pair '<fresh-Linux-pairing-link>'
/absolute/path/to/node24 /absolute/path/to/t3code/scripts/drebot/cli.mjs status
```

The listener checks T3 before connecting, so restart supervision also handles a boot race with T3.
Then run:

```sh
systemctl --user daemon-reload
systemctl --user enable --now drebot.service
journalctl --user -u drebot.service -f
```

Enable lingering with `loginctl enable-linger "$USER"` if the service should run without a login.
Stop with `systemctl --user stop drebot.service`; inspect status with `systemctl --user status drebot.service`.
On migration, stop the Mac listener before starting Linux. Use fresh bridge state unless the
corresponding T3 thread IDs were also migrated; copying mappings alone cannot restore their threads.
Fresh state and added or re-enabled routes begin intake when the listener starts seeing them. Older
requests and messages sent during a migration gap are not recovered automatically; ask Drebot again.
This service supervises transport; it does not provide coworker worker isolation.

Shutdown, including terminal close, cancels recovery reads and rate-limit waits, then drains accepted
work. Draining slow T3 commands or Slack writes can exceed the unit's stop timeout; inspect interrupted
delivery status after restart. Linux locks record the boot identity so a stale PID from a previous
boot can be reclaimed. A legacy lock without that
identity can still block startup if its PID was reused. If startup reports an existing or unverified
lock owner, stop supervision, inspect that process and the state directory, and archive the lock only
after verifying that no listener owns it. An unverified live lock is preserved.

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
  "t3Url": "http://127.0.0.1:3773",
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
    "runtimeMode": "full-access",
    "prompt": "Read the installed drebot skill and handle this request."
  },
  "channels": {}
}
```

Channel routes use the same shape, with `listen: "mentions"` or `listen: "all"`. A mapped
thread accepts later replies without another mention. This personal-environment adapter admits
only `ownerUserId`; every `allowedUsers` entry must match it. A broad or coworker allowlist fails
startup. Coworker replies in an existing owner thread also fail admission.
Restart the listener after disabling or re-enabling intake and other configuration changes. Disabling
a route discards its recovery progress, so requests posted while it was disabled are not replayed
when it returns. Active routes retain outage recovery. Current route authorization also applies to
existing mapped conversations; their project and model binding stays fixed. Slack Connect events
and events identifying a sender from another team are refused.

Choose a registered project, a live model and effort, workspace strategy, and runtime mode explicitly.
Use `{ "type": "worktree", "baseRef": "main", "startFromOrigin": true }` for a fresh coding worktree.
The owner-only bridge uses `full-access` so workflow replies can write message files and the private
queue outside a coding worktree. More restrictive modes require T3 approvals for that reply path;
server-started continuations are not automatically relayed to Slack while awaiting approval.
Repository rules and existing outward-send guards remain authoritative in either mode.

Coworker repository questions, coding threads and draft PRs require a separate worker environment
containing fresh clones of committed repository contents and its own task changes. Keep the owner's
home, dirty checkouts, private T3 history, personal connectors and bridge credentials outside it.
A worktree or `workspace-write` setting does not enforce read isolation. This adapter does not yet
provide that worker, so keep coworker intake disabled until its isolation and restricted draft-PR
publishing path pass real acceptance checks.

Reusable behavior belongs to the `drebot` and `drebot-drive-feedback` skills in Andre Skills.
Route prompts should point to the installed skill. Bot identity, requester identity, and the pinned
reply command, including its private state directory, are supplied by the bridge. Preserve the
whole pinned command in agent handoffs so replies reach the listener's queue.

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

Each channel's initial intake boundary is persisted before its first history request. Recovery
preserves that boundary on failures and uses saved cursors on later restarts.
Recovery checks channel history every minute and polls active T3 threads plus linked threads with
activity in the last 24 hours. Startup, Socket Mode reconnects, and a sweep every 30 minutes also
check linked threads with activity in the last 30 days. Activity includes accepted human messages
and delivered bot milestones. Separate cursors preserve older-thread replies between full sweeps;
a quiet linked thread can take up to 30 minutes to recover a missed reply while the listener stays
connected. Recovery passes run one at a time, so rate limits can extend those intervals.
Deleted thread roots remain visible in `status` without blocking recovery of other linked threads.
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
