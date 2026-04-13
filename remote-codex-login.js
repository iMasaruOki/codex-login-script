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

function execCaptureEnv(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseTesseractTsv(tsvText) {
  const lines = tsvText.split("\n").filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }

  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("\t");
    if (parts.length < 12) {
      continue;
    }
    const [level, pageNum, blockNum, parNum, lineNum, wordNum, left, top, width, height, conf, ...rest] = parts;
    const text = rest.join("\t").trim();
    rows.push({
      level: Number(level),
      pageNum: Number(pageNum),
      blockNum: Number(blockNum),
      parNum: Number(parNum),
      lineNum: Number(lineNum),
      wordNum: Number(wordNum),
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
      conf: Number(conf),
      text,
    });
  }
  return rows;
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
    this.eventHandlers = new Map();
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
        } else if (message.method) {
          const handlers = this.eventHandlers.get(message.method) || [];
          for (const handler of handlers) {
            try {
              handler(message.params || {});
            } catch {}
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

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
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
  throw new Error(`Timed out waiting for Chromium DevTools\n${(buffer.stdout || "")}${(buffer.stderr || "")}`.trim());
}

async function waitForXvfbEnv(proc, buffer) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const combined = `${buffer.stdout || ""}${buffer.stderr || ""}`;
    const match = combined.match(/XVFB_ENV:([^|\s]+)\|([^\n\r]*)/);
    if (match) {
      return {
        DISPLAY: match[1],
        XAUTHORITY: match[2] || "",
      };
    }
    if (proc.exitCode !== null) {
      throw new Error("Browser launcher exited before exposing xvfb environment");
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for xvfb environment");
}

async function captureOcrSnapshot(state) {
  const pngPath = path.join(os.tmpdir(), `codex-login-${Date.now()}.png`);
  try {
    const env = { ...process.env, ...state.xDisplayEnv };
    const importResult = await execCaptureEnv(
      "import",
      ["-display", state.xDisplayEnv.DISPLAY, "-window", "root", pngPath],
      env,
    );
    if (importResult.code !== 0) {
      throw new Error(importResult.stderr || importResult.stdout || "import failed");
    }

    const tsvResult = await execCaptureEnv(
      "tesseract",
      [pngPath, "stdout", "--psm", "11", "tsv"],
      env,
    );
    if (tsvResult.code !== 0) {
      throw new Error(tsvResult.stderr || tsvResult.stdout || "tesseract failed");
    }

    const rows = parseTesseractTsv(tsvResult.stdout);
    const words = rows.filter((row) => row.level === 5 && row.text && row.conf >= 0);
    const grouped = new Map();
    for (const word of words) {
      const key = `${word.pageNum}:${word.blockNum}:${word.parNum}:${word.lineNum}`;
      const bucket = grouped.get(key) || [];
      bucket.push(word);
      grouped.set(key, bucket);
    }

    const elements = Array.from(grouped.values())
      .map((bucket, index) => {
        bucket.sort((a, b) => a.left - b.left);
        const label = bucket.map((word) => word.text).join(" ").trim();
        const left = Math.min(...bucket.map((word) => word.left));
        const top = Math.min(...bucket.map((word) => word.top));
        const right = Math.max(...bucket.map((word) => word.left + word.width));
        const bottom = Math.max(...bucket.map((word) => word.top + word.height));
        return {
          id: String(index),
          tag: "text",
          type: "",
          label,
          placeholder: "",
          name: "",
          value: "",
          options: [],
          left,
          top,
          right,
          bottom,
          x: left + ((right - left) / 2),
          y: top + ((bottom - top) / 2),
        };
      })
      .filter((entry) => entry.label);

    return {
      title: "OCR snapshot",
      url: state.lastSeenUrl || "(screen)",
      text: elements.map((entry) => entry.label).join("\n"),
      elements,
    };
  } finally {
    try {
      fs.rmSync(pngPath, { force: true });
    } catch {}
  }
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

function pushDebugEvent(state, event) {
  state.debugEvents.push({
    ...event,
    at: new Date().toISOString(),
  });
  if (state.debugEvents.length > 40) {
    state.debugEvents.splice(0, state.debugEvents.length - 40);
  }
}

function isInterestingAuthUrl(url = "") {
  return url.includes("auth.openai.com/api/accounts/authorize/continue");
}

function trimText(value, maxLength = 500) {
  if (!value) {
    return "";
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

async function hardenBrowserSession(client, options = {}) {
  const { browserMode = "headless" } = options;
  if (browserMode !== "headless") {
    return;
  }

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

async function attachDebugListeners(state) {
  const client = state.client;
  client.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "")
      .filter(Boolean)
      .join(" ");
    pushDebugEvent(state, {
      type: "console",
      level: params.type || "log",
      text,
    });
  });

  client.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    pushDebugEvent(state, {
      type: "exception",
      level: "error",
      text: details.text || details.exception?.description || "Runtime exception",
    });
  });

  client.on("Log.entryAdded", (params) => {
    const entry = params.entry || {};
    pushDebugEvent(state, {
      type: "log",
      level: entry.level || "info",
      text: `${entry.source || "log"}: ${entry.text || ""}`.trim(),
    });
  });

  client.on("Network.requestWillBeSent", (params) => {
    const request = params.request || {};
    if (isInterestingAuthUrl(request.url)) {
      state.interestingRequests.set(params.requestId, {
        url: request.url,
        method: request.method || "GET",
        requestHeaders: request.headers || {},
        requestPostData: request.postData || "",
      });
    }
    pushDebugEvent(state, {
      type: "request",
      level: "info",
      text: `${request.method || "GET"} ${request.url || ""}`.trim(),
    });
  });

  client.on("Network.responseReceived", (params) => {
    const response = params.response || {};
    if (state.interestingRequests.has(params.requestId)) {
      const detail = state.interestingRequests.get(params.requestId);
      detail.status = response.status;
      detail.responseHeaders = response.headers || {};
      detail.mimeType = response.mimeType || "";
      detail.responseUrl = response.url || detail.url;
    }
    pushDebugEvent(state, {
      type: "response",
      level: response.status >= 400 ? "error" : "info",
      text: `${response.status || ""} ${response.url || ""}`.trim(),
    });
  });

  client.on("Network.requestWillBeSentExtraInfo", (params) => {
    if (!state.interestingRequests.has(params.requestId)) {
      return;
    }
    const detail = state.interestingRequests.get(params.requestId);
    detail.requestExtraHeaders = params.headers || {};
  });

  client.on("Network.responseReceivedExtraInfo", (params) => {
    if (!state.interestingRequests.has(params.requestId)) {
      return;
    }
    const detail = state.interestingRequests.get(params.requestId);
    detail.responseExtraHeaders = params.headers || {};
    detail.responseStatusCode = params.statusCode;
  });

  client.on("Network.loadingFinished", async (params) => {
    if (!state.interestingRequests.has(params.requestId)) {
      return;
    }
    const detail = state.interestingRequests.get(params.requestId);
    try {
      const bodyResult = await client.call("Network.getResponseBody", {
        requestId: params.requestId,
      });
      detail.responseBody = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body, "base64").toString("utf8")
        : bodyResult.body;
    } catch (error) {
      detail.responseBody = `Failed to read response body: ${error.message}`;
    }
  });

  client.on("Network.loadingFailed", (params) => {
    pushDebugEvent(state, {
      type: "network",
      level: "error",
      text: `${params.errorText || "loading failed"} ${params.canceled ? "(canceled)" : ""}`.trim(),
    });
  });

  await client.call("Log.enable");
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
  const startX = Math.max(1, x - 24);
  const startY = Math.max(1, y - 12);
  const steps = 4;

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    await client.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: startX + ((x - startX) * progress),
      y: startY + ((y - startY) * progress),
      button: "none",
      pointerType: "mouse",
    });
    await sleep(35);
  }

  await sleep(80);
  await client.call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
  await sleep(55);
  await client.call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    pointerType: "mouse",
  });
}

async function getWindowMetrics(client) {
  const result = await client.call("Runtime.evaluate", {
    expression: `(() => ({
      screenX: window.screenX || 0,
      screenY: window.screenY || 0,
      outerWidth: window.outerWidth || 0,
      outerHeight: window.outerHeight || 0,
      innerWidth: window.innerWidth || 0,
      innerHeight: window.innerHeight || 0
    }))()`,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value;
}

async function toAbsolutePoint(state, x, y) {
  if (!state.client) {
    return {
      x: Math.round(x),
      y: Math.round(y),
    };
  }
  const metrics = await getWindowMetrics(state.client);
  const horizontalBorder = Math.max(0, (metrics.outerWidth - metrics.innerWidth) / 2);
  const verticalChrome = Math.max(0, metrics.outerHeight - metrics.innerHeight - horizontalBorder);
  return {
    x: Math.round(metrics.screenX + horizontalBorder + x),
    y: Math.round(metrics.screenY + verticalChrome + y),
  };
}

async function xdotool(state, args) {
  const env = { ...process.env, ...state.xDisplayEnv };
  const result = await execCaptureEnv("xdotool", args, env);
  if (result.code !== 0) {
    throw new Error(`xdotool failed: ${result.stderr || result.stdout}`.trim());
  }
  return result;
}

async function clickElementHuman(state, x, y) {
  const point = await toAbsolutePoint(state, x, y);
  await xdotool(state, ["mousemove", "--sync", String(point.x), String(point.y)]);
  await sleep(120);
  await xdotool(state, ["click", "--delay", "80", "1"]);
}

async function openUrlInBrowserChrome(state, url) {
  await xdotool(state, ["key", "--clearmodifiers", "ctrl+l"]);
  await sleep(150);
  await xdotool(state, ["type", "--delay", "20", "--clearmodifiers", url]);
  await sleep(120);
  await xdotool(state, ["key", "--clearmodifiers", "Return"]);
}

function isChromeInterruptionSnapshot(snapshot) {
  const text = `${snapshot.title || ""}\n${snapshot.text || ""}`;
  return /can't update chrome|finish update|chrome couldn't update|restore pages|restore/i.test(text);
}

async function stabilizeOcrBrowser(state, authUrl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await openUrlInBrowserChrome(state, authUrl);
    await sleep(1800);
    const snapshot = await captureOcrSnapshot(state);
    state.lastSnapshot = snapshot;
    const text = `${snapshot.title || ""}\n${snapshot.text || ""}`;
    if (/welcome back|enter your password|continue with google|email address/i.test(text)) {
      state.lastSeenUrl = authUrl;
      return;
    }
    if (!isChromeInterruptionSnapshot(snapshot) && snapshot.elements.length > 0) {
      state.lastSeenUrl = authUrl;
      return;
    }
  }
}

async function setElementValue(state, elementId, value) {
  const client = state.client;
  if (!client && state.xDisplayEnv) {
    const element = state.lastSnapshot ? findElement(state.lastSnapshot, Number(elementId)) : null;
    if (!element) {
      return "missing";
    }
    let targetX = element.x;
    let targetY = element.y;
    if (/\b(email|password|phone|code|address)\b/i.test(element.label || "")) {
      const left = element.left || element.x;
      const right = element.right || element.x;
      const bottom = element.bottom || element.y;
      targetX = Math.min(left + Math.max(220, (right - left) + 180), 1180);
      targetY = bottom + 22;
    }
    await clickElementHuman(state, targetX, targetY);
    await sleep(120);
    await xdotool(state, ["key", "--clearmodifiers", "ctrl+a"]);
    await sleep(80);
    await xdotool(state, ["key", "--clearmodifiers", "BackSpace"]);
    await sleep(80);
    await xdotool(state, ["type", "--delay", "45", "--clearmodifiers", value]);
    return "ok";
  }

  const payload = JSON.stringify(value);
  const prepareExpression = `(() => {
    const el = document.querySelector('[data-codex-login-id="${elementId}"]');
    if (!el) return 'missing';
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      const option = Array.from(el.options).find((candidate) =>
        candidate.textContent.trim() === ${payload} || candidate.value === ${payload}
      );
      if (!option) return 'no-option';
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }

    el.focus();

    if (tag === 'input' || tag === 'textarea') {
      const prototype = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, '');
      } else {
        el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ready-for-typing';
    }

    el.textContent = ${payload};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`;
  const prepared = await client.call("Runtime.evaluate", {
    expression: prepareExpression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (prepared.result.value !== 'ready-for-typing') {
    return prepared.result.value;
  }

  if (state.xDisplayEnv) {
    const element = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('[data-codex-login-id="${elementId}"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2) };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    const point = element.result.value;
    if (!point) {
      return "missing";
    }
    await clickElementHuman(state, point.x, point.y);
    await sleep(120);
    await xdotool(state, ["key", "--clearmodifiers", "ctrl+a"]);
    await sleep(80);
    await xdotool(state, ["key", "--clearmodifiers", "BackSpace"]);
    await sleep(80);
    await xdotool(state, ["type", "--delay", "45", "--clearmodifiers", value]);
  } else {
    await client.call("Input.insertText", { text: value });
  }

  const finalize = await client.call("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector('[data-codex-login-id="${elementId}"]');
      if (!el) return 'missing';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return el.value || '';
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  return finalize.result.value === value ? 'ok' : 'verify-failed';
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
  await attachDebugListeners(state);
  state.targetId = best.id;
  state.webSocketDebuggerUrl = best.webSocketDebuggerUrl;
  process.stdout.write(`Switched to browser target: ${best.url || "(untitled)"}\n`);
  return true;
}

function renderDebugEvents(state, onlyErrors = false) {
  const events = onlyErrors
    ? state.debugEvents.filter((event) => event.level === "error").slice(-10)
    : state.debugEvents.slice(-12);

  if (events.length === 0) {
    process.stdout.write("No debug events captured.\n");
    return;
  }

  process.stdout.write("Recent debug events:\n");
  for (const event of events) {
    process.stdout.write(`  [${event.level}] ${event.type}: ${event.text}\n`);
  }
}

function renderInterestingRequests(state) {
  const entries = Array.from(state.interestingRequests.values()).slice(-3);
  if (entries.length === 0) {
    process.stdout.write("No detailed auth requests captured.\n");
    return;
  }

  process.stdout.write("Detailed auth request traces:\n");
  for (const entry of entries) {
    process.stdout.write(`  ${entry.method} ${entry.url}\n`);
    if (entry.status) {
      process.stdout.write(`    status: ${entry.status}\n`);
    }
    if (entry.requestHeaders) {
      const headerKeys = ["content-type", "origin", "referer", "x-requested-with", "sec-fetch-site", "sec-fetch-mode"];
      for (const key of headerKeys) {
        const foundKey = Object.keys(entry.requestHeaders).find((name) => name.toLowerCase() === key);
        if (foundKey) {
          process.stdout.write(`    req ${foundKey}: ${trimText(String(entry.requestHeaders[foundKey]), 180)}\n`);
        }
      }
    }
    if (entry.requestExtraHeaders) {
      const headerKeys = ["cookie", "origin", "referer", "user-agent", "x-csrf-token", "authorization"];
      for (const key of headerKeys) {
        const foundKey = Object.keys(entry.requestExtraHeaders).find((name) => name.toLowerCase() === key);
        if (foundKey) {
          process.stdout.write(`    req+ ${foundKey}: ${trimText(String(entry.requestExtraHeaders[foundKey]), 220)}\n`);
        }
      }
    }
    if (entry.requestPostData) {
      process.stdout.write(`    req body: ${trimText(entry.requestPostData, 220)}\n`);
    }
    if (entry.responseHeaders) {
      const headerKeys = ["content-type", "location", "server"];
      for (const key of headerKeys) {
        const foundKey = Object.keys(entry.responseHeaders).find((name) => name.toLowerCase() === key);
        if (foundKey) {
          process.stdout.write(`    res ${foundKey}: ${trimText(String(entry.responseHeaders[foundKey]), 180)}\n`);
        }
      }
    }
    if (entry.responseExtraHeaders) {
      const headerKeys = ["cf-mitigated", "set-cookie", "content-type", "location", "server"];
      for (const key of headerKeys) {
        const foundKey = Object.keys(entry.responseExtraHeaders).find((name) => name.toLowerCase() === key);
        if (foundKey) {
          process.stdout.write(`    res+ ${foundKey}: ${trimText(String(entry.responseExtraHeaders[foundKey]), 220)}\n`);
        }
      }
    }
    if (entry.responseBody) {
      process.stdout.write(`    res body: ${trimText(entry.responseBody.replace(/\s+/g, " "), 260)}\n`);
    }
  }
}

async function renderCookies(state) {
  const result = await state.client.call("Network.getCookies", {
    urls: ["https://auth.openai.com/", "https://chatgpt.com/"],
  });
  const cookies = result.cookies || [];
  if (cookies.length === 0) {
    process.stdout.write("No cookies captured for auth.openai.com or chatgpt.com.\n");
    return;
  }

  process.stdout.write("Current cookies:\n");
  for (const cookie of cookies) {
    process.stdout.write(
      `  ${cookie.domain}  ${cookie.name}=${trimText(cookie.value, 80)}  secure=${cookie.secure ? "yes" : "no"} httpOnly=${cookie.httpOnly ? "yes" : "no"}\n`,
    );
  }
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
  process.stdout.write("  key KEYS     send raw key sequence in OCR/X11 mode\n");
  process.stdout.write("  diag         show recent debug events\n");
  process.stdout.write("  diagerr      show recent error events\n");
  process.stdout.write("  diagreq      show detailed auth request traces\n");
  process.stdout.write("  cookies      show current auth cookies\n");
  process.stdout.write("  quit         stop the helper\n");
  process.stdout.write("\n");
}

async function interactiveLoop(state, codexChild) {
  while (true) {
    const snapshot = state.mode === "ocr"
      ? await captureOcrSnapshot(state)
      : await snapshotPage(state.client);
    state.lastSnapshot = snapshot;
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

    if (command === "diag") {
      renderDebugEvents(state, false);
      continue;
    }

    if (command === "diagerr") {
      renderDebugEvents(state, true);
      continue;
    }

    if (command === "diagreq") {
      renderInterestingRequests(state);
      continue;
    }

    if (command === "cookies") {
      await renderCookies(state);
      continue;
    }

    if (command === "wait") {
      await sleep(1500);
      continue;
    }

    if (command === "key") {
      if (!state.xDisplayEnv) {
        process.stdout.write("`key` is only available in OCR/X11 mode.\n");
        continue;
      }
      const keys = rest.join(" ").trim();
      if (!keys) {
        process.stdout.write("Usage: key KEYS\n");
        continue;
      }
      await xdotool(state, ["key", "--clearmodifiers", keys]);
      await sleep(700);
      continue;
    }

    if (command === "back") {
      if (state.client) {
        await state.client.call("Page.goBack");
      } else {
        await xdotool(state, ["key", "--clearmodifiers", "Alt_L+Left"]);
      }
      await sleep(1200);
      continue;
    }

    if (command === "open") {
      const url = rest.join(" ").trim();
      if (!url) {
        process.stdout.write("Usage: open URL\n");
        continue;
      }
      if (state.client) {
        await navigate(state.client, url);
      } else {
        process.stdout.write("`open` is unavailable in OCR mode.\n");
      }
      continue;
    }

    if (command === "enter") {
      state.debugEvents.length = 0;
      state.interestingRequests.clear();
      if (state.client) {
        await submitActiveElement(state.client);
      } else {
        await xdotool(state, ["key", "--clearmodifiers", "Return"]);
      }
      await sleep(1200);
      if (state.client) {
        await maybeSwitchTarget(state, snapshot.url);
        renderDebugEvents(state, true);
      }
      continue;
    }

    if (command === "click") {
      const element = findElement(snapshot, rest[0]);
      if (!element) {
        process.stdout.write("Unknown control index.\n");
        continue;
      }
      state.debugEvents.length = 0;
      state.interestingRequests.clear();
      if (Number.isFinite(element.x) && Number.isFinite(element.y)) {
        if (state.xDisplayEnv) {
          await clickElementHuman(state, element.x, element.y);
        } else {
          await clickElementAt(state.client, element.x, element.y);
        }
      } else {
        await clickElement(state.client, element.id);
      }
      await sleep(1200);
      if (state.client) {
        await maybeSwitchTarget(state, snapshot.url);
        renderDebugEvents(state, true);
      }
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

      const outcome = await setElementValue(state, element.id, value);
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function prepareBrowserProfileDir(baseDir) {
  ensureDir(baseDir);
  const sessionDir = createTempDir("codex-login-browser-");
  for (const entry of fs.readdirSync(baseDir)) {
    if (
      entry.startsWith("Singleton") ||
      entry === "DevToolsActivePort" ||
      entry === "lockfile" ||
      entry === ".org.chromium.Chromium" ||
      entry === ".com.google.Chrome"
    ) {
      continue;
    }
    fs.cpSync(path.join(baseDir, entry), path.join(sessionDir, entry), {
      recursive: true,
      force: true,
    });
  }
  return sessionDir;
}

function chooseBrowserBinary() {
  if (process.env.BROWSER_BIN) {
    return process.env.BROWSER_BIN;
  }
  for (const candidate of ["google-chrome", "chromium"]) {
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

  const browserBinary = chooseBrowserBinary();
  const browserProfileRoot = ensureDir(path.join(process.cwd(), ".browser-profile"));
  const browserProfileBaseDir = process.env.BROWSER_PROFILE_DIR
    ? ensureDir(process.env.BROWSER_PROFILE_DIR)
    : ensureDir(path.join(browserProfileRoot, browserBinary.replace(/[^a-zA-Z0-9._-]/g, "_")));
  const browserUserDataDir = prepareBrowserProfileDir(browserProfileBaseDir);
  const browserBuffer = { stdout: "", stderr: "" };
  let browserMode = "headless";
  let browserCommand = browserBinary;

  if (commandExists("xvfb-run")) {
    browserMode = "xvfb";
  }
  const useOcrMode = browserMode === "xvfb" && commandExists("xdotool") && commandExists("import") && commandExists("tesseract");
  const browserStartUrl = browserMode === "xvfb" ? authUrl : "about:blank";
  const browserArgs = [
    "--hide-crash-restore-bubble",
    "--disable-background-networking",
    "--disable-component-update",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "--window-position=0,0",
    `--user-data-dir=${browserUserDataDir}`,
  ];

  let browserCommandArgs;
  if (browserMode === "headless") {
    browserCommandArgs = [
      "--headless=new",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--remote-debugging-port=0",
      ...browserArgs,
      browserStartUrl,
    ];
  } else if (useOcrMode) {
    browserCommand = "xvfb-run";
    const browserCommandLine = [
      browserBinary,
      ...browserArgs,
      browserStartUrl,
    ].map(shellQuote).join(" ");
    browserCommandArgs = [
      "-a",
      "bash",
      "-lc",
      `printf 'XVFB_ENV:%s|%s\n' "$DISPLAY" "\${XAUTHORITY:-}"; exec ${browserCommandLine}`,
    ];
  } else {
    browserCommand = "xvfb-run";
    const browserCommandLine = [
      browserBinary,
      "--disable-gpu",
      "--remote-debugging-port=0",
      ...browserArgs,
      browserStartUrl,
    ].map(shellQuote).join(" ");
    browserCommandArgs = [
      "-a",
      "bash",
      "-lc",
      `printf 'XVFB_ENV:%s|%s\n' "$DISPLAY" "\${XAUTHORITY:-}"; exec ${browserCommandLine}`,
    ];
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
    const xDisplayEnv = browserMode === "xvfb" ? await waitForXvfbEnv(browserChild, browserBuffer) : null;
    if (browserMode === "xvfb") {
      await sleep(5000);
    }
    if (useOcrMode) {
      state = {
        client: null,
        debugPort: null,
        debugEvents: [],
        interestingRequests: new Map(),
        lastSeenUrl: authUrl,
        lastSnapshot: null,
        mode: "ocr",
        xDisplayEnv,
        targetId: null,
        webSocketDebuggerUrl: null,
      };
      await stabilizeOcrBrowser(state, authUrl);
    } else {
      const browserWs = await waitForDevTools(browserChild, browserBuffer);
      const browserDebugPort = new URL(browserWs).port;
      let page;
      if (browserMode === "xvfb") {
        const targets = await listPageTargets(browserDebugPort);
        page = targets
          .map((target) => ({ target, score: targetScore(target) }))
          .sort((a, b) => b.score - a.score)[0]?.target;
        if (!page) {
          throw new Error("No browser page target found");
        }
      } else {
        const pageInfo = await httpPut(`http://127.0.0.1:${browserDebugPort}/json/new?about:blank`);
        page = JSON.parse(pageInfo);
      }

      const client = new CdpClient(page.webSocketDebuggerUrl);
      await client.connect();
      await client.call("Page.enable");
      await client.call("Runtime.enable");
      await client.call("Network.enable");
      await hardenBrowserSession(client, { browserMode });
      if (browserMode !== "xvfb") {
        await navigate(client, authUrl);
      }
      state = {
        client,
        debugPort: browserDebugPort,
        debugEvents: [],
        interestingRequests: new Map(),
        lastSeenUrl: authUrl,
        lastSnapshot: null,
        mode: "dom",
        xDisplayEnv,
        targetId: page.id,
        webSocketDebuggerUrl: page.webSocketDebuggerUrl,
      };
      await attachDebugListeners(state);
    }

    process.stdout.write(`The browser page is open on the remote host (${browserMode} mode).\n`);
    if (useOcrMode) {
      process.stdout.write("OCR mode is active. Screen text is detected from screenshots, and input is sent through X11.\n");
    }
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
