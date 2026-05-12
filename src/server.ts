import { spawn, type Subprocess } from "bun";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? process.env.OPENCLAW_PUBLIC_PORT ?? "3000", 10);

const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken(): string {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch { /* ignore */ }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch { /* best-effort */ }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

const INTERNAL_GATEWAY_PORT = parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function entryExists(): boolean {
  try { return fs.existsSync(OPENCLAW_ENTRY); } catch { return false; }
}

function faviconResponse(): Response {
  try {
    const favicon = fs.readFileSync(path.join(process.cwd(), "assets", "favicon.png"));
    return new Response(favicon, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("", { status: 404 });
  }
}

function firstForwardedHeader(value: string | null): string {
  return (value || "").split(",")[0]?.trim() || "";
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function publicOriginFromRequest(req: Request): string | null {
  const origin = normalizeHttpOrigin(req.headers.get("origin") || "");
  if (origin) return origin;

  const forwardedHost = firstForwardedHeader(req.headers.get("x-forwarded-host"));
  const host = forwardedHost || firstForwardedHeader(req.headers.get("host"));
  if (host) {
    const forwardedProto = firstForwardedHeader(req.headers.get("x-forwarded-proto"));
    const proto = forwardedProto || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
    const fromHeaders = normalizeHttpOrigin(`${proto}://${host}`);
    if (fromHeaders) return fromHeaders;
  }

  return normalizeHttpOrigin(req.url);
}

async function ensureControlUiAllowedOrigin(origin: string | null): Promise<boolean> {
  if (!origin || !isConfigured()) return false;

  const p = configPath();
  let config: Record<string, any>;
  try {
    config = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify([origin])]));
    return true;
  }

  const gateway = typeof config.gateway === "object" && config.gateway !== null ? config.gateway : {};
  const controlUi = typeof gateway.controlUi === "object" && gateway.controlUi !== null ? gateway.controlUi : {};
  const existing = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
  const normalizedExisting = existing
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeHttpOrigin(value) || value.trim().toLowerCase())
    .filter(Boolean);

  if (normalizedExisting.includes("*") || normalizedExisting.includes(origin)) return false;

  config.gateway = {
    ...gateway,
    controlUi: {
      ...controlUi,
      allowedOrigins: [...existing, origin],
    },
  };

  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------------------
// GitHub Webhook Proxy config
// ---------------------------------------------------------------------------
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_APP_ID = process.env.GITHUB_APP_ID || "";
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID || "";
const GITHUB_APP_PEM_PATH = process.env.GITHUB_APP_PEM_PATH || "";
const GITHUB_HOOKS_URL = process.env.GITHUB_HOOKS_URL || `${GATEWAY_TARGET}/hooks/github`;

let ghCachedToken: string | null = null;
let ghTokenExpiry = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clawArgs(args: string[]): string[] {
  return [OPENCLAW_ENTRY, ...args];
}

function resolveConfigCandidates(): string[] {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return [explicit];
  return [path.join(STATE_DIR, "openclaw.json")];
}

function configPath(): string {
  const candidates = resolveConfigCandidates();
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return candidates[0] || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured(): boolean {
  try {
    return resolveConfigCandidates().some((c) => fs.existsSync(c));
  } catch { return false; }
}



// ---------------------------------------------------------------------------
// Gateway process management
// ---------------------------------------------------------------------------
let gatewayProc: Subprocess | null = null;
let gatewayStarting: Promise<void> | null = null;

let lastGatewayError: string | null = null;
let lastGatewayExit: { code: number | null; signal: string | null; at: string } | null = null;
let lastDoctorOutput: string | null = null;
let lastDoctorAt: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      for (const p of ["/openclaw", "/"]) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET" });
          if (res) return true;
        } catch { /* try next */ }
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}

async function startGateway(): Promise<void> {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway", "run",
    "--bind", "loopback",
    "--port", String(INTERNAL_GATEWAY_PORT),
    "--auth", "token",
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];

  const proc = spawn([OPENCLAW_NODE, ...clawArgs(args)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc = proc;

  // Monitor exit in background
  proc.exited.then((code) => {
    const msg = `[gateway] exited code=${code}`;
    console.error(msg);
    lastGatewayExit = { code, signal: null, at: new Date().toISOString() };
    if (gatewayProc === proc) gatewayProc = null;
  }).catch((err) => {
    const msg = `[gateway] error: ${String(err)}`;
    console.error(msg);
    lastGatewayError = msg;
    if (gatewayProc === proc) gatewayProc = null;
  });
}

interface RunCmdResult {
  code: number;
  output: string;
}

async function runCmd(cmd: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunCmdResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const proc = spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      ...opts.env,
    },
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { proc.kill(); } catch { /* ignore */ }
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const code = await proc.exited;
  clearTimeout(timer);

  let output = stdout + stderr;
  if (killed) output += `\n[timeout] Command exceeded ${timeoutMs}ms and was terminated.\n`;

  return { code: code ?? 0, output };
}

async function runDoctorBestEffort(): Promise<void> {
  const now = Date.now();
  if (lastDoctorAt && now - lastDoctorAt < 5 * 60 * 1000) return;
  lastDoctorAt = now;
  try {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
    const out = redactSecrets(r.output || "");
    lastDoctorOutput = out.length > 50_000 ? out.slice(0, 50_000) + "\n... (truncated)\n" : out;
  } catch (err) {
    lastDoctorOutput = `doctor failed: ${String(err)}`;
  }
}

async function ensureGatewayRunning(): Promise<{ ok: boolean; reason?: string }> {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (!entryExists()) return { ok: false, reason: `OpenClaw entry not found at ${OPENCLAW_ENTRY}` };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) throw new Error("Gateway did not become ready in time");
      } catch (err) {
        lastGatewayError = `[gateway] start failure: ${String(err)}`;
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => { gatewayStarting = null; });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway(): Promise<{ ok: boolean; reason?: string }> {
  if (gatewayProc) {
    try { gatewayProc.kill(); } catch { /* ignore */ }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function checkBasicAuth(req: Request): Response | null {
  if (!SETUP_PASSWORD) {
    return new Response("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.", { status: 500 });
  }
  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return new Response("Auth required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenClaw Setup"' },
    });
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    return new Response("Invalid password", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="OpenClaw Setup"' },
    });
  }
  return null; // auth OK
}

// ---------------------------------------------------------------------------
// Redaction & utilities
// ---------------------------------------------------------------------------
function redactSecrets(text: string): string {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

function extractDeviceRequestIds(text: string): string[] {
  const s = String(text || "");
  const out = new Set<string>();
  for (const m of s.matchAll(/requestId\s*(?:=|:)\s*([A-Za-z0-9_-]{6,})/g)) out.add(m[1]);
  for (const m of s.matchAll(/"requestId"\s*:\s*"([A-Za-z0-9_-]{6,})"/g)) out.add(m[1]);
  return Array.from(out);
}

// ---------------------------------------------------------------------------
// Auth groups (provider list for setup wizard)
// ---------------------------------------------------------------------------
const AUTH_GROUPS = [
  {
    value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" }
    ]
  },
  {
    value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" }
    ]
  },
  {
    value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" }
    ]
  },
  {
    value: "openrouter", label: "OpenRouter", hint: "API key", options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" }
    ]
  },
  {
    value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }
    ]
  },
  {
    value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" }
    ]
  },
  {
    value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }
    ]
  },
  {
    value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" }
    ]
  },
  {
    value: "qwen", label: "Qwen", hint: "OAuth", options: [
      { value: "qwen-portal", label: "Qwen OAuth" }
    ]
  },
  {
    value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" }
    ]
  },
  {
    value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible (multi-model)", options: [
      { value: "synthetic-api-key", label: "Synthetic API key" }
    ]
  },
  {
    value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" }
    ]
  }
];

// ---------------------------------------------------------------------------
// Console commands allowlist
// ---------------------------------------------------------------------------
const ALLOWED_CONSOLE_COMMANDS = new Set([
  "gateway.restart", "gateway.stop", "gateway.start",
  "openclaw.version", "openclaw.status", "openclaw.health", "openclaw.doctor",
  "openclaw.logs.tail", "openclaw.config.get",
  "openclaw.devices.list", "openclaw.devices.approve",
  "openclaw.plugins.list", "openclaw.plugins.enable",
]);

// ---------------------------------------------------------------------------
// Onboard args builder
// ---------------------------------------------------------------------------
function buildOnboardArgs(payload: Record<string, any>): string[] {
  const args = [
    "onboard", "--non-interactive", "--accept-risk", "--json",
    "--no-install-daemon", "--skip-health",
    "--workspace", WORKSPACE_DIR,
    "--gateway-bind", "loopback",
    "--gateway-port", String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth", "token",
    "--gateway-token", OPENCLAW_GATEWAY_TOKEN,
    "--flow", payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);
    const secret = (payload.authSecret || "").trim();
    const map: Record<string, string> = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && !secret) throw new Error(`Missing auth secret for authChoice=${payload.authChoice}`);
    if (flag) args.push(flag, secret);
    if (payload.authChoice === "token") {
      if (!secret) throw new Error("Missing auth secret for authChoice=token");
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// GitHub Webhook Proxy helpers
// ---------------------------------------------------------------------------
function makeGitHubJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: GITHUB_APP_ID })).toString("base64url");
  const key = crypto.createPrivateKey(fs.readFileSync(GITHUB_APP_PEM_PATH, "utf8"));
  const sig = crypto.createSign("SHA256").update(`${header}.${payload}`).sign(key, "base64url");
  return `${header}.${payload}.${sig}`;
}

async function getGitHubToken(): Promise<string> {
  if (ghCachedToken && Date.now() < ghTokenExpiry) return ghCachedToken;
  const jwt = makeGitHubJWT();
  const r = await fetch(`https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  const d = await r.json() as { token: string };
  ghCachedToken = d.token;
  ghTokenExpiry = Date.now() + 55 * 60 * 1000;
  return ghCachedToken!;
}

async function addEyesReaction(payload: any, event: string): Promise<void> {
  try {
    const action = payload.action;
    let reactUrl: string | null = null;

    if ((event === "issues" || event === "issue_comment") && payload.issue) {
      if (action === "opened" || action === "assigned" || action === "created") {
        reactUrl = `${payload.issue.url}/reactions`;
      }
    } else if ((event === "pull_request" || event === "pull_request_review") && payload.pull_request) {
      if (action === "opened" || action === "assigned" || action === "submitted" || action === "review_requested") {
        reactUrl = `${payload.pull_request.issue_url}/reactions`;
      }
    }
    if (!reactUrl) return;

    const actor = payload.sender?.login || "";
    if (actor === "pax-openclaw[bot]") return;

    const token = await getGitHubToken();
    const r = await fetch(reactUrl, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "eyes" }),
    });
    console.log(`[${new Date().toISOString()}] 👀 reaction → ${r.status} (${reactUrl.split("/repos/")[1]})`);
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] 👀 reaction error: ${err.message}`);
  }
}

function verifyGitHubSignature(body: Buffer, signature: string | null): boolean {
  if (!GITHUB_WEBHOOK_SECRET) return true;
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
  return signature === expected;
}

// ---------------------------------------------------------------------------
// Tar export/import helpers (using system tar via Bun.spawn)
// ---------------------------------------------------------------------------
async function tarCreate(cwd: string, paths: string[]): Promise<ReadableStream<Uint8Array>> {
  const proc = spawn(["tar", "czf", "-", "--no-same-owner", ...paths], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout as ReadableStream<Uint8Array>;
}

async function tarExtract(cwd: string, archivePath: string): Promise<void> {
  const proc = spawn(["tar", "xzf", archivePath, "--no-same-owner"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (code ${code}): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Setup HTML page
// ---------------------------------------------------------------------------
const PINAX_LOGO_SVG = `<svg width="140" height="28" viewBox="0 0 317 62" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M70.417 36.3154V61.589H63.0442V0.15863H84.9834C88.1418 0.15863 90.8938 0.61303 93.233 1.51863C95.5722 2.42743 97.5178 3.64023 99.0698 5.16023C100.619 6.68343 101.79 8.44983 102.58 10.469C103.371 12.4882 103.764 14.6098 103.764 16.8306V19.4642C103.764 21.6882 103.371 23.8226 102.58 25.8706C101.79 27.9186 100.606 29.7202 99.025 31.269C97.4442 32.821 95.4858 34.0498 93.1434 34.9554C90.8042 35.8642 88.081 36.3154 84.9802 36.3154H70.4106H70.417ZM70.417 29.4706H84.1066C92.2986 29.4706 96.3946 25.9602 96.3946 18.9394V17.3586C96.3946 14.2578 95.3866 11.7554 93.3674 9.85463C91.3482 7.95383 88.2634 7.00343 84.1098 7.00343H70.4202V29.4706H70.417Z" fill="#FFFFFE"/><path d="M112.103 0.15863H151.07V7.00343H135.271V54.7442H151.07V61.589H112.103V54.7442H127.902V7.00343H112.103V0.15863Z" fill="#FFFFFE"/><path d="M195.764 58.4338H196.817V0.15863H204.19V61.5922H189.447L171.719 3.32023H170.667V61.5922H163.294V0.15863H178.036L195.764 58.4306V58.4338Z" fill="#FFFFFE"/><path d="M251.143 46.3218H224.814L220.337 61.5922H212.439L231.044 0.15863H244.91L263.515 61.5922H255.617L251.14 46.3218H251.143ZM237.454 3.32023L226.836 39.477H249.127L238.51 3.32023H237.457H237.454Z" fill="#FFFFFE"/><path d="M278.875 0.15863L292.654 27.365H294.235L308.014 0.15863H316.087L300.731 30.261V31.3138L316.087 61.5922H308.014L294.235 34.2098H292.654L278.875 61.5922H270.801L286.158 31.3138V30.261L270.801 0.15863H278.875Z" fill="#FFFFFE"/><path d="M24.0202 0.33783L15.0794 8.26423V10.2226L24.0202 18.149L32.961 10.2226V8.26423L24.0202 0.33783ZM29.6682 9.86103L24.0202 14.8658L18.3722 9.86103V8.62263L24.0202 3.61783L29.6682 8.62263V9.86103Z" fill="#FFFFFE"/><path d="M24.0202 14.8658L15.0794 22.7922V24.7506L24.0202 32.677L32.961 24.7506V22.7922L24.0202 14.8658ZM29.6682 24.389L24.0202 29.3938L18.3722 24.389V23.1506L24.0202 18.1458L29.6682 23.1506V24.389Z" fill="#FFFFFE"/><path d="M24.0202 43.925L15.0794 51.8514V53.8098L24.0202 61.7362L32.961 53.8098V51.8514L24.0202 43.925ZM29.6682 53.4483L24.0202 58.4531L18.3722 53.4483V52.2098L24.0202 47.205L29.6682 52.2098V53.4483Z" fill="#FFFFFE"/><path d="M9.33222 14.8658L0.391418 22.7922V24.7506L9.33222 32.677L18.273 24.7506V22.7922L9.33222 14.8658ZM14.9802 24.389L9.33222 29.3938L3.68422 24.389V23.1506L9.33222 18.1458L14.9802 23.1506V24.389Z" fill="#FFFFFE"/><path d="M9.33222 29.3938L0.391418 37.3202V39.2786L9.33222 47.205L18.273 39.2786V37.3202L9.33222 29.3938ZM14.9802 38.917L9.33222 43.9218L3.68422 38.917V37.6786L9.33222 32.6738L14.9802 37.6786V38.917Z" fill="#FFFFFE"/><path d="M9.33222 43.925L0.391418 51.8514V53.8098L9.33222 61.7362L18.273 53.8098V51.8514L9.33222 43.925ZM14.9802 53.4483L9.33222 58.4531L3.68422 53.4483V52.2098L9.33222 47.205L14.9802 52.2098V53.4483Z" fill="#FFFFFE"/><path d="M38.7114 14.8658L29.7706 22.7922V24.7506L38.7114 32.677L47.6522 24.7506V22.7922L38.7114 14.8658ZM44.3594 24.389L38.7114 29.3938L33.0634 24.389V23.1506L38.7114 18.1458L44.3594 23.1506V24.389Z" fill="#FFFFFE"/><path d="M38.7114 29.3938L29.7706 37.3202V39.2786L38.7114 47.205L47.6522 39.2786V37.3202L38.7114 29.3938ZM44.3594 38.917L38.7114 43.9218L33.0634 38.917V37.6786L38.7114 32.6738L44.3594 37.6786V38.917Z" fill="#FFFFFE"/><path d="M38.7114 43.925L29.7706 51.8514V53.8098L38.7114 61.7362L47.6522 53.8098V51.8514L38.7114 43.925ZM44.3594 53.4483L38.7114 58.4531L33.0634 53.4483V52.2098L38.7114 47.205L44.3594 52.2098V53.4483Z" fill="#FFFFFE"/></svg>`;

const SETUP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Setup — Pinax</title>
  <link rel="icon" type="image/png" href="/setup/favicon.png" />
  <link rel="apple-touch-icon" href="/setup/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0f0f0e;
      --surface: #1a1a19;
      --surface-2: #242423;
      --border: #2a2a29;
      --border-hover: #3a3a39;
      --text: #fffffe;
      --text-muted: #bfbfbe;
      --text-dim: #7a7a79;
      --purple: #6824eb;
      --purple-light: #8b5cf6;
      --aqua: #90ffea;
      --pink: #ee758c;
      --orange: #eea175;
      --font: 'Space Grotesk', system-ui, -apple-system, sans-serif;
      --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace;
      --radius: 8px;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 2rem 1rem;
      min-height: 100vh;
      font-size: 14px;
      line-height: 1.6;
    }
    .container { max-width: 720px; margin: 0 auto; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .header-logo { flex-shrink: 0; }
    .header-text h1 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .header-text p {
      margin: 0.25rem 0 0;
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    /* Status bar */
    .status-bar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .status-left { display: flex; align-items: center; gap: 0.75rem; }
    .status-links { display: flex; gap: 1rem; }
    .status-links a {
      color: var(--aqua);
      text-decoration: none;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .status-links a:hover { text-decoration: underline; }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 100px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .badge::before {
      content: '';
      width: 6px; height: 6px;
      border-radius: 50%;
    }
    .badge-ok { background: rgba(144,255,234,0.1); color: var(--aqua); }
    .badge-ok::before { background: var(--aqua); }
    .badge-warn { background: rgba(238,161,117,0.1); color: var(--orange); }
    .badge-warn::before { background: var(--orange); }
    .badge-err { background: rgba(238,117,140,0.1); color: var(--pink); }
    .badge-err::before { background: var(--pink); }
    .version-tag {
      color: var(--text-dim);
      font-size: 0.75rem;
      font-family: var(--mono);
    }

    /* Actions bar */
    .actions-bar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
    }
    .actions-row {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .console-inline {
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }

    /* Accordion sections */
    .section { margin-bottom: 0.5rem; }
    .accordion-trigger {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      padding: 0.9rem 1.25rem;
      font-family: var(--font);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: border-color 0.15s, background 0.15s;
    }
    .accordion-trigger:hover {
      border-color: var(--border-hover);
      background: var(--surface-2);
    }
    .accordion-trigger[aria-expanded="true"] {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      border-color: var(--border-hover);
    }
    .accordion-trigger::after {
      content: '▸';
      transition: transform 0.2s;
      color: var(--text-dim);
    }
    .accordion-trigger[aria-expanded="true"]::after { transform: rotate(90deg); }

    .accordion-content {
      max-height: 0;
      opacity: 0;
      overflow: hidden;
      transition: max-height 0.3s ease, opacity 0.2s ease;
      background: var(--surface);
      border: 1px solid var(--border-hover);
      border-top: 0;
      border-radius: 0 0 var(--radius) var(--radius);
      padding: 0 1.25rem;
    }
    .accordion-content > .inner { padding: 1rem 0 1.25rem; }

    /* Form elements */
    label {
      display: block;
      margin-top: 0.9rem;
      font-weight: 500;
      font-size: 0.8rem;
      color: var(--text-muted);
      letter-spacing: 0.02em;
    }
    .toggle-label {
      font-weight: 400;
      font-size: 0.78rem;
      color: var(--text-dim);
      margin-top: 0.5rem;
    }
    input[type="text"], input[type="password"], input[type="file"], select, textarea {
      width: 100%;
      padding: 0.55rem 0.75rem;
      margin-top: 0.3rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-family: var(--font);
      font-size: 0.85rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--purple); }
    textarea {
      font-family: var(--mono);
      font-size: 0.8rem;
      resize: vertical;
      min-height: 200px;
    }
    select { cursor: pointer; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.55rem 1rem;
      border-radius: var(--radius);
      border: 1px solid transparent;
      font-family: var(--font);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-primary {
      background: var(--purple);
      color: var(--text);
    }
    .btn-primary:hover { background: var(--purple-light); }
    .btn-secondary {
      background: var(--surface-2);
      color: var(--text);
      border-color: var(--border);
    }
    .btn-secondary:hover { border-color: var(--border-hover); background: var(--border); }
    .btn-danger {
      background: rgba(238,117,140,0.12);
      color: var(--pink);
      border-color: rgba(238,117,140,0.2);
    }
    .btn-danger:hover { background: rgba(238,117,140,0.2); }
    .btn-sm { padding: 0.35rem 0.65rem; font-size: 0.75rem; }

    /* Console / log */
    pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem 1rem;
      font-family: var(--mono);
      font-size: 0.78rem;
      color: var(--aqua);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 300px;
      overflow-y: auto;
      margin: 0.75rem 0 0;
    }
    pre:empty { display: none; }

    /* Console row */
    .console-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.5rem;
    }
    .console-row select, .console-row input { flex: 1; margin-top: 0; }

    /* Misc */
    .muted { color: var(--text-dim); font-size: 0.78rem; }
    .hint { color: var(--text-dim); font-size: 0.75rem; margin-top: 0.25rem; }
    code {
      background: var(--surface-2);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      font-family: var(--mono);
      font-size: 0.8em;
    }
    .btn-row { display: flex; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
    .divider { border-top: 1px solid var(--border); margin: 1rem 0; }
    details summary {
      cursor: pointer;
      color: var(--text-muted);
      font-size: 0.8rem;
      font-weight: 500;
    }
    details summary:hover { color: var(--text); }
    a { color: var(--aqua); }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="header-logo">${PINAX_LOGO_SVG}</div>
      <div class="header-text">
        <h1>OpenClaw Setup</h1>
        <p>Configure your OpenClaw instance from the browser</p>
      </div>
    </div>

    <!-- Status bar -->
    <div class="status-bar">
      <div class="status-left">
        <div id="status">Checking...</div>
        <div id="webhookBadge"></div>
        <span id="statusDetails" class="muted"></span>
      </div>
      <div class="status-links">
        <a href="/" target="_blank">Control UI ↗</a>
      </div>
    </div>

    <!-- Actions bar — always visible -->
    <div class="actions-bar">
      <div class="actions-row">
        <button id="run" class="btn btn-primary">▶ Run Setup</button>
        <button id="pairingApprove" class="btn btn-secondary">🔗 Approve Pairing</button>
        <button id="gatewayRestart" class="btn btn-secondary">🔄 Restart Gateway</button>
        <button id="reset" class="btn btn-danger">⚠ Reset</button>
      </div>
      <pre id="log"></pre>

      <div class="console-inline">
        <div class="console-row">
          <select id="consoleCmd">
            <option value="gateway.restart">gateway.restart</option>
            <option value="gateway.stop">gateway.stop</option>
            <option value="gateway.start">gateway.start</option>
            <option value="openclaw.status">openclaw status</option>
            <option value="openclaw.health">openclaw health</option>
            <option value="openclaw.doctor">openclaw doctor</option>
            <option value="openclaw.logs.tail">openclaw logs --tail N</option>
            <option value="openclaw.config.get">openclaw config get</option>
            <option value="openclaw.version">openclaw --version</option>
            <option value="openclaw.devices.list">openclaw devices list</option>
            <option value="openclaw.devices.approve">openclaw devices approve</option>
            <option value="openclaw.plugins.list">openclaw plugins list</option>
            <option value="openclaw.plugins.enable">openclaw plugins enable</option>
          </select>
          <input id="consoleArg" type="text" placeholder="arg" style="max-width:160px" />
          <button id="consoleRun" class="btn btn-secondary btn-sm">Run</button>
        </div>
        <pre id="consoleOut"></pre>
      </div>

      <div class="import-inline" style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border)">
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
          <input id="importFile" type="file" accept=".tar.gz,application/gzip" style="flex:1;min-width:200px" />
          <button id="importRun" class="btn btn-danger btn-sm">📦 Import Backup</button>
          <a href="/setup/export" class="btn btn-secondary btn-sm" style="text-decoration:none">⬇ Export Backup</a>
        </div>
        <pre id="importOut"></pre>
      </div>

      <details style="margin-top: 0.5rem">
        <summary>Pairing helper</summary>
        <div style="margin-top:0.5rem">
          <button id="devicesRefresh" class="btn btn-sm btn-secondary">Refresh pending devices</button>
          <div id="devicesList" class="muted" style="margin-top:0.5rem"></div>
        </div>
      </details>
    </div>

    <!-- 1. Provider -->
    <div class="section">
      <button class="accordion-trigger" aria-expanded="false">
        <span>① Model / Auth Provider</span>
      </button>
      <div class="accordion-content"><div class="inner">
        <label>Provider group</label>
        <select id="authGroup"><option>Loading…</option></select>

        <label>Auth method</label>
        <select id="authChoice"><option>Loading…</option></select>

        <label>Key / Token</label>
        <input id="authSecret" type="password" placeholder="Paste API key or token" />

        <label>Wizard flow</label>
        <select id="flow">
          <option value="quickstart">quickstart</option>
          <option value="advanced">advanced</option>
          <option value="manual">manual</option>
        </select>
      </div></div>
    </div>

    <!-- 2. Channels -->
    <div class="section">
      <button class="accordion-trigger" aria-expanded="false">
        <span>② Channels</span>
      </button>
      <div class="accordion-content"><div class="inner">
        <p class="muted">Add channels now or later in the OpenClaw UI.</p>

        <label>Telegram bot token</label>
        <input id="telegramToken" type="password" placeholder="123456:ABC..." />
        <div class="hint">From <code>@BotFather</code> → <code>/newbot</code></div>

        <label>Discord bot token</label>
        <input id="discordToken" type="password" placeholder="Bot token" />
        <div class="hint">Enable <strong>MESSAGE CONTENT INTENT</strong> in Bot settings</div>

        <label>Slack bot token</label>
        <input id="slackBotToken" type="password" placeholder="xoxb-..." />

        <label>Slack app token</label>
        <input id="slackAppToken" type="password" placeholder="xapp-..." />

        <div class="divider"></div>
        <p class="muted" style="font-weight:500">Configured environment variables:</p>
        <div id="channelEnvList" class="muted">Loading...</div>
      </div></div>
    </div>

    <!-- GitHub App & Webhook -->
    <div class="section">
      <button class="accordion-trigger" aria-expanded="false">
        <span>③ GitHub App &amp; Webhook Proxy</span>
      </button>
      <div class="accordion-content"><div class="inner">
        <p class="muted">Configure a GitHub App for webhook-driven workflows. The webhook proxy receives GitHub events, adds 👀 reactions, and forwards them to OpenClaw hooks.</p>

        <label>GitHub App ID</label>
        <input id="githubAppId" type="text" placeholder="123456" />
        <div class="hint">From <strong>Settings → Developer settings → GitHub Apps → App ID</strong></div>

        <label>GitHub App Installation ID</label>
        <input id="githubInstallationId" type="text" placeholder="12345678" />
        <div class="hint">From the URL after installing the app: <code>/installations/&lt;id&gt;</code></div>

        <label>GitHub App Private Key (PEM)</label>
        <textarea id="githubAppPem" style="min-height:120px;font-size:0.75rem" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"></textarea>
        <div class="hint">Download from GitHub App settings → Private keys</div>

        <label>Webhook Secret</label>
        <input id="githubWebhookSecret" type="password" placeholder="your-webhook-secret" />
        <div class="hint">Must match the secret in your GitHub App webhook settings</div>

        <div class="btn-row">
          <button id="githubAppSave" class="btn btn-primary btn-sm">💾 Save GitHub App Config</button>
        </div>
        <pre id="githubAppOut"></pre>

        <div class="divider"></div>
        <p class="muted" style="font-weight:500">Current webhook proxy status:</p>
        <div id="webhookConfig" class="muted">Loading...</div>
      </div></div>
    </div>

    <!-- Custom provider (hidden) -->
    <div class="section" style="display:none">
      <button class="accordion-trigger" aria-expanded="false">
        <span>Custom Provider (advanced)</span>
      </button>
      <div class="accordion-content"><div class="inner">
        <p class="muted">OpenAI-compatible API with custom base URL (Ollama, vLLM, LM Studio, etc.)</p>

        <label>Provider id</label>
        <input id="customProviderId" type="text" placeholder="ollama" />

        <label>Base URL</label>
        <input id="customProviderBaseUrl" type="text" placeholder="http://127.0.0.1:11434/v1" />

        <label>API</label>
        <select id="customProviderApi">
          <option value="openai-completions">openai-completions</option>
          <option value="openai-responses">openai-responses</option>
        </select>

        <label>API key env var (optional)</label>
        <input id="customProviderApiKeyEnv" type="text" placeholder="OLLAMA_API_KEY" />

        <label>Model id (optional)</label>
        <input id="customProviderModelId" type="text" placeholder="llama3.1:8b" />
      </div></div>
    </div>

    <!-- (Run Onboarding + Debug Console moved to actions bar above) -->

    <!-- 6. Config editor -->
    <div class="section">
      <button class="accordion-trigger" aria-expanded="false">
        <span>⚙ Config Editor</span>
      </button>
      <div class="accordion-content"><div class="inner">
        <div class="muted" id="configPath"></div>
        <textarea id="configText"></textarea>
        <div class="btn-row">
          <button id="configReload" class="btn btn-secondary btn-sm">Reload</button>
          <button id="configSave" class="btn btn-primary btn-sm">Save &amp; Restart</button>
        </div>
        <pre id="configOut"></pre>
      </div></div>
    </div>

    <!-- (Import Backup moved to actions bar above) -->

    <div style="text-align:center; margin-top:2rem; padding-top:1rem; border-top:1px solid var(--border)">
      <span class="muted">Powered by <a href="https://pinax.network" target="_blank">Pinax</a> × <a href="https://openclaw.ai" target="_blank">OpenClaw</a></span>
    </div>
  </div>

  <script src="/setup/app.js"></script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
async function probeGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({
      host: INTERNAL_GATEWAY_HOST,
      port: INTERNAL_GATEWAY_PORT,
      timeout: 750,
    });
    const done = (ok: boolean) => {
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function errorPage(title: string, detail: string, steps: string[]): string {
  const stepHtml = steps.map((s) => `<li>${s}</li>`).join("\n");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — OpenClaw</title>
<link rel="icon" type="image/png" href="/setup/favicon.png" />
<style>
  body { font-family: 'Space Grotesk', system-ui, sans-serif; background: #0f0f0e; color: #fffffe; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
  .card { max-width: 560px; background: #1a1a19; border: 1px solid #2a2a29; border-radius: 12px; padding: 2rem 2.5rem; }
  h1 { font-size: 1.3rem; margin: 0 0 0.5rem; color: #ee758c; }
  .detail { color: #bfbfbe; font-size: 0.9rem; margin-bottom: 1.25rem; }
  code { background: #242423; padding: 0.15rem 0.4rem; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.85em; }
  h2 { font-size: 0.9rem; color: #90ffea; margin: 0 0 0.5rem; font-weight: 600; }
  ol { padding-left: 1.25rem; margin: 0; }
  li { color: #bfbfbe; font-size: 0.85rem; margin-bottom: 0.4rem; line-height: 1.5; }
  a { color: #90ffea; }
  .footer { margin-top: 1.5rem; text-align: center; color: #7a7a79; font-size: 0.75rem; }
</style></head><body>
<div class="card">
  <h1>${title}</h1>
  <div class="detail">${detail}</div>
  <h2>Next Steps</h2>
  <ol>${stepHtml}</ol>
  <div class="footer">Powered by <a href="https://pinax.network">Pinax</a> × <a href="https://openclaw.ai">OpenClaw</a></div>
</div>
</body></html>`;
}

function isUnderDir(p: string, root: string): boolean {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // Health endpoints (no auth)
  if (method === "GET" && pathname === "/setup/healthz") {
    return json({ ok: true });
  }

  if (method === "GET" && pathname === "/healthz") {
    let gatewayReachable = false;
    if (isConfigured()) {
      try { gatewayReachable = await probeGateway(); } catch { /* ignore */ }
    }
    return json({
      ok: true,
      wrapper: { configured: isConfigured(), stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR },
      gateway: {
        target: GATEWAY_TARGET, reachable: gatewayReachable,
        lastError: lastGatewayError, lastExit: lastGatewayExit, lastDoctorAt,
      },
    });
  }

  // Favicon (no auth)
  if (method === "GET" && (pathname === "/favicon.ico" || pathname === "/favicon.png")) {
    return faviconResponse();
  }

  // GitHub webhook endpoint (no setup auth, uses HMAC)
  if (method === "POST" && pathname === "/github/webhook") {
    return handleGitHubWebhook(req);
  }

  // --- Setup routes (require basic auth) ---
  if (pathname.startsWith("/setup")) {
    const authErr = checkBasicAuth(req);
    if (authErr) return authErr;

    if (method === "GET" && pathname === "/setup") return html(SETUP_HTML);
    if (method === "GET" && pathname === "/setup/app.js") {
      return new Response(setupAppBundle, { headers: { "Content-Type": "application/javascript" } });
    }
    if (method === "GET" && pathname === "/setup/favicon.png") {
      return faviconResponse();
    }
    if (method === "GET" && pathname === "/setup/api/status") return handleSetupStatus();
    if (method === "GET" && pathname === "/setup/api/webhook/status") return handleWebhookStatus();
    if (method === "GET" && pathname === "/setup/api/channels/env") return handleChannelsEnv();
    if (method === "GET" && pathname === "/setup/api/auth-groups") return json({ ok: true, authGroups: AUTH_GROUPS });
    if (method === "POST" && pathname === "/setup/api/run") return handleSetupRun(req);
    if (method === "GET" && pathname === "/setup/api/debug") return handleSetupDebug();
    if (method === "POST" && pathname === "/setup/api/console/run") return handleConsoleRun(req);
    if (method === "GET" && pathname === "/setup/api/config/raw") return handleConfigGet();
    if (method === "POST" && pathname === "/setup/api/config/raw") return handleConfigSave(req);
    if (method === "POST" && pathname === "/setup/api/pairing/approve") return handlePairingApprove(req);
    if (method === "GET" && pathname === "/setup/api/devices/pending") return handleDevicesPending();
    if (method === "POST" && pathname === "/setup/api/devices/approve") return handleDevicesApprove(req);
    if (method === "POST" && pathname === "/setup/api/github-app/save") return handleGitHubAppSave(req);
    if (method === "POST" && pathname === "/setup/api/reset") return handleReset();
    if (method === "GET" && pathname === "/setup/export") return handleExport();
    if (method === "POST" && pathname === "/setup/import") return handleImport(req);
  }

  // --- Proxy to gateway ---
  if (!isConfigured() && !pathname.startsWith("/setup")) {
    return Response.redirect("/setup", 302);
  }

  if (method === "GET" && (pathname === "/openclaw" || pathname.startsWith("/openclaw/"))) {
    const unmountedPath = pathname === "/openclaw" ? "/" : pathname.slice("/openclaw".length);
    return Response.redirect(`${unmountedPath}${url.search}`, 302);
  }

  if (isConfigured()) {
    const addedOrigin = await ensureControlUiAllowedOrigin(publicOriginFromRequest(req));
    if (addedOrigin && gatewayProc) {
      await restartGateway();
    }

    if (!entryExists()) {
      return html(errorPage(
        "OpenClaw Not Installed",
        `The OpenClaw entry point was not found at <code>${OPENCLAW_ENTRY}</code>.`,
        [
          "Verify the Dockerfile builds OpenClaw correctly",
          "Check that <code>OPENCLAW_ENTRY</code> env var points to the right path",
          "Redeploy the service if the build failed",
          `Visit <a href="/setup">/setup</a> for configuration options`,
        ],
      ), 503);
    }
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return html(errorPage(
        "Gateway Not Ready",
        redactSecrets(String(err)),
        [
          `Visit <a href="/setup">/setup</a> and check the Debug Console`,
          `Visit <a href="/setup/api/debug">/setup/api/debug</a> for diagnostics`,
          lastGatewayError ? `Last error: <code>${redactSecrets(lastGatewayError)}</code>` : null,
        ].filter(Boolean) as string[],
      ), 503);
    }
  }

  return proxyToGateway(req);
}

// ---------------------------------------------------------------------------
// GitHub Webhook handler
// ---------------------------------------------------------------------------
async function handleGitHubWebhook(req: Request): Promise<Response> {
  const body = Buffer.from(await req.arrayBuffer());

  if (GITHUB_WEBHOOK_SECRET && !verifyGitHubSignature(body, req.headers.get("x-hub-signature-256"))) {
    console.log(`[${new Date().toISOString()}] ✗ HMAC verification failed`);
    return text("Forbidden", 403);
  }

  const event = req.headers.get("x-github-event") || "unknown";
  const delivery = req.headers.get("x-github-delivery") || "";
  console.log(`[${new Date().toISOString()}] ← ${event} (${delivery.slice(0, 8)}…)`);

  // Instant 👀 reaction (fire-and-forget)
  let payload: any;
  try { payload = JSON.parse(body.toString()); } catch { /* ignore */ }
  if (payload && GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_APP_PEM_PATH) {
    addEyesReaction(payload, event);
  }

  // Forward to GitHub hooks
  try {
    const resp = await fetch(GITHUB_HOOKS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
      },
      body,
    });
    const respText = await resp.text();
    console.log(`[${new Date().toISOString()}] → ${resp.status} ${respText.slice(0, 120)}`);
    return new Response(respText, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`[${new Date().toISOString()}] ✗ Forward error: ${err.message}`);
    return json({ error: "proxy error", detail: err.message }, 502);
  }
}

// ---------------------------------------------------------------------------
// Setup API handlers
// ---------------------------------------------------------------------------
async function handleSetupStatus(): Promise<Response> {
  const hasEntry = entryExists();
  let openclawVersion = "";
  let channelsAddHelp = "";

  if (hasEntry) {
    const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    openclawVersion = version.output.trim();
    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    channelsAddHelp = channelsHelp.output;
  }

  return json({
    configured: isConfigured(),
    entryExists: hasEntry,
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: openclawVersion || (hasEntry ? "unknown" : "not installed"),
    channelsAddHelp,
    authGroups: AUTH_GROUPS,
  });
}

function handleChannelsEnv(): Response {
  // Show all channel-related env vars with masked values
  const channelEnvPrefixes = [
    "TELEGRAM_", "DISCORD_", "SLACK_", "WHATSAPP_", "SIGNAL_",
    "IRC_", "IMESSAGE_", "GOOGLECHAT_",
  ];
  const channelEnvKeys = [
    // Explicit known keys
    "GITHUB_WEBHOOK_SECRET",
  ];

  const result: Record<string, string> = {};

  // Scan all env vars for channel-related prefixes
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    const isChannelEnv = channelEnvPrefixes.some((p) => key.startsWith(p));
    const isKnownKey = channelEnvKeys.includes(key);
    if (isChannelEnv || isKnownKey) {
      // Mask: show first 4 chars + ••••
      result[key] = val.length > 8 ? val.slice(0, 4) + "••••••••" : "••••••••";
    }
  }

  return json({ ok: true, env: result });
}

function handleWebhookStatus(): Response {
  const enabled = !!(GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_APP_PEM_PATH);
  const pemExists = GITHUB_APP_PEM_PATH ? fs.existsSync(GITHUB_APP_PEM_PATH) : false;
  return json({
    enabled,
    config: {
      GITHUB_WEBHOOK_SECRET: GITHUB_WEBHOOK_SECRET ? "••••••" : "(not set)",
      GITHUB_APP_ID: GITHUB_APP_ID || "(not set)",
      GITHUB_INSTALLATION_ID: GITHUB_INSTALLATION_ID || "(not set)",
      GITHUB_APP_PEM_PATH: GITHUB_APP_PEM_PATH || "(not set)",
      GITHUB_APP_PEM_EXISTS: pemExists,
      GITHUB_HOOKS_URL: GITHUB_HOOKS_URL || "(not set)",
    },
  });
}

async function handleSetupRun(req: Request): Promise<Response> {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = (await req.json()) as Record<string, any>;

    let onboardArgs: string[];
    try {
      onboardArgs = buildOnboardArgs(payload);
    } catch (err) {
      return json({ ok: false, output: `Setup input error: ${String(err)}` }, 400);
    }

    const prefix = "[setup] running openclaw onboard...\n";
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      // Post-onboard config
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.remote.token", OPENCLAW_GATEWAY_TOKEN]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", JSON.stringify(["127.0.0.1"])]));
      const publicOrigin = publicOriginFromRequest(req);
      if (publicOrigin) {
        await ensureControlUiAllowedOrigin(publicOrigin);
      }

      // Custom provider
      if (payload.customProviderId?.trim() && payload.customProviderBaseUrl?.trim()) {
        const providerId = payload.customProviderId.trim();
        const baseUrl = payload.customProviderBaseUrl.trim();
        const api = (payload.customProviderApi || "openai-completions").trim();
        const apiKeyEnv = (payload.customProviderApiKeyEnv || "").trim();
        const modelId = (payload.customProviderModelId || "").trim();

        if (!/^[A-Za-z0-9_-]+$/.test(providerId)) {
          extra += `\n[custom provider] skipped: invalid provider id`;
        } else if (!/^https?:\/\//.test(baseUrl)) {
          extra += `\n[custom provider] skipped: baseUrl must start with http(s)://`;
        } else if (api !== "openai-completions" && api !== "openai-responses") {
          extra += `\n[custom provider] skipped: api must be openai-completions or openai-responses`;
        } else if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
          extra += `\n[custom provider] skipped: invalid api key env var name`;
        } else {
          const providerCfg: Record<string, any> = { baseUrl, api };
          if (apiKeyEnv) providerCfg.apiKey = "${" + apiKeyEnv + "}";
          if (modelId) providerCfg.models = [{ id: modelId, name: modelId }];
          await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "models.mode", "merge"]));
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `models.providers.${providerId}`, JSON.stringify(providerCfg)]));
          extra += `\n[custom provider] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        }
      }

      const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name: string) => helpText.includes(name);

      // Telegram
      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra += "\n[telegram] skipped (not supported)\n";
        } else {
          const cfgObj = { enabled: true, dmPolicy: "pairing", botToken: payload.telegramToken.trim(), groupPolicy: "allowlist", streamMode: "partial" };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
          const plug = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", "telegram"]));
          extra += `\n[telegram config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code}\n${get.output || "(no output)"}`;
          extra += `\n[telegram plugin enable] exit=${plug.code}\n${plug.output || "(no output)"}`;
        }
      }

      // Discord
      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra += "\n[discord] skipped (not supported)\n";
        } else {
          const cfgObj = { enabled: true, token: payload.discordToken.trim(), groupPolicy: "allowlist", dm: { policy: "pairing" } };
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
          extra += `\n[discord config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      // Slack
      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra += "\n[slack] skipped (not supported)\n";
        } else {
          const cfgObj: Record<string, any> = { enabled: true };
          if (payload.slackBotToken?.trim()) cfgObj.botToken = payload.slackBotToken.trim();
          if (payload.slackAppToken?.trim()) cfgObj.appToken = payload.slackAppToken.trim();
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
          extra += `\n[slack config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      await restartGateway();
      const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
      extra += `\n[doctor --fix] exit=${fix.code}\n${fix.output || "(no output)"}`;
      await restartGateway();
    }

    return json({ ok, output: `${prefix}${onboard.output}${extra}` }, ok ? 200 : 500);
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return json({ ok: false, output: `Internal error: ${String(err)}` }, 500);
  }
}

async function handleSetupDebug(): Promise<Response> {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  const tg = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
  const dc = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));

  return json({
    wrapper: {
      bun: Bun.version,
      port: PORT,
      publicPortEnv: process.env.PORT || null,
      stateDir: STATE_DIR, workspaceDir: WORKSPACE_DIR,
      configured: isConfigured(), configPathResolved: configPath(),
      configPathCandidates: resolveConfigCandidates(),
      internalGatewayHost: INTERNAL_GATEWAY_HOST, internalGatewayPort: INTERNAL_GATEWAY_PORT,
      gatewayTarget: GATEWAY_TARGET, gatewayRunning: Boolean(gatewayProc),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      lastGatewayError, lastGatewayExit, lastDoctorAt, lastDoctorOutput,
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY, node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      channels: {
        telegram: {
          exit: tg.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(tg.output) || /enabled\s*[:=]\s*true/.test(tg.output),
          botTokenPresent: /(\d{5,}:[A-Za-z0-9_-]{10,})/.test(tg.output),
          output: redactSecrets(tg.output),
        },
        discord: {
          exit: dc.code,
          configuredEnabled: /"enabled"\s*:\s*true/.test(dc.output) || /enabled\s*[:=]\s*true/.test(dc.output),
          tokenPresent: /"token"\s*:\s*"?\S+"?/.test(dc.output) || /token\s*[:=]\s*\S+/.test(dc.output),
          output: redactSecrets(dc.output),
        },
      },
    },
  });
}

async function handleConsoleRun(req: Request): Promise<Response> {
  const payload = (await req.json()) as { cmd?: string; arg?: string };
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return json({ ok: false, error: "Command not allowed" }, 400);
  }
  if (!entryExists() && !cmd.startsWith("gateway.")) {
    return json({ ok: false, output: `OpenClaw not installed: ${OPENCLAW_ENTRY} not found.\nCheck your Dockerfile build and redeploy.\n` }, 500);
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }
      return json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    const cmdMap: Record<string, () => Promise<RunCmdResult>> = {
      "openclaw.version": () => runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      "openclaw.status": () => runCmd(OPENCLAW_NODE, clawArgs(["status"])),
      "openclaw.health": () => runCmd(OPENCLAW_NODE, clawArgs(["health"])),
      "openclaw.doctor": () => runCmd(OPENCLAW_NODE, clawArgs(["doctor"])),
      "openclaw.logs.tail": () => {
        const lines = Math.max(50, Math.min(1000, parseInt(arg || "200", 10) || 200));
        return runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      },
      "openclaw.config.get": () => {
        if (!arg) throw new Error("Missing config path");
        return runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      },
      "openclaw.devices.list": () => runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"])),
      "openclaw.devices.approve": () => {
        if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) throw new Error("Invalid device request ID");
        return runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", arg]));
      },
      "openclaw.plugins.list": () => runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list"])),
      "openclaw.plugins.enable": () => {
        if (!arg || !/^[A-Za-z0-9_-]+$/.test(arg)) throw new Error("Invalid plugin name");
        return runCmd(OPENCLAW_NODE, clawArgs(["plugins", "enable", arg]));
      },
    };

    const handler = cmdMap[cmd];
    if (!handler) return json({ ok: false, error: "Unhandled command" }, 400);

    const r = await handler();
    return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

function handleConfigGet(): Response {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    return json({ ok: true, path: p, exists, content });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleConfigSave(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { content?: string };
    const content = String(body.content || "");
    if (content.length > 500_000) return json({ ok: false, error: "Config too large" }, 413);

    fs.mkdirSync(STATE_DIR, { recursive: true });
    const p = configPath();
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }
    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });
    if (isConfigured()) await restartGateway();
    return json({ ok: true, path: p });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handlePairingApprove(req: Request): Promise<Response> {
  const { channel, code } = (await req.json()) as { channel?: string; code?: string };
  if (!channel || !code) return json({ ok: false, error: "Missing channel or code" }, 400);
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return json({ ok: r.code === 0, output: r.output }, r.code === 0 ? 200 : 500);
}

async function handleDevicesPending(): Promise<Response> {
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "list"]));
  const output = redactSecrets(r.output);
  const requestIds = extractDeviceRequestIds(output);
  return json({ ok: r.code === 0, requestIds, output }, r.code === 0 ? 200 : 500);
}

async function handleDevicesApprove(req: Request): Promise<Response> {
  const { requestId } = (await req.json()) as { requestId?: string };
  const id = String(requestId || "").trim();
  if (!id) return json({ ok: false, error: "Missing device request ID" }, 400);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ ok: false, error: "Invalid device request ID" }, 400);
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["devices", "approve", id]));
  return json({ ok: r.code === 0, output: redactSecrets(r.output) }, r.code === 0 ? 200 : 500);
}

async function handleGitHubAppSave(req: Request): Promise<Response> {
  try {
    const payload = (await req.json()) as {
      appId?: string;
      installationId?: string;
      pem?: string;
      webhookSecret?: string;
    };

    const appId = (payload.appId || "").trim();
    const installationId = (payload.installationId || "").trim();
    const pem = (payload.pem || "").trim();
    const webhookSecret = (payload.webhookSecret || "").trim();

    if (!appId || !installationId || !pem) {
      return json({ ok: false, error: "App ID, Installation ID, and PEM key are all required." }, 400);
    }

    if (!pem.includes("PRIVATE KEY")) {
      return json({ ok: false, error: "PEM does not look like a private key." }, 400);
    }

    // Save PEM to state dir
    const credDir = path.join(STATE_DIR, "credentials");
    fs.mkdirSync(credDir, { recursive: true });
    const pemPath = path.join(credDir, "github-app-private-key.pem");
    fs.writeFileSync(pemPath, pem, { encoding: "utf8", mode: 0o600 });

    const envHints = [
      `GITHUB_APP_ID=${appId}`,
      `GITHUB_INSTALLATION_ID=${installationId}`,
      `GITHUB_APP_PEM_PATH=${pemPath}`,
    ];
    if (webhookSecret) envHints.push(`GITHUB_WEBHOOK_SECRET=${webhookSecret}`);

    const output = [
      `✓ PEM saved to ${pemPath}`,
      "",
      "Set these Railway environment variables and redeploy:",
      ...envHints.map((e) => `  ${e}`),
      "",
      "After redeploy, the webhook proxy will be active at POST /github/webhook",
    ].join("\n");

    return json({ ok: true, output });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}

async function handleReset(): Promise<Response> {
  try {
    if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }
    const candidates = resolveConfigCandidates();
    for (const p of candidates) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
    return text("OK - stopped gateway and deleted config file(s). You can rerun setup now.");
  } catch (err) {
    return text(String(err), 500);
  }
}

async function handleExport(): Promise<Response> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);
  const dataRoot = "/data";
  const underData = (p: string) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = await tarCreate(cwd, paths);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
    },
  });
}

async function handleImport(req: Request): Promise<Response> {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return text("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data.\n", 400);
    }

    if (gatewayProc) { try { gatewayProc.kill(); } catch { /* ignore */ } await sleep(750); gatewayProc = null; }

    const buf = Buffer.from(await req.arrayBuffer());
    if (!buf.length) return text("Empty body\n", 400);

    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tarExtract(dataRoot, tmpPath);
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }

    if (isConfigured()) await restartGateway();
    return text("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    return text(String(err), 500);
  }
}

// ---------------------------------------------------------------------------
// HTTP proxy to gateway
// ---------------------------------------------------------------------------
async function proxyToGateway(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = `${GATEWAY_TARGET}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  if (!headers.get("authorization") && OPENCLAW_GATEWAY_TOKEN) {
    headers.set("authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  // Remove host header to avoid confusing the upstream
  headers.delete("host");

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.body,
      // @ts-ignore - Bun supports duplex
      duplex: "half",
    });

    // Clone response headers
    const respHeaders = new Headers(resp.headers);

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (err) {
    console.error("[proxy]", err);
    return text("Gateway unavailable\n", 502);
  }
}

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------
interface WSData {
  targetUrl: string;
  originHeader: string | null;
  upstream: WebSocket | null;
  buffered: (string | Buffer)[];
}

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bundle client-side TypeScript at startup
// ---------------------------------------------------------------------------
const setupAppBuildResult = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "setup-app.ts")],
  minify: true,
  target: "browser",
});
const setupAppBundle = setupAppBuildResult.success
  ? await setupAppBuildResult.outputs[0].text()
  : `console.error("Failed to bundle setup-app.ts");`;

// ---------------------------------------------------------------------------
// Bun.serve
// ---------------------------------------------------------------------------
const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!isConfigured()) {
        return new Response("Not configured", { status: 503 });
      }
      try {
        const addedOrigin = await ensureControlUiAllowedOrigin(publicOriginFromRequest(req));
        if (addedOrigin && gatewayProc) {
          await restartGateway();
        }
        await ensureGatewayRunning();
      } catch {
        return new Response("Gateway not ready", { status: 503 });
      }

      const wsTarget = `ws://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}${url.pathname}${url.search}`;

      const success = server.upgrade(req, {
        data: {
          targetUrl: wsTarget,
          originHeader: req.headers.get("origin"),
          upstream: null,
          buffered: [],
        } satisfies WSData,
      });

      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    return handleRequest(req);
  },

  websocket: {
    open(ws) {
      const data = ws.data as WSData;
      let targetUrl = data.targetUrl;

      // Inject auth token via query param for WS (headers not supported in WS constructor)
      const u = new URL(targetUrl);
      if (OPENCLAW_GATEWAY_TOKEN) {
        u.searchParams.set("token", OPENCLAW_GATEWAY_TOKEN);
      }
      targetUrl = u.toString();

      const wsHeaders: Record<string, string> = {};
      if (data.originHeader) wsHeaders.origin = data.originHeader;
      const upstream = new WebSocket(targetUrl, { headers: wsHeaders });

      upstream.onopen = () => {
        // Flush buffered messages
        for (const msg of data.buffered) {
          upstream.send(msg as any);
        }
        data.buffered = [];
      };

      upstream.onmessage = (event) => {
        try {
          ws.send(event.data as any);
        } catch { /* client gone */ }
      };

      upstream.onclose = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      upstream.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };

      data.upstream = upstream;
    },

    message(ws, message) {
      const data = ws.data as WSData;
      if (data.upstream && data.upstream.readyState === WebSocket.OPEN) {
        data.upstream.send(message);
      } else {
        data.buffered.push(message as any);
      }
    },

    close(ws) {
      const data = ws.data as WSData;
      if (data.upstream) {
        try { data.upstream.close(); } catch { /* ignore */ }
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log(`[wrapper] listening on :${PORT}`);
console.log(`[wrapper] state dir: ${STATE_DIR}`);
console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);

try { fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true }); } catch { /* ignore */ }
try { fs.chmodSync(STATE_DIR, 0o700); } catch { /* ignore */ }

console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
if (!SETUP_PASSWORD) console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");

const ghWebhookEnabled = !!(GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_APP_PEM_PATH);
console.log(`[wrapper] github webhook proxy: ${ghWebhookEnabled ? "enabled" : "disabled"} (POST /github/webhook)`);

// Bootstrap script
const bootstrapPath = path.join(WORKSPACE_DIR, "bootstrap.sh");
if (fs.existsSync(bootstrapPath)) {
  console.log(`[wrapper] running bootstrap: ${bootstrapPath}`);
  try {
    await runCmd("bash", [bootstrapPath], {
      env: { OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR },
      timeoutMs: 10 * 60 * 1000,
    });
    console.log("[wrapper] bootstrap complete");
  } catch (err) {
    console.warn(`[wrapper] bootstrap failed (continuing): ${String(err)}`);
  }
}

// Auto-start gateway
if (isConfigured()) {
  if (!entryExists()) {
    console.error(`[wrapper] OpenClaw entry not found at ${OPENCLAW_ENTRY} — cannot start gateway`);
    console.error("[wrapper] Visit /setup for next steps");
  } else {
    console.log("[wrapper] config detected; starting gateway...");
    try {
      await ensureGatewayRunning();
      console.log("[wrapper] gateway ready");
    } catch (err) {
      console.error(`[wrapper] gateway failed to start at boot: ${String(err)}`);
    }
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  try { if (gatewayProc) gatewayProc.kill(); } catch { /* ignore */ }
  try { server.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 5_000).unref?.();
});
