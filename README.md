# OpenClaw Railway Template (1‑click deploy)

This repo packages **OpenClaw** for Railway with a **/setup** web wizard so users can deploy and onboard without running any commands.

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A **Setup Wizard** at `/setup` (protected by a password)
- Persistent state via **Railway Volume** (config/credentials/memory survive redeploys)
- One-click **Export/Import backup** from `/setup`
- **GitHub Webhook Proxy** at `/github/webhook` for GitHub App integrations

## Deploy on Railway

In Railway Template Composer:

1. Create a new template from this GitHub repo
2. Add a **Volume** mounted at `/data`
3. Enable **Public Networking** (HTTP)
4. Set the required environment variables (see below)
5. Deploy

Then visit `https://<your-app>.up.railway.app/setup` to complete setup.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SETUP_PASSWORD` | Password to access the `/setup` wizard |

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Where OpenClaw stores config and state |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Agent workspace directory |
| `OPENCLAW_GATEWAY_TOKEN` | _(auto-generated)_ | Token for authenticating with the gateway. In a template, use a Railway generated secret |

### GitHub App (optional)

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID (from app settings) |
| `GITHUB_INSTALLATION_ID` | Installation ID for your org/user |
| `GITHUB_APP_PEM_PATH` | Path to the app's private key PEM file (e.g. `/data/.openclaw/credentials/github-app-private-key.pem`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret (must match what's configured in the GitHub App) |

### Slack App (optional)

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) — configured via `/setup` or directly in OpenClaw config |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) for Socket Mode |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_GATEWAY_PORT` | `18789` | Internal port for the OpenClaw gateway (wrapper proxies to this) |
| `OPENCLAW_ENTRY` | `/openclaw/dist/entry.js` | Path to OpenClaw entry point |
| `OPENCLAW_GIT_REF` | _(pinned tag)_ | Docker build arg — Git ref to build OpenClaw from |

## Setting up a GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **App name**: whatever you like (e.g. `my-openclaw-bot`)
   - **Homepage URL**: your Railway app URL
   - **Webhook URL**: `https://<your-app>.up.railway.app/github/webhook`
   - **Webhook secret**: generate a random secret
3. Set permissions:
   - **Repository**: Issues (Read & Write), Pull requests (Read & Write), Contents (Read)
   - **Organization**: Members (Read) — if needed
4. Subscribe to events: Issues, Issue comment, Pull request, Pull request review
5. Create the app → note the **App ID**
6. Generate a **private key** (PEM file) and download it
7. Install the app on your org/user → note the **Installation ID** from the URL

Then either:
- Use `/setup` → **GitHub App & Webhook Proxy** section to upload the PEM and save config
- Or set the Railway environment variables directly (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PEM_PATH`, `GITHUB_WEBHOOK_SECRET`)

The webhook proxy will:
- Verify HMAC signatures
- Add 👀 reactions to new issues, PRs, and comments
- Forward events to OpenClaw hooks for agent processing

## Setting up a Slack App

1. Go to **[api.slack.com/apps](https://api.slack.com/apps)** → **Create New App** → **From scratch**
2. Name it and select your workspace
3. **OAuth & Permissions** → Add bot token scopes:
   - `chat:write`, `reactions:read`, `reactions:write`
   - `channels:history`, `channels:read`, `groups:history`, `groups:read`
   - `im:history`, `im:read`, `im:write`
   - `users:read`
   - `pins:read`, `pins:write` (if using pin features)
4. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
5. **Socket Mode** → Enable it → generate an **App-Level Token** (`xapp-...`) with `connections:write` scope
6. **Event Subscriptions** → Enable → Subscribe to bot events:
   - `message.channels`, `message.groups`, `message.im`
   - `app_mention`

Then enter both tokens in `/setup` → Channels section, or set them directly in the OpenClaw config.

## Persistence (Railway volume)

Railway containers have an ephemeral filesystem. Only the mounted volume at `/data` persists.

**Persists:**
- OpenClaw state and config (`OPENCLAW_STATE_DIR`)
- Agent workspace (`OPENCLAW_WORKSPACE_DIR`)
- npm/pnpm global installs (configured to `/data/npm`, `/data/pnpm`)
- Python venvs (create under `/data`)

**Does not persist:**
- `apt-get install` (installs to `/usr/*`)
- Anything outside `/data`

### Bootstrap hook

If `/data/workspace/bootstrap.sh` exists, the wrapper runs it on startup before starting the gateway.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Example: persistent python venv
python3 -m venv /data/venv || true

# Example: ensure npm/pnpm dirs exist
mkdir -p /data/npm /data/npm-cache /data/pnpm /data/pnpm-store
```

## Local development

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```

To smoke-test that `/` reaches the OpenClaw gateway for a specific release:

```bash
npm run smoke:gateway -- v2026.4.23
```

The smoke test builds the Docker image with that `OPENCLAW_GIT_REF`, starts it on `http://localhost:18080`, seeds the minimum gateway config, and fails if `/` still redirects to `/setup` or returns a wrapper gateway error.

## Troubleshooting

### "disconnected (1008): pairing required"

The gateway is running but no device has been approved.

Fix: Open `/setup` → use the Debug Console → `openclaw devices list` → `openclaw devices approve <requestId>`

### "unauthorized: gateway token mismatch"

The Control UI and gateway have different tokens.

Fix: Re-run `/setup` or ensure `gateway.auth.token` and `gateway.remote.token` match in config.

### "Application failed to respond" / 502

The gateway can't start or bind.

Checklist:
- Volume mounted at `/data`
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- Public Networking enabled
- Check Railway logs for errors
- Visit `/setup/api/debug` for diagnostics

### Build OOM

Building OpenClaw from source needs memory. Use a plan with **2GB+ RAM**.

## Support

- GitHub Issues: https://github.com/pinax-network/openclaw-railway-template/issues
- Discord: https://discord.com/invite/clawd

---

Officially recommended by OpenClaw: <https://docs.openclaw.ai/railway>

Created and maintained by **Vignesh N (@vignesh07)**
