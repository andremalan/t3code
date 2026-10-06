import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { BridgeStore } from "./bridge.mjs";

const fixtureConfig = () => ({
  teamId: "TTEST",
  botUserId: "UBOT",
  ownerUserId: "UOWNER",
  botToken: "xoxb-fixture",
  appToken: "xapp-fixture",
  activatedAt: "1",
  allowedUsers: ["UOWNER"],
  allowDms: true,
  defaultRoute: {
    projectId: "project",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    },
    workspaceStrategy: { type: "root" },
    runtimeMode: "full-access",
  },
  channels: {},
});

NodeTest.test(
  "an agent's pinned reply reaches the service state despite a different environment",
  (t) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drebot-cli-"));
    t.after(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
    const state = NodePath.join(scratch, "service's state");
    const otherState = NodePath.join(scratch, "agent-state");
    const config = fixtureConfig();
    const route = config.defaultRoute;
    let threadId;
    for (const directory of [state, otherState]) {
      NodeFS.mkdirSync(NodePath.join(directory, "config"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(directory, "config/drebot.json"), JSON.stringify(config));
      const store = new BridgeStore(NodePath.join(directory, "drebot.sqlite"));
      threadId = store.record(
        { type: "message", channel: "DOWNER", user: "UOWNER", ts: "100", text: "fixture" },
        route,
        config.teamId,
      ).conversation.thread_id;
      store.close();
    }
    const source = `
    import { BridgeStore } from ${JSON.stringify(new URL("./bridge.mjs", import.meta.url).href)};
    import { bridgeTick } from ${JSON.stringify(new URL("./cli.mjs", import.meta.url).href)};
    const store = new BridgeStore(${JSON.stringify(NodePath.join(state, "drebot.sqlite"))});
    let prompt;
    await bridgeTick(${JSON.stringify(config)}, store, async (tag, payload) => {
      if (tag === 'orchestration.launchThread') prompt = payload.initialMessage.text;
      return { runs: [], messages: [] };
    }, async () => { throw new Error('Unexpected Slack write'); }, undefined, () => {});
    store.close();
    console.log(JSON.stringify(prompt.match(/Pinned Drebot command: (.*?)\\. Preserve/)[1]));
  `;
    const pinned = JSON.parse(
      NodeChildProcess.execFileSync(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, DREBOT_STATE: state },
        encoding: "utf8",
      }),
    );
    const messageFile = NodePath.join(scratch, "message.txt");
    NodeFS.writeFileSync(messageFile, "🤖 AI: Directed\n\nFixture milestone");
    const receipt = JSON.parse(
      NodeChildProcess.execFileSync(
        "/bin/sh",
        [
          "-c",
          `${pinned} reply --thread-id "$1" --file "$2"`,
          "drebot-fixture",
          threadId,
          messageFile,
        ],
        { env: { ...process.env, DREBOT_STATE: otherState }, encoding: "utf8" },
      ),
    );
    NodeAssert.equal(receipt.queued, true);
    for (const [directory, expected] of [
      [state, 1],
      [otherState, 0],
    ]) {
      const store = new BridgeStore(NodePath.join(directory, "drebot.sqlite"));
      NodeAssert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count,
        expected,
      );
      store.close();
    }
  },
);

NodeTest.test(
  "watch reclaims proven stale locks while preserving an unverified live owner",
  (t) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drebot-lock-"));
    t.after(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
    for (const mode of [
      "self",
      "live",
      "eperm",
      ...(NodeFS.existsSync("/proc/sys/kernel/random/boot_id") ? ["previous-boot"] : []),
    ]) {
      const state = NodePath.join(scratch, mode);
      NodeFS.mkdirSync(NodePath.join(state, "config"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(state, "config/drebot.json"),
        JSON.stringify(fixtureConfig()),
      );
      const source = `
      import fs from 'node:fs';
      const lock = ${JSON.stringify(NodePath.join(state, "drebot.lock"))};
      fs.writeFileSync(lock, JSON.stringify({ id: 'old', pid: ${mode === "self" ? "process.pid" : process.pid}, bootId: ${mode === "previous-boot" ? "'previous-boot'" : "undefined"} }));
      if (${JSON.stringify(mode)} === 'eperm') process.kill = () => { throw Object.assign(new Error('fixture'), {code: 'EPERM'}); };
      let networkAttempted = false;
      globalThis.fetch = async () => { networkAttempted = true; throw new Error('fixture network disabled'); };
      const { runDrebot } = await import(${JSON.stringify(new URL("./cli.mjs", import.meta.url).href)});
      let error;
      try { await runDrebot(['watch']); } catch (e) { error = e.message; }
      console.log(JSON.stringify({ error, networkAttempted, lockRemaining: fs.existsSync(lock) }));
    `;
      const result = JSON.parse(
        NodeChildProcess.execFileSync(process.execPath, ["--input-type=module", "-e", source], {
          env: { ...process.env, DREBOT_STATE: state },
          encoding: "utf8",
        }),
      );
      const stale = mode === "self" || mode === "previous-boot";
      NodeAssert.equal(result.networkAttempted, stale, mode);
      NodeAssert.equal(result.lockRemaining, !stale, mode);
      NodeAssert.match(
        result.error,
        stale
          ? /Slack transport failed/
          : mode === "eperm"
            ? /inspect it before restarting/
            : /already running/,
      );
    }
  },
);

NodeTest.test("recovery cancellation interrupts a rate-limit wait before retrying", async () => {
  const { slackPages } = await import("./slack.mjs");
  const controller = new AbortController();
  let calls = 0;
  let entered;
  const rateLimited = new Promise((resolve) => {
    entered = resolve;
  });
  const recovered = slackPages(
    "conversations.history",
    {},
    "fixture",
    async () => {
      calls++;
      entered();
      throw Object.assign(new Error("fixture rate limit"), { retryAfter: 3600 });
    },
    undefined,
    controller.signal,
  );
  await rateLimited;
  controller.abort();
  await NodeAssert.rejects(recovered, { name: "AbortError" });
  NodeAssert.equal(calls, 1);
});
