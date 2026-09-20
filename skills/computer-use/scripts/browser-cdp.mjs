import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal browser-first CDP helper. It lists targets and evaluates one
 * serializable expression on an explicitly named target. It never launches,
 * foregrounds, switches, or restarts a browser. Bun and recent Node provide
 * the fetch and WebSocket globals; tests inject both.
 */
export const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
export const DEFAULT_TIMEOUT_MS = 2_000;
export const MAX_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_EXPRESSION_BYTES = 16 * 1024;

export class BrowserCdpError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserCdpError";
    this.code = code;
  }
}

const fail = (code, message, cause) => { throw new BrowserCdpError(code, message, cause); };
const required = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") fail("invalid_request", `${name} must be a non-empty string`);
  return value;
};
const integerLimit = (value, fallback, max, name) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > max) {
    fail("invalid_request", `${name} must be an integer from 1 to ${max}`);
  }
  return result;
};
const sizeOf = (value) => new TextEncoder().encode(value).byteLength;

function limits(options) {
  return {
    timeoutMs: integerLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs"),
    maxOutputBytes: integerLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, "maxOutputBytes")
  };
}

function endpoint(value) {
  let url;
  try { url = new URL(required(value ?? DEFAULT_ENDPOINT, "endpoint")); }
  catch (error) { fail("invalid_request", "endpoint is not a valid URL", error); }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("invalid_request", "endpoint must use http or https");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function bounded(task, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { onTimeout?.(); } catch { /* timeout is the useful result */ }
      reject(new BrowserCdpError("cdp_timeout", `CDP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve().then(task).then((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function boundedText(response, maxOutputBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        total += bytes.byteLength;
        if (total > maxOutputBytes) {
          await reader.cancel();
          fail("cdp_output_limit", `CDP response exceeds the ${maxOutputBytes}-byte output limit`);
        }
        chunks.push(bytes);
      }
    } finally { reader.releaseLock?.(); }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(all);
  }
  let text;
  try { text = await response.text(); }
  catch (error) { fail("cdp_connect_failed", "could not read the CDP response", error); }
  if (sizeOf(text) > maxOutputBytes) fail("cdp_output_limit", `CDP response exceeds the ${maxOutputBytes}-byte output limit`);
  return text;
}

async function fetchJson(url, options, timeoutMs, maxOutputBytes) {
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetcher !== "function") fail("cdp_fetch_unavailable", "this runtime has no built-in fetch");
  const controller = new AbortController();
  return bounded(async () => {
    let response;
    try { response = await fetcher(url, { signal: controller.signal }); }
    catch (error) { fail("cdp_connect_failed", `could not fetch ${url}`, error); }
    if (!response.ok && !(response.status >= 200 && response.status < 300)) {
      fail("cdp_http_error", `CDP endpoint returned HTTP ${response.status}`);
    }
    const body = await boundedText(response, maxOutputBytes);
    try { return JSON.parse(body); }
    catch (error) { fail("cdp_protocol_error", "CDP endpoint returned invalid JSON", error); }
  }, timeoutMs, () => controller.abort());
}

function target(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || value.id.trim() === "") {
    fail("cdp_protocol_error", "CDP target entry has no id");
  }
  const result = {
    id: value.id,
    type: typeof value.type === "string" ? value.type : "",
    title: typeof value.title === "string" ? value.title : "",
    url: typeof value.url === "string" ? value.url : ""
  };
  if (typeof value.webSocketDebuggerUrl === "string" && value.webSocketDebuggerUrl !== "") {
    result.webSocketDebuggerUrl = value.webSocketDebuggerUrl;
  }
  return result;
}

function assertSize(value, maxOutputBytes, label) {
  let json;
  try { json = JSON.stringify(value); }
  catch (error) { fail("cdp_protocol_error", `${label} is not JSON serializable`, error); }
  if (json === undefined || sizeOf(json) > maxOutputBytes) fail("cdp_output_limit", `${label} exceeds the ${maxOutputBytes}-byte output limit`);
}

export async function listTargets(options = {}) {
  const base = endpoint(options.endpoint);
  const { timeoutMs, maxOutputBytes } = limits(options);
  const payload = await fetchJson(`${base}/json/list`, options, timeoutMs, maxOutputBytes);
  if (!Array.isArray(payload)) fail("cdp_protocol_error", "CDP /json/list response is not an array");
  const result = payload.map(target);
  assertSize(result, maxOutputBytes, "target list");
  return result;
}

function listen(socket, event, listener) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener);
    return () => socket.removeEventListener?.(event, listener);
  }
  const key = `on${event}`;
  const previous = socket[key];
  socket[key] = listener;
  return () => { if (socket[key] === listener) socket[key] = previous ?? null; };
}

async function messageText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (value && typeof value.arrayBuffer === "function") return new TextDecoder().decode(new Uint8Array(await value.arrayBuffer()));
  fail("cdp_protocol_error", "CDP WebSocket message is not text");
}

function waitOpen(socket) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanups = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanups.forEach((cleanup) => cleanup());
      error ? reject(error) : resolve();
    };
    cleanups.push(listen(socket, "open", () => finish()));
    cleanups.push(listen(socket, "error", () => finish(new BrowserCdpError("cdp_websocket_error", "CDP WebSocket failed"))));
    cleanups.push(listen(socket, "close", () => finish(new BrowserCdpError("cdp_websocket_closed", "CDP WebSocket closed before opening"))));
    if (socket.readyState === 1) queueMicrotask(() => finish());
  });
}

function request(socket, body, maxOutputBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanups = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanups.forEach((cleanup) => cleanup());
      error ? reject(error) : resolve(value);
    };
    const onMessage = async (event) => {
      try {
        const text = await messageText(event.data);
        if (sizeOf(text) > maxOutputBytes) return finish(new BrowserCdpError("cdp_output_limit", `CDP message exceeds the ${maxOutputBytes}-byte output limit`));
        let message;
        try { message = JSON.parse(text); }
        catch (error) { return finish(new BrowserCdpError("cdp_protocol_error", "CDP WebSocket returned invalid JSON", error)); }
        if (message?.id !== body.id) return;
        if (message.error) return finish(new BrowserCdpError("cdp_error", message.error.message ?? "CDP request failed"));
        finish(undefined, message);
      } catch (error) {
        finish(error instanceof BrowserCdpError ? error : new BrowserCdpError("cdp_protocol_error", "could not read CDP message", error));
      }
    };
    cleanups.push(listen(socket, "message", onMessage));
    cleanups.push(listen(socket, "error", () => finish(new BrowserCdpError("cdp_websocket_error", "CDP WebSocket failed while evaluating"))));
    cleanups.push(listen(socket, "close", () => finish(new BrowserCdpError("cdp_websocket_closed", "CDP WebSocket closed before the response"))));
    try { socket.send(JSON.stringify(body)); }
    catch (error) { finish(new BrowserCdpError("cdp_websocket_error", "could not send CDP request", error)); }
  });
}

export async function evaluateTarget(options) {
  const targetId = required(options.targetId, "targetId");
  const expression = required(options.expression, "expression");
  if (sizeOf(expression) > MAX_EXPRESSION_BYTES) fail("invalid_request", `expression exceeds the ${MAX_EXPRESSION_BYTES}-byte limit`);
  const { timeoutMs, maxOutputBytes } = limits(options);
  const started = Date.now();
  const targets = await listTargets({ ...options, timeoutMs, maxOutputBytes });
  const selected = targets.find((entry) => entry.id === targetId);
  if (!selected) fail("cdp_target_not_found", `no CDP target has id ${targetId}`);
  const wsUrl = selected.webSocketDebuggerUrl;
  if (!wsUrl) fail("cdp_target_not_debuggable", `target ${targetId} has no WebSocket debugger URL`);
  let parsed;
  try { parsed = new URL(wsUrl); }
  catch (error) { fail("cdp_protocol_error", `target ${targetId} has an invalid WebSocket URL`, error); }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") fail("cdp_protocol_error", `target ${targetId} has a non-WebSocket debugger URL`);
  const WebSocketFactory = options.webSocketFactory ?? globalThis.WebSocket;
  if (typeof WebSocketFactory !== "function") fail("cdp_websocket_unavailable", "this runtime has no built-in WebSocket; use Bun or a recent Node runtime");
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) fail("cdp_timeout", `CDP request timed out after ${timeoutMs}ms`);
  let socket;
  return bounded(async () => {
    try {
      socket = new WebSocketFactory(wsUrl);
      await waitOpen(socket);
      const message = await request(socket, {
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: false }
      }, maxOutputBytes);
      const details = message?.result;
      if (details?.exceptionDetails) fail("cdp_runtime_exception", details.exceptionDetails.exception?.description ?? details.exceptionDetails.text ?? "page evaluation threw an exception");
      const remote = details?.result;
      if (!remote || typeof remote !== "object") fail("cdp_protocol_error", "Runtime.evaluate returned no result");
      let value;
      if (Object.prototype.hasOwnProperty.call(remote, "value")) value = remote.value;
      else if (typeof remote.unserializableValue === "string") value = remote.unserializableValue;
      else value = { type: remote.type, ...(remote.description ? { description: remote.description } : {}) };
      const result = { target: selected, result: value };
      assertSize(result, maxOutputBytes, "evaluation result");
      return result;
    } finally { try { socket?.close(); } catch { /* best effort */ } }
  }, remaining, () => { try { socket?.close(); } catch { /* best effort */ } });
}

function usage() {
  return [
    "usage: browser-cdp.mjs <targets|eval> [options]", "",
    "targets  list /json/list target ids and basic metadata",
    "eval     evaluate a serializable expression on --target-id only", "",
    `common: --endpoint URL --timeout-ms N (1..${MAX_TIMEOUT_MS}) --max-output-bytes N (1..${MAX_OUTPUT_BYTES})`,
    "eval: --target-id ID --expression JS"
  ].join("\n");
}

function parse(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const command = argv.shift();
  if (command !== "targets" && command !== "eval") fail("invalid_request", `unknown command ${command}`);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (!raw.startsWith("--")) fail("invalid_request", `unexpected argument ${raw}`);
    const equal = raw.indexOf("=");
    const name = equal < 0 ? raw.slice(2) : raw.slice(2, equal);
    const value = equal < 0 ? argv[++i] : raw.slice(equal + 1);
    if (value === undefined || (equal < 0 && value.startsWith("--"))) fail("invalid_request", `--${name} requires a value`);
    if (!["endpoint", "timeout-ms", "max-output-bytes", "target-id", "expression"].includes(name)) fail("invalid_request", `unknown option --${name}`);
    if (values[name] !== undefined) fail("invalid_request", `--${name} given twice`);
    values[name] = value;
  }
  const result = {
    endpoint: values.endpoint,
    timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    maxOutputBytes: values["max-output-bytes"] === undefined ? undefined : Number(values["max-output-bytes"])
  };
  limits(result);
  if (command === "eval") return { command, ...result, targetId: required(values["target-id"], "--target-id"), expression: required(values.expression, "--expression") };
  if (values["target-id"] !== undefined || values.expression !== undefined) fail("invalid_request", "--target-id and --expression are only valid for eval");
  return { command, ...result };
}

async function main(argv) {
  try {
    const request = parse(argv);
    if (request.help) return process.stdout.write(`${usage()}\n`);
    const value = request.command === "targets" ? await listTargets(request) : await evaluateTarget(request);
    const output = JSON.stringify(value);
    if (sizeOf(output) > integerLimit(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, "maxOutputBytes")) fail("cdp_output_limit", "CLI output exceeds the configured output limit");
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error instanceof BrowserCdpError ? error.code : "cdp_failed", message: error instanceof Error ? error.message : String(error) } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.slice(2));
