import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { BridgeStore } from "./bridge.mjs";

NodeTest.test(
  "an agent's pinned reply reaches the service state despite a different environment",
  (t) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drebot-cli-"));
    t.after(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
    const state = NodePath.join(scratch, "service's state");
    const otherState = NodePath.join(scratch, "agent-state");
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
      teamId: "TTEST",
      botUserId: "UBOT",
      ownerUserId: "UOWNER",
      botToken: "xoxb-fixture",
      appToken: "xapp-fixture",
      activatedAt: "1",
      allowedUsers: ["UOWNER"],
      allowDms: true,
      defaultRoute: route,
      channels: {},
    };
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
