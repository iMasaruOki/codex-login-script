#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const WebSocket = require("ws");

function usage() {
  process.stdout.write(`Usage:
  remote-codex-login.sh [--yes] [--force]

Options:
  -y, --yes    Skip the initial confirmation prompt.
  -f, --force  Start login even if already logged in.
  -h, --help   Show this help.

This script starts \`codex login\`, launches Chromium on the remote host,
opens the ChatGPT login URL inside that browser, and lets you operate the page
from the terminal.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCapture(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function promptYesNo(prompt, defaultNo = true) {
  while (true) {
    const suffix = defaultNo ? " [y/N]: " : " [Y/n]: ";
    const answer = (await promptLine(prompt + suffix)).trim().toLowerCase();
    if (!answer) {
      return !defaultNo;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    process.stdout.write("Please answer y or n.\n");
  }
}

let activePrompt = null;

function promptLine(prompt) {
  return new Promise((resolve) => {
    if (activePrompt) {
      activePrompt.close();
    }
    activePrompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    activePrompt.question(prompt, (answer) => {
      activePrompt.close();
      activePrompt = null;
      resolve(answer);
    });
  });
}

function promptSecret(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    rl.question(prompt, (answer) => {
      rl.history = rl.history.slice(1);
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });

    rl._writeToOutput = function writeToOutput() {
      rl.output.write("*");
    };
  });
}

async function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function httpPut(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "PUT" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.end();
  });
}

function targetScore(target) {
  const url = target.url || "";
  if (url.includes("accounts.google.com")) {
    return 100;
  }
  if (url.includes("appleid.apple.com")) {
    return 90;
  }
  if (url.includes("login.live.com") || url.includes("microsoft")) {
    return 80;
  }
  if (url.includes("auth.openai.com")) {
    return 70;
  }
  if (url !== "about:blank") {
    return 10;
  }
  return 0;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.webSocketUrl);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.id && this.pending.has(message.id)) {
          const handlers = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            handlers.reject(new Error(message.error.message));
          } else {
            handlers.resolve(message.result || {});
          }
        }
      });
      this.ws.on("close", () => {
        for (const handlers of this.pending.values()) {
          handlers.reject(new Error("CDP connection closed"));
        }
        this.pending.clear();
      });
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close() {
    if (!this.ws) {
      return;
    }
    await new Promise((resolve) => {
      this.ws.once("close", resolve);
      this.ws.close();
    });
  }
}

async function waitForCodexBootstrap(child, logBuffer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = logBuffer.stdout + logBuffer.stderr;
    const authMatch = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\S+/);
    const portMatch = text.match(/http:\/\/localhost:(\d+)/);
    if (authMatch && portMatch) {
      return { authUrl: authMatch[0], loginPort: portMatch[1] };
    }
    if (child.exitCode !== null) {
      throw new Error("codex login exited before printing the browser URL");
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for codex login to print the browser URL");
}

async function waitForDevTools(proc, buffer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const combined = `${buffer.stdout || ""}${buffer.stderr || ""}`;
    const match = combined.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      return match[1];
    }
    if (proc.exitCode !== null) {
      throw new Error("Chromium exited before exposing DevTools");
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for Chromium DevTools");
}

async function terminateProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const result = await Promise.race([
    closed.then(() => "closed"),
    sleep(3000).then(() => "timeout"),
  ]);

  if (result === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function closeClient(client) {
  if (!client) {
    return;
  }
  if (client.ws && client.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    client.ws.terminate();
  } catch {}
}

function killProcessNow(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function visibleTextSnippet(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function formatElement(element, index) {
  const bits = [`[${index}]`, element.tag];
  if (element.type) {
    bits.push(`type=${element.type}`);
  }
  if (element.label) {
    bits.push(`label="${element.label}"`);
  }
  if (element.placeholder) {
    bits.push(`placeholder="${element.placeholder}"`);
  }
  if (element.value && element.type !== "password") {
    bits.push(`value="${element.value}"`);
  }
  if (element.options && element.options.length > 0) {
    bits.push(`options=${element.options.join(" | ")}`);
  }
  return bits.join("  ");
}

async function snapshotPage(client) {
  const expression = `(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const labelFor = new Map();
    for (const label of document.querySelectorAll('label[for]')) {
      labelFor.set(label.getAttribute('for'), (label.innerText || '').trim());
    }

    let nextId = 1;
    const elements = [];
    for (const el of document.querySelectorAll('input, textarea, button, a[href], select, [role="button"]')) {
      if (!isVisible(el)) continue;
      if (!el.dataset.codexLoginId) {
        el.dataset.codexLoginId = String(nextId++);
      }
      const id = el.dataset.codexLoginId;
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.getAttribute('type') || 'text') : '';
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const placeholder = el.getAttribute('placeholder') || '';
      const aria = el.getAttribute('aria-label') || '';
      const name = el.getAttribute('name') || '';
      const htmlId = el.getAttribute('id') || '';
      const value = tag === 'select' ? el.value : (el.value || '');
      const rect = el.getBoundingClientRect();
      const label = aria || labelFor.get(htmlId) || text || placeholder || name || htmlId || '';
      const options = tag === 'select'
        ? Array.from(el.options).map((option) => option.textContent.replace(/\\s+/g, ' ').trim()).filter(Boolean)
        : [];
      elements.push({
        id,
        tag,
        type,
        label,
        placeholder,
        name,
        value,
        options,
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2)
      });
    }

    return {
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').trim(),
      elements
    };
  })()`;

  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function navigate(client, url) {
  await client.call("Page.navigate", { url });
  await sleep(1200);
}

async function hardenBrowserSession(client) {
  await client.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    `,
  });

  const version = await client.call("Browser.getVersion");
  const userAgent = (version.userAgent || "").replace("HeadlessChrome", "Chrome");
  if (userAgent) {
    await client.call("Network.setUserAgentOverride", { userAgent });
  }
}

async function clickElement(client, elementId) {
  const expression = `(() => {
    const el = document.querySelector('[data-codex-login-id="${elementId}"]');
    if (!el) return 'missing';
    el.click();
    return 'ok';
  })()`;
  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function clickElementAt(client, x, y) {
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function setElementValue(client, elementId, value) {
  const payload = JSON.stringify(value);
  const expression = `(() => {
    const el = document.querySelector('[data-codex-login-id="${elementId}"]');
    if (!el) return 'missing';
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const option = Array.from(el.options).find((candidate) =>
        candidate.textContent.trim() === ${payload} || candidate.value === ${payload}
      );
      if (!option) return 'no-option';
      el.value = option.value;
    } else {
      el.focus();
      el.value = ${payload};
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`;
  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function submitActiveElement(client) {
  const expression = `(() => {
    const el = document.activeElement;
    if (!el) return 'missing';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    if (el.form) {
      el.form.requestSubmit();
    }
    return 'ok';
  })()`;
  const result = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function listPageTargets(debugPort) {
  const targets = await httpGetJson(`http://127.0.0.1:${debugPort}/json/list`);
  return targets.filter((target) => target.type === "page");
}

async function maybeSwitchTarget(state, previousUrl = "") {
  const targets = await listPageTargets(state.debugPort);
  const current = targets.find((target) => target.id === state.targetId);

  const candidates = targets
    .filter((target) => target.id !== state.targetId)
    .map((target) => ({ target, score: targetScore(target) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return false;
  }

  const best = candidates[0].target;
  const currentUrl = current?.url || previousUrl || "";
  if (best.url === currentUrl && candidates[0].score < 100) {
    return false;
  }

  await closeClient(state.client);
  state.client = new CdpClient(best.webSocketDebuggerUrl);
  await state.client.connect();
  await state.client.call("Page.enable");
  await state.client.call("Runtime.enable");
  await state.client.call("Network.enable");
  state.targetId = best.id;
  state.webSocketDebuggerUrl = best.webSocketDebuggerUrl;
  process.stdout.write(`Switched to browser target: ${best.url || "(untitled)"}\n`);
  return true;
}

function findElement(snapshot, index) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= snapshot.elements.length) {
    return null;
  }
  return snapshot.elements[numericIndex];
}

function renderSnapshot(snapshot) {
  process.stdout.write("\n");
  process.stdout.write(`Page: ${snapshot.title || "(untitled)"}\n`);
  process.stdout.write(`${snapshot.url}\n`);
  process.stdout.write("\n");

  const textLines = visibleTextSnippet(snapshot.text || "");
  if (textLines.length > 0) {
    process.stdout.write("Visible text:\n");
    for (const line of textLines) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write("\n");
  }

  if (snapshot.elements.length > 0) {
    process.stdout.write("Controls:\n");
    snapshot.elements.forEach((element, index) => {
      process.stdout.write(`  ${formatElement(element, index)}\n`);
    });
  } else {
    process.stdout.write("No visible controls detected.\n");
  }

  process.stdout.write("\n");
  process.stdout.write("Commands:\n");
  process.stdout.write("  click N      click control N\n");
  process.stdout.write("  fill N       enter text into control N\n");
  process.stdout.write("  secret N     enter hidden text into control N\n");
  process.stdout.write("  choose N     choose an option for select control N\n");
  process.stdout.write("  enter        submit the focused field or form\n");
  process.stdout.write("  back         go back\n");
  process.stdout.write("  open URL     navigate to URL\n");
  process.stdout.write("  wait         wait and refresh\n");
  process.stdout.write("  show         refresh now\n");
  process.stdout.write("  quit         stop the helper\n");
  process.stdout.write("\n");
}

async function interactiveLoop(state, codexChild) {
  while (true) {
    const snapshot = await snapshotPage(state.client);
    renderSnapshot(snapshot);

    if (codexChild.exitCode !== null) {
      return;
    }

    const commandLine = (await promptLine("> ")).trim();
    if (!commandLine) {
      continue;
    }

    const [command, ...rest] = commandLine.split(" ");

    if (command === "quit" || command === "exit") {
      return "quit";
    }

    if (command === "show") {
      continue;
    }

    if (command === "wait") {
      await sleep(1500);
      continue;
    }

    if (command === "back") {
      await state.client.call("Page.goBack");
      await sleep(1200);
      continue;
    }

    if (command === "open") {
      const url = rest.join(" ").trim();
      if (!url) {
        process.stdout.write("Usage: open URL\n");
        continue;
      }
      await navigate(state.client, url);
      continue;
    }

    if (command === "enter") {
      await submitActiveElement(state.client);
      await sleep(1200);
      await maybeSwitchTarget(state, snapshot.url);
      continue;
    }

    if (command === "click") {
      const element = findElement(snapshot, rest[0]);
      if (!element) {
        process.stdout.write("Unknown control index.\n");
        continue;
      }
      if (Number.isFinite(element.x) && Number.isFinite(element.y)) {
        await clickElementAt(state.client, element.x, element.y);
      } else {
        await clickElement(state.client, element.id);
      }
      await sleep(1200);
      await maybeSwitchTarget(state, snapshot.url);
      continue;
    }

    if (command === "fill" || command === "secret" || command === "choose") {
      const element = findElement(snapshot, rest[0]);
      if (!element) {
        process.stdout.write("Unknown control index.\n");
        continue;
      }

      let value;
      if (command === "secret") {
        value = await promptSecret(`Value for control ${rest[0]}: `);
      } else if (command === "choose") {
        process.stdout.write(`Options: ${element.options.join(" | ")}\n`);
        value = await promptLine(`Option for control ${rest[0]}: `);
      } else {
        value = await promptLine(`Value for control ${rest[0]}: `);
      }

      const outcome = await setElementValue(state.client, element.id, value);
      if (outcome === "no-option") {
        process.stdout.write("No matching option.\n");
      }
      await sleep(500);
      continue;
    }

    process.stdout.write("Unknown command.\n");
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function chooseBrowserBinary() {
  if (process.env.BROWSER_BIN) {
    return process.env.BROWSER_BIN;
  }
  for (const candidate of ["chromium", "google-chrome"]) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No supported browser found. Set BROWSER_BIN.");
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function main() {
  let assumeYes = false;
  let forceLogin = false;
  let exitCode = null;
  let quitRequested = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === "-y" || arg === "--yes") {
      assumeYes = true;
      continue;
    }
    if (arg === "-f" || arg === "--force") {
      forceLogin = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      return;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  const status = await execCapture("codex", ["login", "status"]);
  const statusOutput = `${status.stdout}${status.stderr}`.trim() || "Not logged in.";

  process.stdout.write("Codex remote login helper\n\n");
  process.stdout.write("This helper launches a remote Chromium instance and lets you operate the ChatGPT sign-in page from the terminal.\n\n");
  process.stdout.write("Current login status:\n");
  process.stdout.write(`${statusOutput}\n\n`);

  if (!assumeYes) {
    if (statusOutput.startsWith("Logged in") && !forceLogin) {
      const ok = await promptYesNo("Codex is already logged in. Start login again?");
      if (!ok) {
        process.stdout.write("Cancelled.\n");
        return;
      }
    } else {
      const ok = await promptYesNo("Start ChatGPT login now?");
      if (!ok) {
        process.stdout.write("Cancelled.\n");
        return;
      }
    }
  }

  const codexLog = { stdout: "", stderr: "" };
  const codexChild = spawn("codex", ["login"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  codexChild.stdin.write("\n");
  codexChild.stdin.end();
  codexChild.stdout.on("data", (chunk) => {
    codexLog.stdout += chunk.toString();
  });
  codexChild.stderr.on("data", (chunk) => {
    codexLog.stderr += chunk.toString();
  });

  const { authUrl, loginPort } = await waitForCodexBootstrap(codexChild, codexLog);
  process.stdout.write("Starting browser on the remote host.\n");
  process.stdout.write(`Codex callback port: ${loginPort}\n\n`);

  const browserUserDataDir = createTempDir("codex-login-browser-");
  const browserBuffer = { stdout: "", stderr: "" };
  const browserBinary = chooseBrowserBinary();
  const browserArgs = [
    "--disable-gpu",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${browserUserDataDir}`,
    "about:blank",
  ];
  let browserMode = "headless";
  let browserCommand = browserBinary;
  let browserCommandArgs = ["--headless=new", ...browserArgs];

  if (commandExists("xvfb-run")) {
    browserMode = "xvfb";
    browserCommand = "xvfb-run";
    browserCommandArgs = ["-a", browserBinary, ...browserArgs];
  }

  const browserChild = spawn(browserCommand, browserCommandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  browserChild.stdout.on("data", (chunk) => {
    browserBuffer.stdout += chunk.toString();
  });
  browserChild.stderr.on("data", (chunk) => {
    browserBuffer.stderr += chunk.toString();
  });

  let state = null;

  const cleanup = async () => {
    if (activePrompt) {
      activePrompt.close();
      activePrompt = null;
    }
    if (state?.client) {
      await closeClient(state.client);
    }
    await Promise.allSettled([
      terminateProcess(browserChild),
      terminateProcess(codexChild),
    ]);
    try {
      fs.rmSync(browserUserDataDir, { recursive: true, force: true });
    } catch {}
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(1);
  });

  try {
    const browserWs = await waitForDevTools(browserChild, browserBuffer);
    const browserDebugPort = new URL(browserWs).port;
    const pageInfo = await httpPut(`http://127.0.0.1:${browserDebugPort}/json/new?about:blank`);
    const page = JSON.parse(pageInfo);

    const client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Network.enable");
    await hardenBrowserSession(client);
    await navigate(client, authUrl);
    state = {
      client,
      debugPort: browserDebugPort,
      targetId: page.id,
      webSocketDebuggerUrl: page.webSocketDebuggerUrl,
    };

    process.stdout.write(`The browser page is open on the remote host (${browserMode} mode).\n`);
    process.stdout.write("Use the terminal commands below to fill fields and click buttons.\n");
    process.stdout.write("Passkeys and CAPTCHA may still require a different auth path.\n");

    const loopResult = await interactiveLoop(state, codexChild);
    if (loopResult === "quit") {
      process.stdout.write("Cancelled.\n");
      exitCode = 0;
      quitRequested = true;
    } else {
      await new Promise((resolve) => codexChild.once("close", resolve));
      process.stdout.write("\nAuthentication completed.\n\n");
      const postStatus = await execCapture("codex", ["login", "status"]);
      const postOutput = `${postStatus.stdout}${postStatus.stderr}`.trim() || "Unknown";
      process.stdout.write("Login status after authentication:\n");
      process.stdout.write(`${postOutput}\n`);
    }
  } finally {
    if (quitRequested) {
      if (state?.client) {
        await closeClient(state.client);
      }
      killProcessNow(browserChild);
      killProcessNow(codexChild);
      try {
        fs.rmSync(browserUserDataDir, { recursive: true, force: true });
      } catch {}
      process.exit(0);
    }
    await cleanup();
  }

  if (exitCode !== null) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
