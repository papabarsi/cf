// agent-gateway — minimal HTTP front for an agent CLI (cf / zs) inside a container.
//
// Agents POST an argv array; the gateway spawns the CLI (no shell), and returns
// stdout/stderr/exit code as JSON. Designed for ECS Fargate: credentials come
// from the task's environment (Secrets Manager / SSM), the gateway itself never
// sees or logs them, and it refuses to start without a bearer token unless
// GATEWAY_ALLOW_UNAUTH=1 is set explicitly (local dev only).
//
//   POST /run      {"args":["dns","records","list","-z","example.com"],"stdin":"","timeoutMs":60000}
//   GET  /tools    MCP-style tool definitions (`<cli> tools`), cached
//   GET  /healthz  liveness
//
// Environment:
//   GATEWAY_CLI            binary to run (default: cf)
//   GATEWAY_TOKEN          bearer token required on every request
//   GATEWAY_ALLOW_UNAUTH   "1" to run without a token (dev only)
//   GATEWAY_PORT           default 8080
//   GATEWAY_BIND           default 0.0.0.0
//   GATEWAY_WRITE_ENABLED  "1" to allow mutating verbs; default read-only
//   GATEWAY_MAX_TIMEOUT_MS cap on per-request timeout (default 300000)
//   GATEWAY_MAX_OUTPUT     cap on captured bytes per stream (default 8 MiB)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

const CLI = process.env.GATEWAY_CLI || "cf";
const PORT = Number(process.env.GATEWAY_PORT || 8080);
const BIND = process.env.GATEWAY_BIND || "0.0.0.0";
const TOKEN = process.env.GATEWAY_TOKEN || "";
const ALLOW_UNAUTH = process.env.GATEWAY_ALLOW_UNAUTH === "1";
const WRITE_ENABLED = process.env.GATEWAY_WRITE_ENABLED === "1";
const MAX_TIMEOUT = Number(process.env.GATEWAY_MAX_TIMEOUT_MS || 300_000);
const MAX_OUTPUT = Number(process.env.GATEWAY_MAX_OUTPUT || 8 * 1024 * 1024);

if (!TOKEN && !ALLOW_UNAUTH) {
  console.error("agent-gateway: GATEWAY_TOKEN is required (or GATEWAY_ALLOW_UNAUTH=1 for local dev)");
  process.exit(2);
}

// Verbs that mutate remote state. Read-only mode rejects an argv whose leaf
// command (last non-flag token before the first flag) matches, or that carries
// --force. The CLI's own --dry-run is always allowed through.
const WRITE_VERBS =
  /^(create|update|delete|remove|patch|put|set|add|edit|purge|rotate|upload|deploy|revoke|activate|import|move|share|bulk-\w+|enable|disable|reset|restore|rollback|promote|publish|trigger|send|assign|unassign|attach|detach|login|logout)$/i;

function classify(args) {
  const words = [];
  for (const a of args) {
    if (a.startsWith("-")) break;
    words.push(a);
  }
  // Any command word may be the verb: `dns records delete <id>` puts the
  // subject after it, so test every non-flag word, not just the last one.
  const leaf = words.find((w) => WRITE_VERBS.test(w)) ?? words.at(-1) ?? "";
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force") || args.includes("-f");
  const mutating = words.some((w) => WRITE_VERBS.test(w)) || force;
  return { leaf, mutating, dryRun };
}

function authorized(req) {
  if (ALLOW_UNAUTH && !TOKEN) return true;
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
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

function runCli(args, { stdin = "", timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(CLI, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" },
    });
    let out = Buffer.alloc(0), err = Buffer.alloc(0), truncated = false, timedOut = false;
    const cap = (buf, c) => {
      if (buf.length >= MAX_OUTPUT) { truncated = true; return buf; }
      return Buffer.concat([buf, c.subarray(0, MAX_OUTPUT - buf.length)]);
    };
    child.stdout.on("data", (c) => (out = cap(out, c)));
    child.stderr.on("data", (c) => (err = cap(err, c)));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 127, error: `spawn failed: ${e.message}`, stdout: "", stderr: "", durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = out.toString("utf8");
      let result;
      try { result = stdout.trim() ? JSON.parse(stdout) : null; } catch { result = undefined; }
      // cf prints "Aborted." and exits 0 when a destructive command is declined
      // non-interactively; surface that as a failure the way cf-op does.
      const aborted = code === 0 && /^Aborted\./m.test(err.toString("utf8"));
      resolve({
        ok: code === 0 && !aborted && !timedOut,
        exitCode: aborted ? 4 : code,
        signal: signal ?? undefined,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
        stdout,
        stderr: err.toString("utf8"),
        ...(result !== undefined ? { result } : {}),
      });
    });
    child.stdin.on("error", () => {});
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

let toolsCache = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, cli: CLI, writeEnabled: WRITE_ENABLED });
  if (!authorized(req)) return json(res, 401, { ok: false, error: "unauthorized" });

  if (req.method === "GET" && url.pathname === "/tools") {
    if (!toolsCache) {
      const r = await runCli(["tools"], { timeoutMs: 120_000 });
      if (!r.ok) return json(res, 502, r);
      toolsCache = r.result ?? r.stdout;
    }
    return json(res, 200, { ok: true, tools: toolsCache });
  }

  if (req.method === "POST" && url.pathname === "/run") {
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch (e) { return json(res, 400, { ok: false, error: `bad json: ${e.message}` }); }
    const args = body.args;
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return json(res, 400, { ok: false, error: "args must be an array of strings" });
    const timeoutMs = Math.min(Number(body.timeoutMs) || 60_000, MAX_TIMEOUT);
    const cls = classify(args);
    if (cls.mutating && !cls.dryRun && !WRITE_ENABLED) {
      return json(res, 403, { ok: false, error: `read-only gateway: '${cls.leaf}' looks mutating. Re-run with --dry-run, or start the gateway with GATEWAY_WRITE_ENABLED=1.`, classification: cls });
    }
    const r = await runCli(args, { stdin: typeof body.stdin === "string" ? body.stdin : "", timeoutMs });
    return json(res, r.ok ? 200 : 502, { ...r, classification: cls });
  }

  json(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, BIND, () => {
  console.error(`agent-gateway: ${CLI} on http://${BIND}:${PORT} (${WRITE_ENABLED ? "WRITE ENABLED" : "read-only"}${TOKEN ? ", bearer auth" : ", NO AUTH"})`);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
