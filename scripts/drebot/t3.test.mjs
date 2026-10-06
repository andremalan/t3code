import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("standalone Drebot T3 authentication and RPC", async (t) => {
  const previousState = process.env.DREBOT_STATE;
  const previousUrl = process.env.DREBOT_T3_URL;
  NodeFS.mkdirSync(NodePath.join(NodeOS.homedir(), "tmp"), { recursive: true });
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.homedir(), "tmp", "drebot-t3-test-"));
  process.env.DREBOT_STATE = scratch;
  delete process.env.DREBOT_T3_URL;
  const { STATE, CONFIG } = await import("./paths.mjs");
  const { T3_TOKEN_FILE, pairingCode, t3Token, t3Pair, t3Dispatch } = await import("./t3.mjs");
  const credential = {
    token: "fake-private-bearer",
    expiresAt: "2099-01-01T00:00:00Z",
    origin: "https://saved.example.test",
  };
  const saveCredential = (record = credential) => {
    NodeFS.mkdirSync(CONFIG, { recursive: true });
    NodeFS.writeFileSync(T3_TOKEN_FILE, JSON.stringify(record), { mode: 0o600 });
  };
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const accessToken = {
    access_token: "fake-new-bearer",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "orchestration:read",
  };
  t.afterEach(() => {
    t.mock.restoreAll();
    NodeModule.syncBuiltinESMExports();
    delete process.env.DREBOT_T3_URL;
    for (const name of NodeFS.readdirSync(scratch))
      NodeFS.rmSync(NodePath.join(scratch, name), { recursive: true, force: true });
  });
  t.after(() => {
    if (previousState === undefined) delete process.env.DREBOT_STATE;
    else process.env.DREBOT_STATE = previousState;
    if (previousUrl === undefined) delete process.env.DREBOT_T3_URL;
    else process.env.DREBOT_T3_URL = previousUrl;
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  });

  function fakeSocket(onRequest) {
    const sockets = [];
    class FakeWebSocket extends EventTarget {
      constructor(url) {
        super();
        this.url = new URL(url);
        this.sent = [];
        this.closed = false;
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send(raw) {
        const frame = JSON.parse(raw);
        this.sent.push(frame);
        if (frame._tag === "Request") queueMicrotask(() => onRequest(this, frame));
      }
      message(frame) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
      }
      close() {
        this.closed = true;
        this.dispatchEvent(Object.assign(new Event("close"), { reason: "fake-private-ticket" }));
      }
    }
    t.mock.method(globalThis, "WebSocket", function (url) {
      return new FakeWebSocket(url);
    });
    return sockets;
  }

  function retriableError(message) {
    return (error) => {
      NodeAssert.equal(error.message, message);
      NodeAssert.equal(Object.hasOwn(error, "refused"), false);
      NodeAssert.equal(error.cause, undefined);
      return true;
    };
  }

  await t.test("state override and private credential metadata", () => {
    NodeAssert.equal(STATE, scratch);
    NodeAssert.equal(CONFIG, NodePath.join(scratch, "config"));
    NodeAssert.equal(t3Token(), null);
    saveCredential();
    NodeAssert.equal(t3Token().expired, false);
    saveCredential({ ...credential, expiresAt: "2000-01-01T00:00:00Z" });
    NodeAssert.equal(t3Token().expired, true);
    saveCredential({ ...credential, expiresAt: "invalid" });
    NodeAssert.equal(t3Token().expired, true);
    saveCredential({ token: 12 });
    NodeAssert.equal(t3Token(), null);
  });

  await t.test("direct, hosted, query and bare pairing codes, restricted to HTTP backends", () => {
    NodeAssert.deepEqual(pairingCode(" bare-code "), { code: "bare-code", origin: "" });
    NodeAssert.deepEqual(pairingCode("http://127.0.0.1:3773/pair#token=direct"), {
      code: "direct",
      origin: "http://127.0.0.1:3773",
    });
    NodeAssert.deepEqual(
      pairingCode(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fbackend.example.test%2F#token=hosted",
      ),
      { code: "hosted", origin: "https://backend.example.test" },
    );
    NodeAssert.deepEqual(
      pairingCode("https://app.t3.codes/pair?host=http%3A%2F%2F127.0.0.1%3A3773%2F&token=query"),
      { code: "query", origin: "http://127.0.0.1:3773" },
    );
    for (const invalid of [
      "",
      "ftp://example.test/pair#token=code",
      "https://app.t3.codes/pair?host=file%3A%2F%2Ftmp%2Fx#token=code",
      "https://app.t3.codes/pair?host=#token=code",
      "https://user:password@example.test/pair#token=code",
    ])
      NodeAssert.deepEqual(pairingCode(invalid), { code: "", origin: "" });
  });

  await t.test(
    "real paired HTTP exchange saves atomically as 0600 and archives the previous bytes",
    async (t) => {
      saveCredential();
      const previous = NodeFS.readFileSync(T3_TOKEN_FILE);
      // Cover replacement of a legacy record that was written with a loose mode.
      NodeFS.chmodSync(T3_TOKEN_FILE, 0o644);
      let exchanged;
      const server = NodeHttp.createServer(async (request, result) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        exchanged = {
          url: request.url,
          method: request.method,
          type: request.headers["content-type"],
          body: new URLSearchParams(Buffer.concat(chunks).toString()),
        };
        result.writeHead(200, { "content-type": "application/json" });
        result.end(JSON.stringify(accessToken));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const result = await t3Pair(
        `https://app.t3.codes/pair?host=${encodeURIComponent(origin + "/")}#token=fake-one-use-code`,
      );
      NodeAssert.deepEqual(result, { ok: true, expiresAt: t3Token().expiresAt, origin });
      NodeAssert.equal(exchanged.url, "/oauth/token");
      NodeAssert.equal(exchanged.method, "POST");
      NodeAssert.equal(exchanged.type, "application/x-www-form-urlencoded");
      NodeAssert.deepEqual(Object.fromEntries(exchanged.body), {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "fake-one-use-code",
        subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        client_label: "Drebot",
        client_device_type: "bot",
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Verify the standalone adapter's native host metadata without importing its Effect-backed TS service.
        client_os: NodeOS.platform(),
      });
      NodeAssert.equal(t3Token().token, accessToken.access_token);
      NodeAssert.equal(NodeFS.statSync(T3_TOKEN_FILE).mode & 0o777, 0o600);
      const archive = NodePath.join(STATE, "archive", "t3-tokens");
      const archived = NodeFS.readdirSync(archive);
      NodeAssert.equal(archived.length, 1);
      NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(archive, archived[0])), previous);
      NodeAssert.equal(NodeFS.statSync(NodePath.join(archive, archived[0])).mode & 0o777, 0o600);
      NodeAssert.deepEqual(NodeFS.readdirSync(CONFIG), ["t3-token.json"]);
    },
  );

  await t.test("explicit environment URL wins over config and hosted pairing URL", async () => {
    saveCredential();
    NodeFS.writeFileSync(
      NodePath.join(CONFIG, "drebot.json"),
      JSON.stringify({ t3Url: "https://config.example.test" }),
    );
    process.env.DREBOT_T3_URL = "https://explicit.example.test/";
    t.mock.method(globalThis, "fetch", async (url, options) => {
      NodeAssert.equal(url, "https://explicit.example.test/oauth/token");
      NodeAssert.equal(options.redirect, "error");
      NodeAssert.ok(options.signal instanceof AbortSignal);
      return response(accessToken);
    });
    const result = await t3Pair(
      "https://app.t3.codes/pair?host=https%3A%2F%2Fhosted.example.test#token=fake-code",
    );
    NodeAssert.equal(result.origin, "https://explicit.example.test");
  });

  await t.test("Drebot config URL selects the RPC backend", async () => {
    saveCredential();
    NodeFS.writeFileSync(
      NodePath.join(CONFIG, "drebot.json"),
      JSON.stringify({ t3Url: "https://config.example.test/" }),
    );
    t.mock.method(globalThis, "fetch", async (url, options) => {
      NodeAssert.equal(url, "https://config.example.test/api/auth/websocket-ticket");
      NodeAssert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
      return response({ ticket: "fake-private-ticket" });
    });
    const sockets = fakeSocket((ws) =>
      ws.message({
        _tag: "Exit",
        requestId: "1",
        exit: { _tag: "Success", value: { connected: true } },
      }),
    );
    NodeAssert.deepEqual(await t3Dispatch("server.getConfig", {}), { connected: true });
    NodeAssert.equal(sockets[0].url.origin, "wss://config.example.test");
  });

  await t.test(
    "invalid explicit endpoint fails without network or exposing its value",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "file:///fake-private-bearer";
      t.mock.method(globalThis, "fetch", () => {
        NodeAssert.fail("must not fetch");
      });
      await NodeAssert.rejects(t3Dispatch("server.getConfig", {}), /must be an HTTP or HTTPS/);
      NodeAssert.deepEqual(await t3Pair("fake-code"), {
        ok: false,
        why: "Drebot T3 URL must be an HTTP or HTTPS URL without embedded credentials",
      });
    },
  );

  await t.test(
    "refused or malformed pairing responses preserve existing credential and redact server bodies",
    async () => {
      saveCredential();
      const original = NodeFS.readFileSync(T3_TOKEN_FILE);
      t.mock.method(globalThis, "fetch", async () =>
        response({ reason: "fake-one-use-code fake-private-bearer" }, 401),
      );
      NodeAssert.equal(
        (await t3Pair("https://backend.example.test/pair#token=fake-one-use-code")).why,
        "T3 authentication request refused (HTTP 401); pairing codes may be spent or expired",
      );
      t.mock.method(globalThis, "fetch", async () =>
        response({ ...accessToken, token_type: "DPoP" }),
      );
      NodeAssert.deepEqual(await t3Pair("https://backend.example.test/pair#token=fake-code"), {
        ok: false,
        why: "T3 returned an invalid bearer credential",
      });
      NodeAssert.deepEqual(NodeFS.readFileSync(T3_TOKEN_FILE), original);
    },
  );

  await t.test(
    "archive failure leaves the old credential intact and removes the staged bearer",
    async () => {
      saveCredential();
      const original = NodeFS.readFileSync(T3_TOKEN_FILE);
      NodeFS.writeFileSync(NodePath.join(STATE, "archive"), "blocked archive");
      t.mock.method(globalThis, "fetch", async () => response(accessToken));
      const result = await t3Pair("https://backend.example.test/pair#token=fake-code");
      NodeAssert.equal(result.ok, false);
      NodeAssert.match(result.why, /Could not safely save/);
      NodeAssert.deepEqual(NodeFS.readFileSync(T3_TOKEN_FILE), original);
      NodeAssert.deepEqual(NodeFS.readdirSync(CONFIG), ["t3-token.json"]);
    },
  );

  await t.test(
    "successful credential replacement is not hidden by staged-file cleanup errors",
    async () => {
      saveCredential();
      t.mock.method(globalThis, "fetch", async () => response(accessToken));
      t.mock.method(NodeFS.default, "unlinkSync", () => {
        throw new Error("fake-private-bearer cleanup failure");
      });
      NodeModule.syncBuiltinESMExports();
      const result = await t3Pair("https://backend.example.test/pair#token=fake-code");
      NodeAssert.equal(result.ok, true);
      NodeAssert.equal(t3Token().token, accessToken.access_token);
      NodeAssert.deepEqual(NodeFS.readdirSync(CONFIG), ["t3-token.json"]);
    },
  );

  await t.test(
    "fresh ticket per connection, protocol 2, Request/Ack/Exit and stream firstChunk",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "https://explicit.example.test";
      let issued = 0;
      t.mock.method(globalThis, "fetch", async () =>
        response({ ticket: `fake-ticket-${++issued}` }),
      );
      const sockets = fakeSocket((ws, request) => {
        NodeAssert.deepEqual(request, {
          _tag: "Request",
          id: "1",
          tag: "server.getConfig",
          payload: {},
          headers: [],
        });
        ws.message({ _tag: "Exit", requestId: "unrelated", exit: { _tag: "Failure" } });
        ws.message({ _tag: "Chunk", requestId: "1", values: [] });
        ws.message({ _tag: "Chunk", requestId: "1", values: [{ streamed: true }] });
        ws.message({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: { completed: true } },
        });
      });
      NodeAssert.deepEqual(await t3Dispatch("server.getConfig", {}), { completed: true });
      NodeAssert.deepEqual(await t3Dispatch("server.getConfig", {}, { firstChunk: true }), {
        streamed: true,
      });
      NodeAssert.equal(issued, 2);
      for (const [index, socket] of sockets.entries()) {
        NodeAssert.equal(socket.url.protocol, "wss:");
        NodeAssert.equal(socket.url.pathname, "/ws");
        NodeAssert.equal(socket.url.searchParams.get("orchestrationProtocol"), "2");
        NodeAssert.equal(socket.url.searchParams.get("wsTicket"), `fake-ticket-${index + 1}`);
        NodeAssert.deepEqual(socket.sent.slice(1), [
          { _tag: "Ack", requestId: "1" },
          { _tag: "Ack", requestId: "1" },
        ]);
        NodeAssert.equal(socket.closed, true);
      }
    },
  );

  await t.test(
    "early close and RPC failure reject promptly without reflecting close reasons or exit payloads",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "https://explicit.example.test";
      t.mock.method(globalThis, "fetch", async () => response({ ticket: "fake-private-ticket" }));
      fakeSocket((ws) => ws.close());
      await NodeAssert.rejects(
        t3Dispatch("server.getConfig", {}),
        retriableError("T3 websocket closed before the RPC completed; outcome unknown"),
      );
      fakeSocket((ws) =>
        ws.message({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Failure", cause: "fake-private-bearer fake-private-ticket" },
        }),
      );
      await NodeAssert.rejects(t3Dispatch("server.getConfig", {}), (error) => {
        NodeAssert.equal(error.message, "T3 refused the RPC request");
        NodeAssert.equal(error.refused, true);
        NodeAssert.equal(error.cause, undefined);
        return true;
      });
    },
  );

  await t.test("RPC timeout closes a stalled socket", async () => {
    saveCredential();
    process.env.DREBOT_T3_URL = "https://explicit.example.test";
    t.mock.method(globalThis, "fetch", async () => response({ ticket: "fake-private-ticket" }));
    const sockets = fakeSocket(() => {});
    await NodeAssert.rejects(
      t3Dispatch("server.getConfig", {}, { timeoutMs: 10 }),
      retriableError("T3 RPC request timed out"),
    );
    NodeAssert.equal(sockets[0].closed, true);
  });

  await t.test(
    "websocket transport and malformed Exit failures stay retriable and redact private details",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "https://explicit.example.test";
      t.mock.method(globalThis, "fetch", async () => response({ ticket: "fake-private-ticket" }));
      fakeSocket((ws) =>
        ws.dispatchEvent(Object.assign(new Event("error"), { message: "fake-private-ticket" })),
      );
      await NodeAssert.rejects(
        t3Dispatch("server.getConfig", {}),
        retriableError("T3 websocket failed"),
      );
      for (const exit of [undefined, { _tag: "Unknown", cause: "fake-private-bearer" }]) {
        fakeSocket((ws) => ws.message({ _tag: "Exit", requestId: "1", exit }));
        await NodeAssert.rejects(
          t3Dispatch("server.getConfig", {}),
          retriableError("T3 returned an invalid RPC response; outcome unknown"),
        );
      }
    },
  );

  await t.test(
    "HTTP auth and ticket failures stay retriable without secret-bearing causes",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "https://explicit.example.test";
      for (const [reply, message] of [
        [
          response({ reason: "fake-private-bearer" }, 401),
          "T3 authentication request refused (HTTP 401)",
        ],
        [
          new Response("fake-private-bearer"),
          "T3 authentication request failed or returned an unreadable response",
        ],
        [
          response({ reason: "fake-private-ticket" }),
          "T3 returned no websocket ticket; the credential may be revoked",
        ],
      ]) {
        t.mock.method(globalThis, "fetch", async () => reply);
        await NodeAssert.rejects(t3Dispatch("server.getConfig", {}), retriableError(message));
      }
    },
  );

  await t.test(
    "HTTP auth uses a native 20 second abort timeout and masks transport failures",
    async () => {
      saveCredential();
      process.env.DREBOT_T3_URL = "https://explicit.example.test";
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      t.mock.method(AbortSignal, "timeout", (ms) => {
        NodeAssert.equal(ms, 20000);
        return timeout(10);
      });
      t.mock.method(
        globalThis,
        "fetch",
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      // AbortSignal timers are unref'ed. Hold the event loop while the deliberately stalled fetch waits.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await NodeAssert.rejects(
          t3Dispatch("server.getConfig", {}),
          retriableError("T3 authentication request timed out"),
        );
        NodeAssert.match((await t3Pair("fake-code")).why, /^T3 authentication request timed out;/);
      } finally {
        clearInterval(keepAlive);
      }
      t.mock.method(globalThis, "fetch", () => {
        throw new Error("fake-private-bearer fake-private-ticket");
      });
      await NodeAssert.rejects(
        t3Dispatch("server.getConfig", {}),
        retriableError("T3 authentication request failed or returned an unreadable response"),
      );
    },
  );
});
