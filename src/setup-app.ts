// Served at /setup/app.js — Pinax-branded OpenClaw Setup (client-side)

// ---------------------------------------------------------------------------
// Custom modal system (replaces window.alert/confirm/prompt)
// ---------------------------------------------------------------------------
function createModal(): {
  alert: (msg: string) => Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
  prompt: (label: string, opts?: { placeholder?: string; type?: string; select?: string[] }) => Promise<string | null>;
} {
  // Overlay
  const overlay = document.createElement("div");
  overlay.id = "modalOverlay";
  overlay.style.cssText = "display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center;backdrop-filter:blur(2px)";

  const box = document.createElement("div");
  box.style.cssText = "background:var(--surface);border:1px solid var(--border-hover);border-radius:12px;padding:1.5rem 2rem;max-width:420px;width:90%;color:var(--text);font-family:var(--font)";
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  function show(html: string): { box: HTMLDivElement; close: () => void } {
    box.innerHTML = html;
    overlay.style.display = "flex";
    return {
      box,
      close: () => { overlay.style.display = "none"; },
    };
  }

  function btnHtml(label: string, cls: string, id: string): string {
    return `<button id="${id}" class="btn ${cls}" style="min-width:80px">${label}</button>`;
  }

  return {
    alert(msg: string): Promise<void> {
      return new Promise((resolve) => {
        const { box: b, close } = show(`
          <div style="margin-bottom:1rem;line-height:1.5">${msg}</div>
          <div style="display:flex;justify-content:flex-end">${btnHtml("OK", "btn-primary", "modalOk")}</div>
        `);
        b.querySelector("#modalOk")!.addEventListener("click", () => { close(); resolve(); });
      });
    },

    confirm(msg: string): Promise<boolean> {
      return new Promise((resolve) => {
        const { box: b, close } = show(`
          <div style="margin-bottom:1rem;line-height:1.5">${msg}</div>
          <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            ${btnHtml("Cancel", "btn-secondary", "modalCancel")}
            ${btnHtml("Confirm", "btn-primary", "modalOk")}
          </div>
        `);
        b.querySelector("#modalCancel")!.addEventListener("click", () => { close(); resolve(false); });
        b.querySelector("#modalOk")!.addEventListener("click", () => { close(); resolve(true); });
      });
    },

    prompt(label: string, opts?: { placeholder?: string; type?: string; select?: string[] }): Promise<string | null> {
      return new Promise((resolve) => {
        let inputHtml: string;
        if (opts?.select) {
          const options = opts.select.map((v) => `<option value="${v}">${v}</option>`).join("");
          inputHtml = `<select id="modalInput" style="width:100%;padding:0.55rem 0.75rem;margin-top:0.5rem;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--font);font-size:0.85rem">${options}</select>`;
        } else {
          inputHtml = `<input id="modalInput" type="${opts?.type ?? "text"}" placeholder="${opts?.placeholder ?? ""}" style="width:100%;padding:0.55rem 0.75rem;margin-top:0.5rem;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--font);font-size:0.85rem" />`;
        }
        const { box: b, close } = show(`
          <div style="margin-bottom:0.25rem;font-weight:500">${label}</div>
          ${inputHtml}
          <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
            ${btnHtml("Cancel", "btn-secondary", "modalCancel")}
            ${btnHtml("OK", "btn-primary", "modalOk")}
          </div>
        `);
        const input = b.querySelector("#modalInput") as HTMLInputElement | HTMLSelectElement;
        input.focus();
        const submit = () => { close(); resolve(input.value || null); };
        b.querySelector("#modalCancel")!.addEventListener("click", () => { close(); resolve(null); });
        b.querySelector("#modalOk")!.addEventListener("click", submit);
        if (input.tagName === "INPUT") {
          input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
        }
      });
    },
  };
}

interface AuthOption {
  value: string;
  label: string;
}

interface AuthGroup {
  value: string;
  label: string;
  hint?: string;
  options: AuthOption[];
}

interface StatusResponse {
  configured: boolean;
  entryExists?: boolean;
  gatewayTarget?: string;
  openclawVersion?: string;
  authGroups?: AuthGroup[];
}

interface ConfigResponse {
  ok: boolean;
  path?: string;
  exists?: boolean;
  content?: string;
}

interface ConsoleResponse {
  ok: boolean;
  output?: string;
}

interface DevicesResponse {
  ok: boolean;
  requestIds?: string[];
  output?: string;
}

(function () {
  const $ = (id: string) => document.getElementById(id);
  const modal = createModal();

  const statusEl = $("status")!;
  const statusDetailsEl = $("statusDetails");
  const authGroupEl = $("authGroup") as HTMLSelectElement;
  const authChoiceEl = $("authChoice") as HTMLSelectElement;
  const logEl = $("log") as HTMLPreElement;
  const consoleCmdEl = $("consoleCmd") as HTMLSelectElement;
  const consoleArgEl = $("consoleArg") as HTMLInputElement | null;
  const consoleRunEl = $("consoleRun");
  const consoleOutEl = $("consoleOut") as HTMLPreElement | null;
  const configPathEl = $("configPath");
  const configTextEl = $("configText") as HTMLTextAreaElement | null;
  const configReloadEl = $("configReload");
  const configSaveEl = $("configSave");
  const configOutEl = $("configOut") as HTMLPreElement | null;
  const importFileEl = $("importFile") as HTMLInputElement | null;
  const importRunEl = $("importRun");
  const importOutEl = $("importOut") as HTMLPreElement | null;

  // ---------------------------------------------------------------------------
  // Accordion logic
  // ---------------------------------------------------------------------------
  document.querySelectorAll<HTMLButtonElement>(".accordion-trigger").forEach((btn) => {
    const content = btn.nextElementSibling as HTMLElement;

    // After expand transition ends, switch to max-height:none so content is never clipped
    content.addEventListener("transitionend", () => {
      if (btn.getAttribute("aria-expanded") === "true") {
        content.style.maxHeight = "none";
      }
    });

    btn.addEventListener("click", () => {
      const isOpen = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!isOpen));
      if (!isOpen) {
        // Set explicit height first to trigger CSS transition, then let transitionend switch to none
        content.style.maxHeight = content.scrollHeight + "px";
        content.style.opacity = "1";
      } else {
        // Collapse: first pin current height, then force reflow, then set to 0
        content.style.maxHeight = content.scrollHeight + "px";
        content.offsetHeight; // force reflow
        content.style.maxHeight = "0";
        content.style.opacity = "0";
      }
    });
  });

  // Auto-open first section (deferred so fonts/content are ready)
  requestAnimationFrame(() => {
    const firstTrigger = document.querySelector<HTMLButtonElement>(".accordion-trigger");
    if (firstTrigger) firstTrigger.click();
  });

  // ---------------------------------------------------------------------------
  // Auth provider rendering
  // ---------------------------------------------------------------------------
  function isInteractiveOAuth(optionValue: string, optionLabel: string): boolean {
    const v = String(optionValue || "");
    const l = String(optionLabel || "");
    return l.includes("OAuth") || v.includes("cli") || v.includes("codex") || v.includes("portal");
  }

  function renderAuth(groups: AuthGroup[]): void {
    authGroupEl.innerHTML = "";

    let advancedToggle = $("showAdvancedAuth") as HTMLInputElement | null;
    if (!advancedToggle) {
      const label = document.createElement("label");
      label.className = "toggle-label";
      label.innerHTML = '<input type="checkbox" id="showAdvancedAuth" /> Show interactive OAuth options';
      authGroupEl.parentNode!.insertBefore(label, authChoiceEl);
    }

    for (const g of groups) {
      const opt = document.createElement("option");
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? " — " + g.hint : "");
      authGroupEl.appendChild(opt);
    }

    function rerenderChoices(): void {
      const sel = groups.find((g) => g.value === authGroupEl.value) ?? null;
      authChoiceEl.innerHTML = "";
      const opts = sel?.options ?? [];
      const showAdv = Boolean(($("showAdvancedAuth") as HTMLInputElement | null)?.checked);

      let firstNonInteractive: string | null = null;
      for (const o of opts) {
        const interactive = isInteractiveOAuth(o.value, o.label);
        if (interactive && !showAdv) continue;
        if (!interactive && !firstNonInteractive) firstNonInteractive = o.value;

        const opt2 = document.createElement("option");
        opt2.value = o.value;
        opt2.textContent = o.label + (interactive ? " (interactive)" : "");
        authChoiceEl.appendChild(opt2);
      }
      if (firstNonInteractive) authChoiceEl.value = firstNonInteractive;
    }

    authGroupEl.onchange = rerenderChoices;
    advancedToggle = $("showAdvancedAuth") as HTMLInputElement | null;
    if (advancedToggle) advancedToggle.onchange = rerenderChoices;
    rerenderChoices();
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------
  async function httpJson<T = any>(url: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(url, { credentials: "same-origin", ...opts });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t || res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------
  async function refreshStatus(): Promise<void> {
    statusEl.textContent = "Checking...";
    if (statusDetailsEl) statusDetailsEl.textContent = "";

    try {
      const j = await httpJson<StatusResponse>("/setup/api/status");
      const ver = j.openclawVersion ?? "";
      let badge: string;
      if (j.entryExists === false) {
        badge = '<span class="badge badge-err">Not installed</span>';
      } else if (j.configured) {
        badge = '<span class="badge badge-ok">Configured</span>';
      } else {
        badge = '<span class="badge badge-warn">Not configured</span>';
      }
      statusEl.innerHTML = badge + (ver ? ` <span class="version-tag">${ver}</span>` : "");

      if (statusDetailsEl) {
        statusDetailsEl.textContent = j.entryExists === false
          ? "OpenClaw binary not found — check Dockerfile build"
          : `Gateway: ${j.gatewayTarget ?? "(unknown)"}`;
      }

      if (configReloadEl && configTextEl) loadConfigRaw();
    } catch (e) {
      statusEl.innerHTML = `<span class="badge badge-err">Error</span> ${String(e)}`;
    }
  }

  async function loadAuthGroupsFast(): Promise<void> {
    try {
      const j = await httpJson<{ authGroups?: AuthGroup[] }>("/setup/api/auth-groups");
      if (j.authGroups?.length) {
        renderAuth(j.authGroups);
        return;
      }
      throw new Error("Missing authGroups");
    } catch {
      renderAuth([]);
    }
  }

  // ---------------------------------------------------------------------------
  // Run setup
  // ---------------------------------------------------------------------------
  $("run")!.onclick = async () => {
    const payload = {
      flow: ($("flow") as HTMLSelectElement).value,
      authChoice: authChoiceEl.value,
      authSecret: ($("authSecret") as HTMLInputElement).value,
      telegramToken: ($("telegramToken") as HTMLInputElement).value,
      discordToken: ($("discordToken") as HTMLInputElement).value,
      slackBotToken: ($("slackBotToken") as HTMLInputElement).value,
      slackAppToken: ($("slackAppToken") as HTMLInputElement).value,
      customProviderId: ($("customProviderId") as HTMLInputElement).value,
      customProviderBaseUrl: ($("customProviderBaseUrl") as HTMLInputElement).value,
      customProviderApi: ($("customProviderApi") as HTMLSelectElement).value,
      customProviderApiKeyEnv: ($("customProviderApiKeyEnv") as HTMLInputElement).value,
      customProviderModelId: ($("customProviderModelId") as HTMLInputElement).value,
    };
    logEl.textContent = "Running setup...\n";
    try {
      const res = await fetch("/setup/api/run", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let j: { ok?: boolean; output?: string };
      try { j = JSON.parse(text); } catch { j = { ok: false, output: text }; }
      logEl.textContent += j.output ?? JSON.stringify(j, null, 2);
      await refreshStatus();
    } catch (e) {
      logEl.textContent += `\nError: ${String(e)}\n`;
    }
  };

  // ---------------------------------------------------------------------------
  // Debug console
  // ---------------------------------------------------------------------------
  async function runConsole(): Promise<void> {
    const cmd = consoleCmdEl.value;
    const arg = consoleArgEl?.value ?? "";
    if (consoleOutEl) consoleOutEl.textContent = `$ ${cmd}${arg ? " " + arg : ""}\n`;
    try {
      const j = await httpJson<ConsoleResponse>("/setup/api/console/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd, arg }),
      });
      if (consoleOutEl) consoleOutEl.textContent += j.output ?? JSON.stringify(j, null, 2);
      await refreshStatus();
    } catch (e) {
      if (consoleOutEl) consoleOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (consoleRunEl) consoleRunEl.onclick = runConsole;

  // Gateway restart button
  const gatewayRestartEl = $("gatewayRestart");
  if (gatewayRestartEl) {
    gatewayRestartEl.onclick = async () => {
      logEl.textContent = "Restarting gateway...\n";
      try {
        const j = await httpJson<ConsoleResponse>("/setup/api/console/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd: "gateway.restart" }),
        });
        logEl.textContent += j.output ?? "Done.\n";
        await refreshStatus();
      } catch (e) {
        logEl.textContent += `Error: ${String(e)}\n`;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Config editor
  // ---------------------------------------------------------------------------
  async function loadConfigRaw(): Promise<void> {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.textContent = "";
    try {
      const j = await httpJson<ConfigResponse>("/setup/api/config/raw");
      if (configPathEl) configPathEl.textContent = (j.path ?? "") + (j.exists ? "" : " (not created yet)");
      configTextEl.value = j.content ?? "";
    } catch (e) {
      if (configOutEl) configOutEl.textContent = `Error: ${String(e)}`;
    }
  }

  async function saveConfigRaw(): Promise<void> {
    if (!configTextEl) return;
    if (!await modal.confirm("Save config and restart gateway?")) return;
    if (configOutEl) configOutEl.textContent = "Saving...\n";
    try {
      const j = await httpJson<{ ok: boolean; path?: string }>("/setup/api/config/raw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: configTextEl.value }),
      });
      if (configOutEl) configOutEl.textContent = `Saved → ${j.path ?? ""}\nGateway restarted.`;
      await refreshStatus();
    } catch (e) {
      if (configOutEl) configOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------
  async function runImport(): Promise<void> {
    const f = importFileEl?.files?.[0];
    if (!f) { await modal.alert("Pick a .tar.gz file first"); return; }
    if (!await modal.confirm("Import backup? This overwrites files and restarts the gateway.")) return;
    if (importOutEl) importOutEl.textContent = `Uploading ${f.name}...\n`;
    try {
      const buf = await f.arrayBuffer();
      const res = await fetch("/setup/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/gzip" },
        body: buf,
      });
      const t = await res.text();
      if (importOutEl) importOutEl.textContent += t + "\n";
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${t}`);
      await refreshStatus();
    } catch (e) {
      if (importOutEl) importOutEl.textContent += `\nError: ${String(e)}\n`;
    }
  }
  if (importRunEl) importRunEl.onclick = runImport;

  // ---------------------------------------------------------------------------
  // Pairing
  // ---------------------------------------------------------------------------
  const pairingBtn = $("pairingApprove");
  if (pairingBtn) {
    pairingBtn.onclick = async () => {
      const channel = await modal.prompt("Channel", { select: ["telegram", "discord", "slack"] });
      if (!channel) return;
      const code = await modal.prompt("Pairing code", { placeholder: "Enter pairing code" });
      if (!code) return;
      logEl.textContent += `\nApproving ${channel} pairing...\n`;
      try {
        const res = await fetch("/setup/api/pairing/approve", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel, code: code.trim() }),
        });
        const t = await res.text();
        logEl.textContent += t + "\n";
      } catch (e) {
        logEl.textContent += `Error: ${String(e)}\n`;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Device pairing
  // ---------------------------------------------------------------------------
  const devicesRefreshBtn = $("devicesRefresh");
  const devicesListEl = $("devicesList");

  async function approveDevice(requestId: string): Promise<void> {
    if (!await modal.confirm(`Approve device <code>${requestId}</code>?`)) return;
    if (devicesListEl) devicesListEl.textContent = "Approving...";
    try {
      const j = await httpJson<{ output?: string }>("/setup/api/devices/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (devicesListEl) devicesListEl.textContent = j.output ?? "Approved.";
      await refreshStatus();
    } catch (e) {
      if (devicesListEl) devicesListEl.textContent = `Error: ${String(e)}`;
    }
  }

  async function refreshDevices(): Promise<void> {
    if (!devicesListEl) return;
    devicesListEl.textContent = "Loading...";
    try {
      const j = await httpJson<DevicesResponse>("/setup/api/devices/pending");
      const ids = j.requestIds ?? [];
      if (!ids.length) {
        devicesListEl.textContent = "No pending requests.";
        return;
      }
      devicesListEl.innerHTML = "";
      for (const id of ids) {
        const row = document.createElement("div");
        row.style.marginTop = "0.25rem";
        const btn = document.createElement("button");
        btn.className = "btn btn-sm";
        btn.textContent = `Approve ${id}`;
        btn.onclick = () => approveDevice(id);
        row.appendChild(btn);
        devicesListEl.appendChild(row);
      }
    } catch (e) {
      devicesListEl.textContent = `Error: ${String(e)}`;
    }
  }
  if (devicesRefreshBtn) devicesRefreshBtn.onclick = refreshDevices;

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  $("reset")!.onclick = async () => {
    if (!await modal.confirm("Reset setup? This deletes the config so you can re-run onboarding.")) return;
    logEl.textContent = "Resetting...\n";
    try {
      const res = await fetch("/setup/api/reset", { method: "POST", credentials: "same-origin" });
      const t = await res.text();
      logEl.textContent += t + "\n";
      await refreshStatus();
    } catch (e) {
      logEl.textContent += `Error: ${String(e)}\n`;
    }
  };

  // ---------------------------------------------------------------------------
  // GitHub Webhook status
  // ---------------------------------------------------------------------------
  async function refreshWebhookStatus(): Promise<void> {
    const badgeEl = $("webhookBadge");
    const configEl = $("webhookConfig");

    try {
      const j = await httpJson<{
        enabled: boolean;
        config: Record<string, string | boolean>;
      }>("/setup/api/webhook/status");

      if (badgeEl) {
        badgeEl.innerHTML = j.enabled
          ? '<span class="badge badge-ok">Webhook</span>'
          : '<span class="badge badge-warn">Webhook off</span>';
      }

      if (configEl) {
        const rows = Object.entries(j.config).map(([key, val]) => {
          const display = typeof val === "boolean" ? (val ? "✓ exists" : "✗ missing") : String(val);
          const isSet = display !== "(not set)" && display !== "✗ missing";
          return `<div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid var(--border)">
            <code style="font-size:0.78rem">${key}</code>
            <span style="color:${isSet ? "var(--aqua)" : "var(--text-dim)"};font-size:0.8rem">${display}</span>
          </div>`;
        });
        configEl.innerHTML = rows.join("");
      }
    } catch (e) {
      if (badgeEl) badgeEl.innerHTML = '<span class="badge badge-err">Webhook error</span>';
      if (configEl) configEl.textContent = `Error: ${String(e)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Channel env display
  // ---------------------------------------------------------------------------
  const channelEnvListEl = $("channelEnvList");

  async function refreshChannelEnv(): Promise<void> {
    if (!channelEnvListEl) return;
    try {
      const j = await httpJson<{ ok: boolean; env: Record<string, string> }>("/setup/api/channels/env");
      const entries = Object.entries(j.env || {});
      if (!entries.length) {
        channelEnvListEl.innerHTML = '<span style="color:var(--text-dim)">No channel-related environment variables set.</span>';
        return;
      }
      channelEnvListEl.innerHTML = entries.map(([key, val]) =>
        `<div style="display:flex;justify-content:space-between;padding:0.3rem 0;border-bottom:1px solid var(--border)">` +
        `<code style="font-size:0.78rem">${key}</code>` +
        `<span style="color:var(--aqua);font-size:0.8rem;font-family:var(--mono)">${val}</span>` +
        `</div>`
      ).join("");
    } catch (e) {
      channelEnvListEl.textContent = `Error: ${String(e)}`;
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub App config save
  // ---------------------------------------------------------------------------
  const githubAppSaveBtn = $("githubAppSave");
  const githubAppOutEl = $("githubAppOut") as HTMLPreElement | null;

  if (githubAppSaveBtn) {
    githubAppSaveBtn.onclick = async () => {
      const payload = {
        appId: ($("githubAppId") as HTMLInputElement)?.value || "",
        installationId: ($("githubInstallationId") as HTMLInputElement)?.value || "",
        pem: ($("githubAppPem") as HTMLTextAreaElement)?.value || "",
        webhookSecret: ($("githubWebhookSecret") as HTMLInputElement)?.value || "",
      };
      if (githubAppOutEl) githubAppOutEl.textContent = "Saving...\n";
      try {
        const j = await httpJson<{ ok: boolean; output?: string; error?: string }>("/setup/api/github-app/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (githubAppOutEl) githubAppOutEl.textContent = j.ok ? (j.output || "Saved.") : ("Error: " + (j.error || "Unknown"));
        await refreshWebhookStatus();
      } catch (e) {
        if (githubAppOutEl) githubAppOutEl.textContent = `Error: ${String(e)}`;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Bootstrap / workspace files
  // ---------------------------------------------------------------------------
  const bootstrapStatusEl = $("bootstrapStatus");
  const bootstrapFilesEl = $("bootstrapFiles");
  const bootstrapWorkspaceDirEl = $("bootstrapWorkspaceDir");
  const bootstrapReloadEl = $("bootstrapReload");

  function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }

  async function refreshBootstrap(): Promise<void> {
    if (!bootstrapFilesEl || !bootstrapStatusEl) return;
    bootstrapStatusEl.textContent = "Loading…";
    bootstrapFilesEl.innerHTML = "";
    try {
      const j = await httpJson<{
        ok: boolean;
        workspaceDir: string;
        pending: boolean;
        files: { name: string; path: string; exists: boolean; size: number; content: string }[];
      }>("/setup/api/workspace/bootstrap");

      if (bootstrapWorkspaceDirEl) bootstrapWorkspaceDirEl.textContent = j.workspaceDir;

      bootstrapStatusEl.innerHTML = j.pending
        ? '<span class="badge badge-warn">Bootstrap pending</span> Agent has not completed its first run.'
        : '<span class="badge badge-ok">Bootstrap complete</span> Identity files present.';

      bootstrapFilesEl.innerHTML = j.files.map((f) => {
        const badge = f.exists
          ? `<span class="badge badge-ok">${f.size} B</span>`
          : '<span class="badge badge-warn">missing</span>';
        const body = f.exists
          ? (f.content
              ? `<pre style="white-space:pre-wrap;max-height:400px;overflow:auto">${escHtml(f.content)}</pre>`
              : `<div class="muted">File too large to inline (${f.size} B). Read on the gateway host: <code>${escHtml(f.path)}</code></div>`)
          : `<div class="muted">Not present at <code>${escHtml(f.path)}</code></div>`;
        return `<details style="margin-top:0.5rem;border:1px solid var(--border);border-radius:8px;padding:0.5rem 0.75rem">
          <summary style="cursor:pointer;font-weight:500"><code>${escHtml(f.name)}</code> ${badge}</summary>
          ${body}
        </details>`;
      }).join("");
    } catch (e) {
      bootstrapStatusEl.innerHTML = `<span class="badge badge-err">Error</span> ${String(e)}`;
    }
  }
  if (bootstrapReloadEl) bootstrapReloadEl.onclick = refreshBootstrap;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  loadAuthGroupsFast();
  refreshStatus();
  refreshWebhookStatus();
  refreshChannelEnv();
  refreshBootstrap();
})();
