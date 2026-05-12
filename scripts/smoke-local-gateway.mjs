#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ref = process.argv[2] || "v2026.4.23";
const port = Number(process.env.SMOKE_PORT || "18080");
const image = `openclaw-railway-template:${ref.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
const name = `openclaw-railway-smoke-${Date.now()}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-railway-smoke-"));
const gatewayToken = "local-smoke-gateway-token";

function run(cmd, args, opts = {}) {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    ...opts,
  });
  if (result.status !== 0) {
    if (opts.capture) {
      process.stderr.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
    }
    throw new Error(`${cmd} exited with ${result.status}`);
  }
  return result;
}

function cleanup(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr);
}

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      headers: { "User-Agent": "openclaw-railway-smoke" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForWrapper() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await request("/setup/healthz");
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrapper did not become reachable: ${lastError}`);
}

async function main() {
  run("docker", ["build", "--build-arg", `OPENCLAW_GIT_REF=${ref}`, "-t", image, "."]);

  const child = spawn("docker", [
    "run", "--rm",
    "--name", name,
    "-p", `${port}:8080`,
    "-e", "PORT=8080",
    "-e", "SETUP_PASSWORD=test",
    "-e", `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
    "-e", "OPENCLAW_STATE_DIR=/data/.openclaw",
    "-e", "OPENCLAW_WORKSPACE_DIR=/data/workspace",
    "-v", `${dataDir}:/data`,
    image,
  ], { stdio: "inherit" });

  try {
    await waitForWrapper();

    for (const [key, value] of [
      ["gateway.auth.mode", "token"],
      ["gateway.auth.token", gatewayToken],
      ["gateway.remote.token", gatewayToken],
      ["gateway.bind", "loopback"],
      ["gateway.port", "18789"],
    ]) {
      run("docker", ["exec", name, "openclaw", "config", "set", key, value]);
    }
    run("docker", ["exec", name, "openclaw", "config", "set", "--json", "gateway.trustedProxies", "[\"127.0.0.1\"]"]);
    run("docker", ["exec", name, "openclaw", "config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify([`http://127.0.0.1:${port}`])]);

    const health = await request("/healthz");
    console.log(`/healthz -> ${health.status}`);
    console.log(health.body);

    const root = await request("/");
    console.log(`/ -> ${root.status}`);
    console.log(root.body.slice(0, 500));

    if (root.status === 302 && root.headers.location === "/setup") {
      throw new Error("/ still redirects to /setup; wrapper does not consider itself configured");
    }
    if (/OpenClaw Not Installed|Gateway Not Ready|Gateway unavailable/.test(root.body)) {
      throw new Error("/ returned a wrapper gateway error instead of the OpenClaw gateway response");
    }

    console.log("smoke ok: / is reaching the OpenClaw gateway");
  } finally {
    cleanup("docker", ["rm", "-f", name]);
    fs.rmSync(dataDir, { recursive: true, force: true });
    child.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
