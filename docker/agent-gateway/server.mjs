// agent-gateway — minimal HTTP front for an agent CLI (cf / zs) inside a container.
//
// Agents POST an argv array; the gateway spawns the CLI (no shell), and returns
// stdout/stderr/exit code as JSON. Designed for ECS Fargate: credentials come
// from the task's environment (Secrets Manager / SSM), the gateway itself never
// logs them, and it refuses to start without a bearer token (>= 32 chars) unless
// GATEWAY_ALLOW_UNAUTH=1 is set explicitly (local dev only).
//
//   POST /run      {"args":["dns","records","list","-z","example.com"],"stdin":"","timeoutMs":60000}
//   GET  /tools    zs: `zs cli services`, or `zs tools --service <s>` with ?service=s; cf: `cf tools`
//   GET  /healthz  liveness
//
// Environment:
//   GATEWAY_CLI              binary to run (default: cf)
//   GATEWAY_TOKEN            bearer token required on every request (>= 32 chars)
//   GATEWAY_ALLOW_UNAUTH     "1" to run without a token (dev only)
//   GATEWAY_PORT             default 8080
//   GATEWAY_BIND             default 0.0.0.0
//   GATEWAY_WRITE_ENABLED    "1" to allow mutating verbs; default read-only
//   GATEWAY_ALLOW_FILE_REFS  "1" to let argv read container files (@path, --file); default off
//   GATEWAY_MAX_TIMEOUT_MS   cap on per-request timeout (default 300000)
//   GATEWAY_MAX_OUTPUT       cap on captured bytes per stream (default 2 MiB)
//   GATEWAY_MAX_CONCURRENCY  concurrent CLI processes (default 4; 429 when full)
//
// The real write control is the CLI's own read-only mode (ZS_READ_ONLY for zs), which this
// gateway always sets for the child unless writes are enabled. The argv classifier below is an
// advisory first filter that gives agents a fast, explicit 403.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

const CLI = process.env.GATEWAY_CLI || "cf";
const PORT = Number(process.env.GATEWAY_PORT || 8080);
const BIND = process.env.GATEWAY_BIND || "0.0.0.0";
const TOKEN = process.env.GATEWAY_TOKEN || "";
const ALLOW_UNAUTH = process.env.GATEWAY_ALLOW_UNAUTH === "1";
const WRITE_ENABLED = process.env.GATEWAY_WRITE_ENABLED === "1";
const ALLOW_FILE_REFS = process.env.GATEWAY_ALLOW_FILE_REFS === "1";
const MAX_TIMEOUT = Number(process.env.GATEWAY_MAX_TIMEOUT_MS || 300_000);
const MAX_OUTPUT = Number(process.env.GATEWAY_MAX_OUTPUT || 2 * 1024 * 1024);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.GATEWAY_MAX_CONCURRENCY || 4));

if (!ALLOW_UNAUTH && TOKEN.length < 32) {
  console.error("agent-gateway: GATEWAY_TOKEN of at least 32 characters is required (or GATEWAY_ALLOW_UNAUTH=1 for local dev)");
  process.exit(2);
}

// Only these variables reach the CLI; GATEWAY_* (the bearer token) never does.
const ENV_ALLOW = /^(PATH|HOME|XDG_CACHE_HOME|XDG_CONFIG_HOME|NODE_ENV|LANG|TZ|NO_COLOR|CI|TERM|ZSCALER_\w+|ZS_\w+|CLOUDFLARE_\w+|CF_\w+)$/;

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_ALLOW.test(k) && v !== undefined) env[k] = v;
  Object.assign(env, { CI: "1", NO_COLOR: "1", TERM: "dumb" });
  if (WRITE_ENABLED) delete env.ZS_READ_ONLY;
  else env.ZS_READ_ONLY = "1";
  if (ALLOW_FILE_REFS) delete env.ZS_NO_FILE_REFS;
  else env.ZS_NO_FILE_REFS = "1";
  return env;
}

// Advisory classifier. Verbs that mutate remote state; a word is mutating when any of its
// hyphen/underscore segments is one of these (`bulk-delete-users`, `force_remove`).
const WRITE_VERBS = new Set([
  "create", "update", "delete", "remove", "patch", "put", "set", "add", "edit", "purge", "rotate", "upload",
  "deploy", "revoke", "activate", "deactivate", "import", "move", "share", "bulk", "enable", "disable", "reset",
  "restore", "rollback", "promote", "publish", "trigger", "send", "assign", "unassign", "attach", "detach",
  "login", "logout", "upsert", "sync", "regenerate", "restart", "cancel", "start", "stop", "duplicate", "provision",
  "force", "lock", "unlock", "apply", "reorder", "associate", "dissociate", "deassociate", "verify", "save",
]);
const HTTP_WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Leading global flags that take a value (cf and zs); their value is not a command word.
const VALUE_FLAGS = new Set([
  "-z", "--zone", "--profile", "-m", "--mode", "--persist-to", "--cloud", "--customer-id", "--microtenant-id",
  "--limit", "--service",
]);
// Commands that hand out or destroy credentials.
const SECRET_COMMANDS = [["auth", "token"], ["auth", "logout"]];

function classify(args) {
  const words = [];
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a === "--force" || a.startsWith("--force=") || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) force = true;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    words.push(a);
  }
  const mutatingWord = words.find(
    (w) => HTTP_WRITES.has(w.toUpperCase()) || w.toLowerCase().split(/[-_]/).some((seg) => WRITE_VERBS.has(seg)),
  );
  const at = args.indexOf("--dry-run");
  const dryRun =
    at >= 0 &&
    !args.includes("--no-dry-run") &&
    !args.some((a) => a.startsWith("--dry-run=")) &&
    !["false", "0"].includes(String(args[at + 1]).toLowerCase());
  const secret = SECRET_COMMANDS.some(([a, b]) => words[0] === a && words[1] === b);
  return { leaf: mutatingWord ?? words.at(-1) ?? "", mutating: Boolean(mutatingWord) || force, dryRun, secret };
}

const digest = (s) => createHash("sha256").update(s).digest();
const TOKEN_DIGEST = digest(TOKEN);

function authorized(req) {
  if (ALLOW_UNAUTH && !TOKEN) return true;
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "");
  return Boolean(m) && timingSafeEqual(digest(m[1]), TOKEN_DIGEST);
}

function json(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Audit lines never carry stdin/stdout or values that may hold data (@file refs, --body).
function maskArgs(args) {
  return args.map((a, i) => (a.startsWith("@") || a.includes("=@") || args[i - 1] === "--body" ? "<masked>" : a));
}

function audit(fields) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

let running = 0;

function runCli(args, { stdin = "", timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(CLI, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    let out = Buffer.alloc(0), err = Buffer.alloc(0), truncated = false, timedOut = false;
    const cap = (buf, c) => {
      if (buf.length + c.length > MAX_OUTPUT) truncated = true;
      if (buf.length >= MAX_OUTPUT) return buf;
      return Buffer.concat([buf, c.subarray(0, MAX_OUTPUT - buf.length)]);
    };
    child.stdout.on("data", (c) => (out = cap(out, c)));
    child.stderr.on("data", (c) => (err = cap(err, c)));
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 127, error: `spawn failed: ${e.message}`, stdout: "", stderr: "", durationMs: Date.now() - started });
    });
    child.on("close", (code, signalName) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      const stderr = err.toString("utf8");
      // cf prints "Aborted." and exits 0 when a destructive command is declined
      // non-interactively; surface that as a failure the way cf-op does.
      const aborted = code === 0 && /^Aborted\./m.test(stderr);
      resolve({
        ok: code === 0 && !aborted && !timedOut,
        exitCode: aborted ? 4 : code,
        signal: signalName ?? undefined,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        stdout: out.toString("utf8"),
        stderr,
      });
    });
    child.stdin.on("error", () => {});
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// Runs fn with a concurrency slot, killing the child when the client goes away.
async function withSlot(req, res, fn) {
  if (running >= MAX_CONCURRENCY) return json(res, 429, { ok: false, error: "too many concurrent requests" });
  running++;
  const abort = new AbortController();
  const onClose = () => { if (!res.writableFinished) abort.abort(); };
  req.on("close", onClose);
  res.on("close", onClose);
  try {
    return await fn(abort.signal);
  } finally {
    running--;
    req.off("close", onClose);
    res.off("close", onClose);
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (!authorized(req)) return json(res, 401, { ok: false, error: "unauthorized" });

  if (req.method === "GET" && url.pathname === "/tools") {
    const service = url.searchParams.get("service");
    if (service !== null && !/^[a-z0-9-]{1,40}$/.test(service)) return json(res, 400, { ok: false, error: "bad service" });
    // zs splits its tool list per service (the full list is several MB); cf has one list.
    const perService = /(^|\/)zs$/.test(CLI);
    if (service && !perService) return json(res, 400, { ok: false, error: `${CLI} has no per-service tool lists` });
    const args = service ? ["tools", "--service", service] : perService ? ["cli", "services"] : ["tools"];
    return withSlot(req, res, async (signal) => {
      const r = await runCli(args, { timeoutMs: 120_000, signal });
      if (perService && !service) return json(res, r.ok ? 200 : 502, { ok: r.ok, services: r.stdout, hint: "GET /tools?service=<name>" });
      return json(res, r.ok ? 200 : 502, { ok: r.ok, tools: r.stdout, ...(r.ok ? {} : { stderr: r.stderr }) });
    });
  }

  if (req.method === "POST" && url.pathname === "/run") {
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return json(res, 400, { ok: false, error: `bad json: ${e.message}` }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { ok: false, error: "body must be a JSON object" });
    const args = body.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return json(res, 400, { ok: false, error: "args must be an array of strings" });
    let timeoutMs = 60_000;
    if (body.timeoutMs !== undefined) {
      if (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000) return json(res, 400, { ok: false, error: "timeoutMs must be an integer >= 1000" });
      timeoutMs = Math.min(body.timeoutMs, MAX_TIMEOUT);
    }
    const cls = classify(args);
    const remote = req.socket.remoteAddress;
    if (cls.secret && !WRITE_ENABLED) {
      audit({ remote, args: maskArgs(args), classification: cls, refused: "secret" });
      return json(res, 403, { ok: false, error: `read-only gateway: '${args.join(" ")}' exposes or destroys credentials`, classification: cls });
    }
    if (cls.mutating && !cls.dryRun && !WRITE_ENABLED) {
      audit({ remote, args: maskArgs(args), classification: cls, refused: "mutating" });
      return json(res, 403, { ok: false, error: `read-only gateway: '${cls.leaf}' looks mutating. Re-run with --dry-run, or start the gateway with GATEWAY_WRITE_ENABLED=1.`, classification: cls });
    }
    return withSlot(req, res, async (signal) => {
      const r = await runCli(args, { stdin: typeof body.stdin === "string" ? body.stdin : "", timeoutMs, signal });
      audit({ remote, args: maskArgs(args), classification: cls, exitCode: r.exitCode, durationMs: r.durationMs, truncated: r.truncated });
      return json(res, r.ok ? 200 : 502, { ...r, classification: cls });
    });
  }

  json(res, 404, { ok: false, error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    audit({ error: String(e?.message ?? e) });
    json(res, 500, { ok: false, error: "internal error" });
  });
});

server.listen(PORT, BIND, () => {
  console.error(`agent-gateway: ${CLI} on http://${BIND}:${PORT} (${WRITE_ENABLED ? "WRITE ENABLED" : "read-only"}${TOKEN ? ", bearer auth" : ", NO AUTH"}${ALLOW_FILE_REFS ? ", file refs allowed" : ""})`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
