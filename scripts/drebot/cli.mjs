import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { CONFIG, STATE } from "./paths.mjs";
import { t3Dispatch, t3Token, t3Pair } from "./t3.mjs";
import { BridgeStore, collectReplies, dispatchPending, flushPosts, routeEvent } from "./bridge.mjs";
import { slackApi, slackPages } from "./slack.mjs";

const CONFIG_FILE = NodePath.join(CONFIG, "drebot.json");
const DB_FILE = NodePath.join(STATE, "drebot.sqlite");
const LOCK_FILE = NodePath.join(STATE, "drebot.lock");
const RUNTIME_FILE = NodePath.join(STATE, "drebot-runtime.json");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const CLI = `DREBOT_STATE=${quote(STATE)} ${quote(process.execPath)} ${quote(NodeURL.fileURLToPath(new URL("./cli.mjs", import.meta.url)))}`;
const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

/** Require explicit owner-only routes before connecting to the personal T3 environment. */
export function readDrebotConfig(file = CONFIG_FILE) {
  const config = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  if (
    !/^T[A-Z0-9]+$/.test(config.teamId || "") ||
    !/^U[A-Z0-9]+$/.test(config.botUserId || "") ||
    !config.botToken?.startsWith("xoxb-") ||
    !config.appToken?.startsWith("xapp-") ||
    !Number(config.activatedAt)
  )
    throw new Error(`Invalid Drebot identity or tokens in ${file}`);
  if (
    !/^U[A-Z0-9]+$/.test(config.ownerUserId || "") ||
    !Array.isArray(config.allowedUsers) ||
    !config.allowedUsers.length
  )
    throw new Error("Drebot requires an ownerUserId and an explicit allowedUsers list");
  if (config.allowedUsers.some((user) => user !== config.ownerUserId))
    throw new Error(
      "The personal Drebot bridge admits only its owner; coworkers require an isolated worker",
    );
  for (const route of [
    ...(config.allowDms ? [config.defaultRoute] : []),
    ...Object.values(config.channels || {}),
  ]) {
    const effort = route?.modelSelection?.options?.find((option) =>
      ["effort", "reasoningEffort", "reasoning"].includes(option.id),
    );
    const allowed = route?.allowedUsers || config.allowedUsers;
    if (
      !route?.projectId ||
      !route.modelSelection?.instanceId ||
      !route.modelSelection?.model ||
      !effort?.value ||
      !route.workspaceStrategy?.type ||
      !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
        route.runtimeMode,
      ) ||
      !Array.isArray(allowed) ||
      !allowed.length
    )
      throw new Error(
        `Each Drebot route needs explicit project, model, effort, workspace, runtimeMode, and allowedUsers in ${file}`,
      );
    if (allowed.some((user) => user !== config.ownerUserId))
      throw new Error(
        "The personal Drebot bridge admits only its owner; coworkers require an isolated worker",
      );
  }
  return config;
}

function takeLock() {
  const id = NodeCrypto.randomUUID();
  let bootId;
  try {
    bootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (NodeFS.existsSync(LOCK_FILE)) {
    const previous = JSON.parse(NodeFS.readFileSync(LOCK_FILE, "utf8"));
    let alive = false;
    if (
      previous.pid !== process.pid &&
      !(bootId && previous.bootId && bootId !== previous.bootId)
    ) {
      try {
        process.kill(previous.pid, 0);
        alive = true;
      } catch (error) {
        if (error.code !== "ESRCH")
          throw new Error(
            "Drebot cannot verify the existing lock owner; inspect it before restarting",
            {
              cause: error,
            },
          );
      }
    }
    if (alive) throw new Error(`Drebot is already running as PID ${previous.pid}`);
    NodeFS.unlinkSync(LOCK_FILE);
  }
  const fd = NodeFS.openSync(LOCK_FILE, "wx", 0o600);
  NodeFS.writeFileSync(fd, JSON.stringify({ id, pid: process.pid, bootId }));
  NodeFS.closeSync(fd);
  return () => {
    if (JSON.parse(NodeFS.readFileSync(LOCK_FILE, "utf8")).id === id) NodeFS.unlinkSync(LOCK_FILE);
  };
}

/** Recover missed messages without advancing past an incomplete channel sweep. */
export async function catchUp(
  config,
  store,
  ingest,
  api = slackApi,
  { fullMapped = true, signal, startedAt = String(Date.now() / 1000) } = {},
) {
  signal?.throwIfAborted();
  const recovery = `recovery:${fullMapped ? "full" : "fast"}`;
  const channels = new Set(Object.keys(config.channels || {}));
  if (config.allowDms) {
    try {
      for (const channel of await slackPages(
        "conversations.list",
        { types: "im", exclude_archived: true },
        config.botToken,
        api,
        undefined,
        signal,
      ))
        if (channel.user === config.ownerUserId) channels.add(channel.id);
      signal?.throwIfAborted();
      store.health(`${recovery}:discovery`, "");
      if (fullMapped) store.health("recovery:discovery", "");
    } catch (error) {
      signal?.throwIfAborted();
      store.health(`${recovery}:discovery`, error.message);
    }
    for (const channel of store.dmChannels(config.ownerUserId)) channels.add(channel);
  }
  const failures = [];
  for (const channel of channels) {
    signal?.throwIfAborted();
    try {
      const { history: since, mapped: mappedSince } = store.initializeRecovery(
        channel,
        config.activatedAt,
        startedAt,
      );
      // Fast history polling must not move past replies in threads reserved for the slower sweep.
      const through = String(Date.now() / 1000);
      const window = Number(config.recoveryWindowSeconds) || 86400;
      const mappedWindow = Number(config.mappedRecoveryWindowSeconds) || 30 * 86400;
      const oldest = String(
        Math.max(Number(config.activatedAt), Math.min(Number(since), Number(through) - window)),
      );
      const messages = await slackPages(
        "conversations.history",
        { channel, oldest, latest: through },
        config.botToken,
        api,
        undefined,
        signal,
      );
      signal?.throwIfAborted();
      const roots = new Set(
        messages
          .filter(
            (message) =>
              message.reply_count && Number(message.latest_reply || through) >= Number(since),
          )
          .map((message) => message.ts),
      );
      for (const message of messages
        .filter((row) => Number(row.ts) >= Number(since))
        .sort((a, b) => Number(a.ts) - Number(b.ts))) {
        signal?.throwIfAborted();
        ingest({
          team_id: config.teamId,
          event: { ...message, channel, channel_type: channel.startsWith("D") ? "im" : "channel" },
        });
      }
      for (const conversation of store.conversations().filter((row) => row.channel === channel)) {
        signal?.throwIfAborted();
        if (
          conversation.root_ts &&
          ((conversation.launched && conversation.watching) ||
            store.lastActivity(conversation) >
              Number(through) - (fullMapped ? mappedWindow : window))
        )
          roots.add(conversation.root_ts);
      }
      for (const root of roots) {
        signal?.throwIfAborted();
        const linked = store.bySlack(channel, root);
        const healthId = `recovery:root:${channel}:${root}`;
        const oldestReply = String(
          Math.max(
            Number(fullMapped && linked ? mappedSince : since),
            Number(linked?.start_ts || 0),
          ),
        );
        let replies;
        try {
          replies = await slackPages(
            "conversations.replies",
            {
              channel,
              ts: root,
              oldest: oldestReply,
              latest: through,
            },
            config.botToken,
            api,
            undefined,
            signal,
          );
          signal?.throwIfAborted();
          store.health(healthId, "");
        } catch (error) {
          signal?.throwIfAborted();
          if (
            !error.refused ||
            error.message !== "Slack refused conversations.replies: thread_not_found"
          )
            throw error;
          store.health(healthId, error.message);
          continue;
        }
        for (const reply of replies
          .filter((row) => Number(row.ts) >= Number(oldestReply))
          .sort((a, b) => Number(a.ts) - Number(b.ts))) {
          signal?.throwIfAborted();
          ingest({
            team_id: config.teamId,
            event: {
              ...reply,
              thread_ts: root,
              channel,
              channel_type: channel.startsWith("D") ? "im" : "channel",
            },
          });
        }
      }
      signal?.throwIfAborted();
      store.setCursor(`history:${channel}`, through);
      if (fullMapped) store.setCursor(`mapped:${channel}`, through);
      store.health(`${recovery}:${channel}`, "");
      if (fullMapped) store.health(`recovery:${channel}`, "");
    } catch (error) {
      signal?.throwIfAborted();
      store.health(`${recovery}:${channel}`, error.message);
      failures.push({ channel, error: error.message });
    }
  }
  signal?.throwIfAborted();
  if (fullMapped && !failures.length) store.health("recovery", "");
  return failures;
}

/** Drain intake, observe Slack-started runs, then deliver their queued replies. */
export async function bridgeTick(config, store, rpc, api, cli = CLI, logger = log) {
  await dispatchPending(store, rpc, cli, logger, config.ownerUserId, config.botUserId);
  for (const conversation of store.conversations().filter((row) => row.launched && row.watching)) {
    try {
      const projection = await rpc("orchestration.getThreadProjection", {
        threadId: conversation.thread_id,
      });
      store.health(`thread:${conversation.thread_id}`, "");
      collectReplies(store, conversation, projection);
    } catch (error) {
      store.health(`thread:${conversation.thread_id}`, error.message);
      logger(`Thread check failed: ${conversation.thread_id}: ${error.message}`);
    }
  }
  await flushPosts(store, api, config, logger);
}

async function watch(config, store) {
  const release = takeLock();
  const startedAt = String(Date.now() / 1000);
  const recoveryStop = new AbortController();
  let socket,
    timer,
    reconnectTimer,
    stopping = false,
    busy = false,
    backoff = 1000,
    connected = false,
    recovering = false,
    fullRecoveryPending = false,
    recoveredAt = 0,
    mappedRecoveredAt = 0;
  const pending = new Set();
  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  let stopped;
  const stopRequested = new Promise((resolve) => {
    stopped = resolve;
  });
  store.recoverInterruptedSends();
  const runtime = () =>
    NodeFS.writeFileSync(
      RUNTIME_FILE,
      JSON.stringify({
        pid: process.pid,
        connected,
        updatedAt: new Date().toISOString(),
        source: NodeURL.fileURLToPath(import.meta.url),
      }) + "\n",
      { mode: 0o600 },
    );
  const ingest = (payload) => {
    const event = payload.event;
    if (
      payload.team_id === config.teamId &&
      event?.user === config.ownerUserId &&
      event.channel &&
      (config.channels?.[event.channel] || (config.allowDms && event.channel.startsWith("D")))
    )
      store.initializeRecovery(event.channel, config.activatedAt, startedAt);
    const routed = routeEvent(payload, config, store);
    if (!routed) return;
    const result = store.record(routed.event, routed.route, config.teamId);
    if (result.inserted) log(`Recorded Slack message ${result.eventId}`);
  };
  const recover = (fullMapped = false) => {
    fullRecoveryPending ||= fullMapped;
    if (recovering || stopping) return;
    fullMapped = fullRecoveryPending;
    fullRecoveryPending = false;
    recovering = true;
    track(
      catchUp(config, store, ingest, slackApi, {
        fullMapped,
        startedAt,
        signal: recoveryStop.signal,
      }),
    )
      .then(() => store.health(`recovery:${fullMapped ? "full" : "fast"}`, ""))
      .catch((error) => {
        if (!stopping) store.health(`recovery:${fullMapped ? "full" : "fast"}`, error.message);
      })
      .finally(() => {
        recovering = false;
        recoveredAt = Date.now();
        if (fullMapped) mappedRecoveredAt = recoveredAt;
        if (fullRecoveryPending && !stopping) recover();
      });
  };
  const tick = () =>
    track(
      (async () => {
        if (busy || stopping) return;
        busy = true;
        try {
          await bridgeTick(config, store, t3Dispatch, slackApi);
          const now = Date.now();
          const fullMapped = now - mappedRecoveredAt >= 30 * 60000;
          if (!recovering && (fullMapped || now - recoveredAt >= 60000)) recover(fullMapped);
          runtime();
        } catch (error) {
          log(`Bridge check failed: ${error.message}`);
        } finally {
          busy = false;
          if (!stopping) timer = setTimeout(tick, 3000);
        }
      })(),
    );
  const connect = () =>
    track(
      (async () => {
        if (stopping) return;
        try {
          const result = await slackApi("apps.connections.open", {}, config.appToken);
          if (stopping) return;
          const connection = new WebSocket(result.url);
          socket = connection;
          connection.addEventListener("open", () => {
            if (stopping) {
              connection.close();
              return;
            }
            connected = true;
            backoff = 1000;
            runtime();
            log("Drebot Socket Mode connected");
            recover(true);
          });
          connection.addEventListener("message", ({ data }) => {
            let envelope;
            try {
              envelope = JSON.parse(data);
            } catch {
              return;
            }
            try {
              if (envelope.type === "events_api") ingest(envelope.payload);
              // Persist before acknowledgment so an unwritable inbox remains eligible for redelivery.
              if (envelope.envelope_id)
                connection.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
              if (envelope.type === "disconnect") connection.close();
            } catch (error) {
              log(`Slack event was not acknowledged: ${error.message}`);
            }
          });
          connection.addEventListener("error", () => connection.close());
          connection.addEventListener("close", () => {
            if (socket === connection) {
              connected = false;
              runtime();
              reconnect();
            }
          });
        } catch (error) {
          log(`Socket Mode connection failed: ${error.message}`);
          reconnect();
        }
      })(),
    );
  const reconnect = () => {
    if (stopping) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(60000, backoff * 2);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    recoveryStop.abort();
    clearTimeout(timer);
    clearTimeout(reconnectTimer);
    socket?.close();
    connected = false;
    runtime();
    stopped();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for (const channel of Object.keys(config.channels || {}))
      store.initializeRecovery(channel, config.activatedAt, startedAt);
    const auth = await slackApi("auth.test", {}, config.botToken);
    if (auth.team_id !== config.teamId || auth.user_id !== config.botUserId)
      throw new Error("Slack bot identity does not match Drebot configuration");
    await t3Dispatch("server.getConfig", {});
    log(
      `Drebot ready as ${auth.user_id}; routing ${Object.keys(config.channels || {}).length} channel(s) and ${config.allowDms ? "DMs" : "no DMs"}`,
    );
    await connect();
    await tick();
    await stopRequested;
  } finally {
    stop();
    // Keep the lock and SQLite open until every accepted event and in-flight send has finished.
    await Promise.allSettled(pending);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    release();
    store.close();
  }
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? "" : args[index + 1] || "";
}

/** Operate the private bridge state selected before this module is loaded. */
export async function runDrebot(args) {
  const [command = "status"] = args;
  if (command === "--help" || command === "help") {
    console.log(
      "drebot watch | status | pair <link> | reply --thread-id <T3-id> --file <text> | send --channel <id> [--thread-ts <ts>] [--t3-thread <id>] --file <text> | retry --event <id>",
    );
    return;
  }
  if (command === "pair") {
    const result = await t3Pair(args[1]);
    if (!result.ok) throw new Error(result.why);
    console.log(JSON.stringify(result));
    return;
  }
  const config = readDrebotConfig();
  const store = new BridgeStore(DB_FILE);
  try {
    if (command === "watch") {
      await watch(config, store);
      return;
    }
    if (command === "status") {
      const auth = await slackApi("auth.test", {}, config.botToken);
      let runtime = null;
      try {
        runtime = JSON.parse(NodeFS.readFileSync(RUNTIME_FILE, "utf8"));
        process.kill(runtime.pid, 0);
      } catch {
        runtime = null;
      }
      const token = t3Token();
      let t3Connected = false,
        t3Error;
      try {
        await t3Dispatch("server.getConfig", {});
        t3Connected = true;
      } catch (error) {
        t3Error = error.message;
      }
      console.log(
        JSON.stringify(
          {
            appId: config.appId,
            botUserId: auth.user_id,
            teamId: auth.team_id,
            runtime,
            t3Credential: {
              configured: !!token,
              connected: t3Connected,
              error: t3Error,
              expired: token?.expired,
              expiresAt: token?.expiresAt,
            },
            channels: Object.keys(config.channels || {}),
            conversations: store.conversations().map((row) => ({
              channel: row.channel,
              rootTs: row.root_ts,
              threadId: row.thread_id,
            })),
            issues: store.issues(),
          },
          null,
          2,
        ),
      );
    } else if (command === "reply") {
      const conversation = store.byThread(flag(args, "--thread-id"));
      if (!conversation) throw new Error("This T3 thread has no Drebot Slack conversation");
      const text = NodeFS.readFileSync(flag(args, "--file"), "utf8");
      const id = store.enqueue(conversation, text);
      console.log(
        JSON.stringify({
          queued: true,
          id,
          channel: conversation.channel,
          threadTs: conversation.root_ts,
        }),
      );
    } else if (command === "send") {
      const channel = flag(args, "--channel"),
        rootTs = flag(args, "--thread-ts"),
        threadId = flag(args, "--t3-thread");
      if (!config.channels?.[channel]) throw new Error("Channel is not a configured Drebot route");
      const policy = JSON.parse(
        NodeFS.readFileSync(NodePath.join(CONFIG, "outward-send.json"), "utf8"),
      );
      if (!policy.postChannels?.[channel] && !(rootTs && policy.replyChannels?.[channel]))
        throw new Error("Outward-send policy does not authorize this destination");
      const text = NodeFS.readFileSync(flag(args, "--file"), "utf8");
      let conversation = rootTs ? store.bySlack(channel, rootTs) : null;
      if (conversation && threadId && conversation.thread_id !== threadId)
        throw new Error("This Slack thread is already linked to a different T3 thread");
      if (threadId && !conversation) {
        if (store.byThread(threadId))
          throw new Error("This T3 thread is already linked to another Slack conversation");
        await t3Dispatch("orchestration.getThreadProjection", { threadId });
      }
      if (rootTs) {
        conversation ||= store.register({
          id: `${config.teamId}:${channel}:${rootTs}`,
          channel,
          rootTs,
          ...(threadId && { threadId }),
          route: config.channels[channel],
          launched: !!threadId,
        });
        const id = store.enqueue(conversation, text);
        console.log(JSON.stringify({ queued: true, id, channel, threadTs: rootTs }));
      } else {
        conversation = store.register({
          id: `${config.teamId}:${channel}:outgoing:${NodeCrypto.randomUUID()}`,
          channel,
          rootTs: "",
          ...(threadId && { threadId }),
          route: config.channels[channel],
          launched: !!threadId,
        });
        const id = store.enqueue(conversation, text);
        console.log(JSON.stringify({ queued: true, id, channel }));
      }
    } else if (command === "retry") {
      const id = flag(args, "--event");
      const result = store.db
        .prepare(
          "UPDATE inbox SET status='pending',attempts=0,next_attempt=0,error=NULL WHERE id=? AND status='error'",
        )
        .run(id);
      if (!result.changes) throw new Error("No failed inbound event with that ID");
      console.log(`Queued retry of ${id}; the T3 command and message IDs are unchanged`);
    } else throw new Error(`Unknown Drebot command: ${command}`);
  } finally {
    if (command !== "watch") store.close();
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  runDrebot(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
