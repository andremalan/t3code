import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CONFIG, STATE } from "./paths.mjs";

export const T3_TOKEN_FILE = NodePath.join(CONFIG, "t3-token.json");
const HTTP_TIMEOUT_MS = 20000;

function readJson(file) {
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

function httpOrigin(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function t3Origin(held, pairingOrigin = "") {
  let configured = process.env.DREBOT_T3_URL?.trim();
  if (!configured) {
    try {
      configured = readJson(NodePath.join(CONFIG, "drebot.json"))?.t3Url;
    } catch (error) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- JSON errors can include private configuration bytes.
      if (error.code !== "ENOENT") throw new Error("Could not read Drebot configuration");
    }
  }
  if (configured) {
    const origin = httpOrigin(configured);
    if (!origin)
      throw new Error("Drebot T3 URL must be an HTTP or HTTPS URL without embedded credentials");
    return origin;
  }
  // A pasted pairing link identifies its own backend. Discovery is for bare codes and RPC calls.
  if (pairingOrigin) return pairingOrigin;
  try {
    const origin = httpOrigin(
      readJson(NodePath.join(NodeOS.homedir(), ".t3", "userdata", "server-runtime.json"))?.origin,
    );
    if (origin) return origin;
  } catch {}
  return httpOrigin(held?.origin);
}

/** Internal credential reader. Callers reporting status must select only safe metadata. */
export function t3Token() {
  let record;
  try {
    record = readJson(T3_TOKEN_FILE);
  } catch {
    return null;
  }
  if (typeof record?.token !== "string" || !record.token.trim()) return null;
  const expiresAt = record.expiresAt || "";
  const expired = !!expiresAt && !(Date.parse(expiresAt) > Date.now());
  return { ...record, expired };
}

export function pairingCode(input) {
  const raw = String(input || "").trim();
  const empty = { code: "", origin: "" };
  if (!raw) return empty;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { code: raw, origin: "" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return empty;
  }
  if (!httpOrigin(raw)) return empty;
  const origin = url.searchParams.has("host")
    ? httpOrigin(url.searchParams.get("host"))
    : url.origin;
  if (!origin) return empty;
  const fragment = new URLSearchParams(url.hash.slice(1));
  return {
    code: fragment.get("token")?.trim() || url.searchParams.get("token")?.trim() || "",
    origin,
  };
}

// Never reflect server bodies, exception messages or websocket close reasons: they can contain secrets.
async function authRequest(base, path, options, timeoutMs = HTTP_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(timeoutMs, HTTP_TIMEOUT_MS)),
    });
    if (response.ok) return await response.json();
  } catch (error) {
    const message =
      error?.name === "AbortError" || error?.name === "TimeoutError"
        ? "T3 authentication request timed out"
        : "T3 authentication request failed or returned an unreadable response";
    // oxlint-disable-next-line eslint/preserve-caught-error -- Transport and JSON causes can expose bearer tokens or pairing codes.
    throw new Error(message);
  }
  throw new Error(`T3 authentication request refused (HTTP ${response.status})`);
}

function writePrivate(file, content) {
  const fd = NodeFS.openSync(file, "wx", 0o600);
  try {
    NodeFS.writeFileSync(fd, content);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function storeToken(record) {
  NodeFS.mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
  const staged = NodePath.join(CONFIG, `.t3-token-${NodeCrypto.randomUUID()}.json`);
  try {
    writePrivate(staged, JSON.stringify(record, null, 2) + "\n");
    let previous;
    try {
      previous = NodeFS.readFileSync(T3_TOKEN_FILE);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous !== undefined) {
      // The default archive is ~/tmp/cc/archive/t3-tokens; state overrides keep tests isolated.
      const archive = NodePath.join(STATE, "archive", "t3-tokens");
      NodeFS.mkdirSync(archive, { recursive: true, mode: 0o700 });
      writePrivate(
        NodePath.join(archive, `${Date.now()}-${NodeCrypto.randomUUID()}.json`),
        previous,
      );
    }
    // The replacement is already 0600 when it becomes visible, including over an older loose file.
    NodeFS.renameSync(staged, T3_TOKEN_FILE);
  } catch (error) {
    // A successful rename leaves no staged file. Cleanup must preserve the original storage error.
    try {
      NodeFS.unlinkSync(staged);
    } catch {}
    throw error;
  }
}

/** Exchange a one-use code. The result is safe for the CLI to print. */
export async function t3Pair(input) {
  const { code, origin } = pairingCode(input);
  if (!code) return { ok: false, why: "Expected a T3 pairing URL or a bare pairing code" };
  let base;
  try {
    base = t3Origin(t3Token(), origin);
  } catch (error) {
    return { ok: false, why: error.message };
  }
  if (!base)
    return { ok: false, why: "No T3 backend found; set DREBOT_T3_URL or provide a pairing URL" };
  // Public contracts: packages/contracts/src/auth.ts (OAuth token exchange).
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: code,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "Drebot",
    client_device_type: "bot",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node adapter metadata cannot import the Effect-backed HostProcessPlatform TS service.
    client_os: NodeOS.platform(),
  });
  let result;
  try {
    result = await authRequest(base, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    return { ok: false, why: `${error.message}; pairing codes may be spent or expired` };
  }
  const expiresMs = Date.now() + result?.expires_in * 1000;
  if (
    typeof result?.access_token !== "string" ||
    !result.access_token.trim() ||
    result.token_type !== "Bearer" ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0 ||
    !Number.isFinite(expiresMs) ||
    expiresMs > 8.64e15
  )
    return { ok: false, why: "T3 returned an invalid bearer credential" };
  const expiresAt = new Date(expiresMs).toISOString();
  try {
    storeToken({
      token: result.access_token,
      expiresAt,
      scope: result.scope || "",
      tokenType: "Bearer",
      origin: base,
      mintedAt: new Date().toISOString(),
    });
  } catch {
    return {
      ok: false,
      why: "Could not safely save the T3 credential; the pairing code was consumed",
    };
  }
  return { ok: true, expiresAt, origin: base };
}

/** One Effect RPC request using the public protocol 2 websocket transport. */
export async function t3Dispatch(tag, payload, { timeoutMs = 20000, firstChunk = false } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("T3 timeout must be a positive integer");
  const held = t3Token();
  if (!held)
    throw new Error("Drebot has no T3 credential; run drebot pair with a fresh pairing URL");
  if (held.expired)
    throw new Error("Drebot T3 credential expired; run drebot pair with a fresh pairing URL");
  const base = t3Origin(held);
  if (!base) throw new Error("No T3 backend found; set DREBOT_T3_URL");
  const ticket = await authRequest(
    base,
    "/api/auth/websocket-ticket",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${held.token}` },
    },
    timeoutMs,
  );
  if (typeof ticket?.ticket !== "string" || !ticket.ticket.trim())
    throw new Error("T3 returned no websocket ticket; the credential may be revoked");
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket.ticket);
  return await new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url.href);
    } catch {
      reject(new Error("Could not create the T3 websocket"));
      return;
    }
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error("T3 RPC request timed out")), timeoutMs);
    ws.addEventListener("error", () => done(reject, new Error("T3 websocket failed")));
    ws.addEventListener("close", () =>
      done(reject, new Error("T3 websocket closed before the RPC completed; outcome unknown")),
    );
    ws.addEventListener("open", () => {
      if (settled) return;
      try {
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      } catch {
        done(reject, new Error("Could not send the T3 RPC request; outcome unknown"));
      }
    });
    ws.addEventListener("message", ({ data }) => {
      if (settled) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (!message || message.requestId !== "1") return;
      if (message._tag === "Chunk") {
        try {
          ws.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        } catch {
          done(reject, new Error("Could not acknowledge the T3 RPC response"));
          return;
        }
        if (firstChunk && message.values?.length) done(resolve, message.values[0]);
      } else if (message._tag === "Exit") {
        if (message.exit?._tag === "Success") done(resolve, message.exit.value);
        else if (message.exit?._tag === "Failure") {
          const error = new Error("T3 refused the RPC request");
          error.refused = true;
          done(reject, error);
        } else done(reject, new Error("T3 returned an invalid RPC response; outcome unknown"));
      }
    });
  });
}
