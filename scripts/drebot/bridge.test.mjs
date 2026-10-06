import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  BridgeStore,
  collectReplies,
  dispatchPending,
  eventPrompt,
  flushPosts,
  routeEvent,
  stableId,
} from "./bridge.mjs";
import { bridgeTick, catchUp } from "./cli.mjs";
import { pairingCode } from "./t3.mjs";
import { slackPages } from "./slack.mjs";

const route = {
  projectId: "project",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
  workspaceStrategy: { type: "root" },
  runtimeMode: "auto-accept-edits",
};
const config = {
  teamId: "T123",
  botUserId: "U123",
  ownerUserId: "UHUMAN",
  allowedUsers: ["UHUMAN"],
  activatedAt: "1",
  allowDms: true,
  defaultRoute: route,
  channels: { C123: route },
  botToken: "test",
};
const event = {
  type: "message",
  user: "UHUMAN",
  channel: "C123",
  ts: "2.000001",
  text: "<@U123> help",
};
function fixture(t) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drebot-test-"));
  const store = new BridgeStore(NodePath.join(dir, "bridge.sqlite"));
  t.after(() => {
    store.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

NodeTest.test(
  "mention and message deliveries deduplicate durably and replies retain one T3 conversation",
  async (t) => {
    const store = fixture(t);
    const first = store.record(event, route, config.teamId);
    NodeAssert.equal(
      store.record({ ...event, type: "app_mention" }, route, config.teamId).inserted,
      false,
    );
    const calls = [];
    const rpc = async (tag, command) => {
      calls.push({ tag, command });
      if (calls.length === 1) throw new Error("Lost response after acceptance");
    };
    await dispatchPending(store, rpc, "drebot");
    store.db.prepare("UPDATE inbox SET next_attempt=0").run();
    await dispatchPending(store, rpc, "drebot");
    NodeAssert.deepEqual(calls[0], calls[1]);
    NodeAssert.equal(calls[1].command.reuseExistingThread, undefined);
    NodeAssert.deepEqual(calls[1].command.modelSelection, route.modelSelection);
    const reply = { ...event, ts: "3.000001", thread_ts: event.ts, text: "more context" };
    const routed = routeEvent({ team_id: config.teamId, event: reply }, config, store);
    NodeAssert.ok(routed);
    const second = store.record(reply, routed.route, config.teamId);
    NodeAssert.equal(second.conversation.thread_id, first.conversation.thread_id);
    await dispatchPending(store, rpc, "drebot");
    NodeAssert.equal(calls[2].tag, "orchestration.dispatchCommand");
    NodeAssert.equal(calls[2].command.dispatchMode.type, "queue_after_active");
    NodeAssert.equal(store.conversations().length, 1);
  },
);

NodeTest.test("hosted pairing links exchange against the backend host", () => {
  NodeAssert.deepEqual(
    pairingCode("https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.com%2F#token=TEST"),
    { code: "TEST", origin: "https://t3.example.com" },
  );
  NodeAssert.deepEqual(pairingCode("https://app.t3.codes/pair?host=file%3A%2F%2Ftmp#token=TEST"), {
    code: "",
    origin: "",
  });
});

NodeTest.test("authenticated owner identity is distinguished from other requesters", (t) => {
  const store = fixture(t);
  const { conversation } = store.record(event, route, config.teamId);
  NodeAssert.match(
    eventPrompt(event, conversation, route, "drebot", event.user),
    /sender is Andre, the configured owner/,
  );
  NodeAssert.match(
    eventPrompt(event, conversation, route, "drebot", "UOTHER"),
    /different requester from Andre/,
  );
});

NodeTest.test(
  "bot loops, wrong teams, edits, old events, and unmentioned channel posts do not launch work",
  (t) => {
    const store = fixture(t);
    for (const changed of [
      { bot_id: "B123" },
      { user: config.botUserId },
      { subtype: "message_changed" },
      { ts: "0" },
      { text: "hello" },
    ])
      NodeAssert.equal(
        routeEvent({ team_id: config.teamId, event: { ...event, ...changed } }, config, store),
        null,
      );
    NodeAssert.equal(routeEvent({ team_id: "TOTHER", event }, config, store), null);
    NodeAssert.ok(
      routeEvent(
        {
          team_id: config.teamId,
          event: { ...event, channel: "D123", channel_type: "im", text: "hello" },
        },
        config,
        store,
      ),
    );
  },
);

NodeTest.test(
  "final output is relayed once and accepted messages remain watched until projected",
  async (t) => {
    const store = fixture(t);
    const recorded = store.record(event, route, config.teamId);
    store.dispatched(store.pending()[0]);
    let conversation = store.conversation(recorded.conversation.id);
    collectReplies(store, conversation, { runs: [], messages: [] });
    NodeAssert.equal(store.conversation(conversation.id).watching, 1);
    const projection = {
      runs: [
        { id: "run1", status: "completed", userMessageId: stableId(`message:${recorded.eventId}`) },
      ],
      messages: [
        { role: "assistant", runId: "run1", text: "progress", streaming: false },
        { role: "assistant", runId: "run1", text: "Done", streaming: false },
      ],
    };
    collectReplies(store, conversation, projection);
    collectReplies(store, conversation, projection);
    NodeAssert.equal(store.pendingPosts().length, 1);
    NodeAssert.match(store.pendingPosts()[0].text, /^🤖 AI: Directed\n\nDone$/);
    NodeAssert.equal(store.conversation(conversation.id).watching, 0);
    const calls = [];
    await flushPosts(
      store,
      async (...args) => {
        calls.push(args);
        return { ts: "4" };
      },
      config,
    );
    await flushPosts(
      store,
      async (...args) => {
        calls.push(args);
        return { ts: "5" };
      },
      config,
    );
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0][1].thread_ts, event.ts);
  },
);

NodeTest.test(
  "unknown write outcomes are quarantined while explicit rate limits retry",
  async (t) => {
    const store = fixture(t);
    const { conversation } = store.record(event, route, config.teamId);
    const unknown = store.enqueue(conversation, "first");
    let count = 0;
    await flushPosts(
      store,
      async () => {
        count++;
        throw new Error("Connection lost");
      },
      config,
    );
    await flushPosts(
      store,
      async () => {
        count++;
        return { ts: "4" };
      },
      config,
    );
    NodeAssert.equal(count, 1);
    NodeAssert.equal(store.issues().outbox[0].id, unknown);
    const rate = store.enqueue(conversation, "second");
    await flushPosts(
      store,
      async () => {
        throw Object.assign(new Error("rate"), { retryAfter: 2 });
      },
      config,
    );
    NodeAssert.equal(
      store.db.prepare("SELECT status FROM outbox WHERE id=?").get(rate).status,
      "pending",
    );
    NodeAssert.equal(store.pendingPosts().length, 0);
    store.db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(rate);
    const reader = new BridgeStore(NodePath.join(store.db.location(), "..", "bridge.sqlite"));
    reader.close();
    NodeAssert.equal(
      store.db.prepare("SELECT status FROM outbox WHERE id=?").get(rate).status,
      "sending",
    );
    store.recoverInterruptedSends();
    NodeAssert.equal(
      store.db.prepare("SELECT status FROM outbox WHERE id=?").get(rate).status,
      "uncertain",
    );
  },
);

NodeTest.test(
  "gap recovery retains its cursor when pagination fails and catches mapped replies",
  async (t) => {
    const store = fixture(t);
    store.record(event, route, config.teamId);
    store.setCursor("history:C123", "2");
    const cfg = { ...config, allowDms: false };
    NodeAssert.match(
      (
        await catchUp(
          cfg,
          store,
          () => {},
          async () => ({ messages: [], has_more: true }),
        )
      )[0].error,
      /incomplete history/,
    );
    NodeAssert.equal(store.cursor("history:C123"), "2");
    const ingested = [];
    await catchUp(
      cfg,
      store,
      (value) => ingested.push(value.event),
      async (method) => ({
        messages:
          method === "conversations.history" ? [] : [{ ...event, ts: "3", thread_ts: event.ts }],
      }),
    );
    NodeAssert.equal(ingested[0].thread_ts, event.ts);
    NodeAssert.ok(Number(store.cursor("history:C123")) > 2);
  },
);

NodeTest.test("only explicitly allowed requesters can start agent work", (t) => {
  const store = fixture(t);
  NodeAssert.equal(
    routeEvent(
      {
        team_id: config.teamId,
        event: { ...event, user: "USTRANGER", channel: "D123", channel_type: "im" },
      },
      config,
      store,
    ),
    null,
  );
  const shared = { ...config, channels: { C123: { ...route, allowedUsers: ["*"] } } };
  NodeAssert.ok(
    routeEvent({ team_id: config.teamId, event: { ...event, user: "USTRANGER" } }, shared, store),
  );
});

NodeTest.test(
  "private T3 runs are never relayed and malformed replies do not block another conversation",
  async (t) => {
    const store = fixture(t);
    const first = store.record(event, route, config.teamId);
    const second = store.record({ ...event, ts: "3", thread_ts: "3" }, route, config.teamId);
    await dispatchPending(store, async () => {}, "drebot");
    const calls = [];
    await bridgeTick(
      config,
      store,
      async (_tag, { threadId }) => ({
        runs: [
          { id: "private", status: "completed", userMessageId: "PRIVATE" },
          {
            id: threadId,
            status: "completed",
            userMessageId: stableId(
              `message:${threadId === first.conversation.thread_id ? first.eventId : second.eventId}`,
            ),
          },
        ],
        messages: [
          { runId: "private", role: "assistant", text: "Private T3-only note" },
          {
            runId: threadId,
            role: "assistant",
            text: threadId === first.conversation.thread_id ? "x".repeat(40000) : "Valid reply",
          },
        ],
      }),
      async (_method, params) => {
        calls.push(params);
        return { ts: "4" };
      },
      "drebot",
      () => {},
    );
    NodeAssert.equal(calls.length, 2);
    NodeAssert.ok(calls.some((row) => row.text.includes("Valid reply")));
    NodeAssert.ok(calls.every((row) => !row.text.includes("Private T3-only note")));
    NodeAssert.equal(store.issues().health.length, 1);
  },
);

NodeTest.test(
  "link boundaries reject earlier recovered messages and a second Slack mapping is refused",
  (t) => {
    const store = fixture(t);
    const linked = store.record({ ...event, ts: "10", thread_ts: "2" }, route, config.teamId);
    NodeAssert.equal(
      routeEvent(
        { team_id: config.teamId, event: { ...event, ts: "3", thread_ts: "2" } },
        config,
        store,
      ),
      null,
    );
    NodeAssert.throws(
      () =>
        store.register({
          id: "second",
          channel: "C123",
          rootTs: "11",
          threadId: linked.conversation.thread_id,
          route,
        }),
      /already linked/,
    );
  },
);

NodeTest.test("a failed root blocks a follow-up until the root is dispatched", async (t) => {
  const store = fixture(t);
  store.record(event, route, config.teamId);
  store.record({ ...event, ts: "3", thread_ts: event.ts }, route, config.teamId);
  const calls = [];
  await dispatchPending(
    store,
    async (_tag, command) => {
      calls.push(command);
      throw new Error("offline");
    },
    "drebot",
  );
  await dispatchPending(store, async (_tag, command) => calls.push(command), "drebot");
  NodeAssert.equal(calls.length, 1);
  store.db.prepare("UPDATE inbox SET next_attempt=0").run();
  await dispatchPending(store, async (_tag, command) => calls.push(command), "drebot");
  await dispatchPending(store, async (_tag, command) => calls.push(command), "drebot");
  NodeAssert.equal(calls.length, 3);
  NodeAssert.ok(calls[1].initialMessage);
  NodeAssert.equal(calls[2].type, "message.dispatch");
});

NodeTest.test(
  "history read rate limits honor Retry-After and recovery isolates failing channels",
  async (t) => {
    let attempts = 0;
    const waits = [];
    await slackPages(
      "conversations.history",
      {},
      "test",
      async () => {
        if (!attempts++) throw Object.assign(new Error("rate"), { retryAfter: 2 });
        return { messages: [] };
      },
      async (ms) => waits.push(ms),
    );
    NodeAssert.deepEqual(waits, [2000]);
    const store = fixture(t);
    const ingested = [];
    await catchUp(
      { ...config, allowDms: false, channels: { C123: route, C456: route } },
      store,
      (payload) => ingested.push(payload.event),
      async (_method, { channel }) => {
        if (channel === "C123") throw new Error("forbidden");
        return { messages: [{ ...event, channel: "C456" }] };
      },
    );
    NodeAssert.equal(store.cursor("history:C123", "1"), "1");
    NodeAssert.ok(Number(store.cursor("history:C456")) > 1);
    NodeAssert.equal(ingested[0].channel, "C456");
  },
);

NodeTest.test(
  "offline mentions in recently active unlinked threads are recovered without their older replies",
  async (t) => {
    const store = fixture(t);
    const cfg = { ...config, allowDms: false };
    const ingested = [];
    await catchUp(
      cfg,
      store,
      (payload) => {
        const routed = routeEvent(payload, cfg, store);
        if (routed) {
          store.record(routed.event, routed.route, cfg.teamId);
          ingested.push(payload.event.ts);
        }
      },
      async (method) => ({
        messages:
          method === "conversations.history"
            ? [{ ...event, text: "not for bot", reply_count: 2, latest_reply: "10" }]
            : [
                { ...event, ts: "3", text: "side note" },
                { ...event, ts: "10" },
              ],
      }),
    );
    NodeAssert.deepEqual(ingested, ["10"]);
    NodeAssert.equal(store.conversations()[0].start_ts, "10");
  },
);

NodeTest.test(
  "queued top-level posts acquire a Slack root and future replies retain their mapping",
  async (t) => {
    const store = fixture(t);
    const conversation = store.register({
      id: "outgoing",
      channel: "C123",
      rootTs: "",
      route,
      startTs: "2",
    });
    store.enqueue(conversation, "An update");
    await flushPosts(
      store,
      async (_method, params) => {
        NodeAssert.equal(params.thread_ts, undefined);
        return { ts: "3" };
      },
      config,
    );
    const routed = routeEvent(
      { team_id: config.teamId, event: { ...event, ts: "4", thread_ts: "3", text: "follow-up" } },
      config,
      store,
    );
    NodeAssert.ok(routed);
    NodeAssert.equal(
      store.record(routed.event, routed.route, config.teamId).conversation.id,
      "outgoing",
    );
  },
);

NodeTest.test("stopped runs never disclose progress and empty completed runs stop polling", (t) => {
  const store = fixture(t);
  const recorded = store.record(event, route, config.teamId);
  store.dispatched(store.pending()[0]);
  const conversation = store.conversation(recorded.conversation.id);
  const runs = ["interrupted", "cancelled", "failed"].map((status) => ({
    id: status,
    status,
    userMessageId: stableId(`message:${recorded.eventId}`),
  }));
  collectReplies(store, conversation, {
    runs,
    messages: runs.map((run) => ({
      role: "assistant",
      runId: run.id,
      text: "PRIVATE progress narration",
    })),
  });
  NodeAssert.equal(store.pendingPosts().length, 3);
  NodeAssert.ok(store.pendingPosts().every((row) => !row.text.includes("PRIVATE")));
  collectReplies(store, conversation, {
    runs: [{ id: "empty", status: "completed", userMessageId: runs[0].userMessageId }],
    messages: [],
  });
  NodeAssert.equal(store.conversation(conversation.id).watching, 0);
  NodeAssert.match(store.issues().health[0].error, /no answer text/);
});

NodeTest.test("existing conversations obey narrowed and removed live routes", (t) => {
  const store = fixture(t);
  const shared = { ...route, allowedUsers: ["*"] };
  store.record(event, shared, config.teamId);
  const follow = { ...event, ts: "3", thread_ts: event.ts, user: "USTRANGER" };
  NodeAssert.equal(routeEvent({ team_id: config.teamId, event: follow }, config, store), null);
  NodeAssert.equal(
    routeEvent(
      { team_id: config.teamId, event: { ...follow, user: "UHUMAN" } },
      { ...config, channels: {} },
      store,
    ),
    null,
  );
  store.record({ ...event, channel: "D123", channel_type: "im" }, shared, config.teamId);
  NodeAssert.equal(
    routeEvent(
      {
        team_id: config.teamId,
        event: { ...follow, user: "UHUMAN", channel: "D123", channel_type: "im" },
      },
      { ...config, allowDms: false },
      store,
    ),
    null,
  );
  const open = { ...config, channels: { C123: shared } };
  NodeAssert.equal(
    routeEvent({ team_id: config.teamId, is_ext_shared_channel: true, event: follow }, open, store),
    null,
  );
  NodeAssert.equal(
    routeEvent(
      { team_id: config.teamId, event: { ...follow, user_team: "TFOREIGN" } },
      open,
      store,
    ),
    null,
  );
});

NodeTest.test("quiet mapped threads recover a recent reply after a short outage", async (t) => {
  const store = fixture(t);
  const now = Date.now() / 1000;
  const root = String(now - 3 * 86400);
  const recorded = store.record({ ...event, ts: root }, route, config.teamId);
  store.db.prepare("UPDATE conversations SET watching=0 WHERE id=?").run(recorded.conversation.id);
  store.setCursor("history:C123", String(now - 600));
  const ingested = [],
    calls = [];
  await catchUp(
    { ...config, allowDms: false },
    store,
    (payload) => ingested.push(payload.event),
    async (method) => {
      calls.push(method);
      return {
        messages:
          method === "conversations.replies"
            ? [{ ...event, ts: String(now - 300), thread_ts: root }]
            : [],
      };
    },
  );
  NodeAssert.ok(calls.includes("conversations.replies"));
  NodeAssert.equal(ingested[0].thread_ts, root);
});

NodeTest.test(
  "transient T3 downtime remains retriable while explicit command refusal is quarantined",
  async (t) => {
    const store = fixture(t);
    const recorded = store.record(event, route, config.teamId);
    for (let attempt = 0; attempt < 7; attempt++) {
      store.db.prepare("UPDATE inbox SET next_attempt=0").run();
      await dispatchPending(
        store,
        async () => {
          throw new Error("T3 offline");
        },
        "drebot",
      );
    }
    NodeAssert.equal(store.issues().inbox[0].status, "pending");
    store.db.prepare("UPDATE inbox SET next_attempt=0").run();
    await dispatchPending(store, async () => {}, "drebot");
    NodeAssert.equal(store.issues().inbox.length, 0);
    const next = store.record({ ...event, ts: "3", thread_ts: event.ts }, route, config.teamId);
    await dispatchPending(
      store,
      async () => {
        throw Object.assign(new Error("invalid command"), { refused: true });
      },
      "drebot",
    );
    NodeAssert.equal(store.issues().inbox[0].id, next.eventId);
    NodeAssert.equal(store.issues().inbox[0].status, "error");
    NodeAssert.ok(store.conversation(recorded.conversation.id).launched);
  },
);

NodeTest.test("attributed and punctuated no-reply sentinels suppress duplicate posts", (t) => {
  const store = fixture(t);
  const recorded = store.record(event, route, config.teamId);
  store.dispatched(store.pending()[0]);
  const conversation = store.conversation(recorded.conversation.id);
  const finals = ["🤖 AI: Directed\n\nDREBOT_NO_REPLY", "`DREBOT_NO_REPLY`", "DREBOT_NO_REPLY."];
  collectReplies(store, conversation, {
    runs: finals.map((_, i) => ({
      id: String(i),
      status: "completed",
      userMessageId: stableId(`message:${recorded.eventId}`),
    })),
    messages: finals.map((text, i) => ({ role: "assistant", runId: String(i), text })),
  });
  NodeAssert.equal(store.pendingPosts().length, 0);
  NodeAssert.match(eventPrompt(event, conversation, route, "drebot"), /later delegated-task/);
});
