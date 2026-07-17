// Chromium Bridge — MCP server.
// WebSocket server for the browser extension + a full browser-automation toolset
// in the spirit of the official Claude in Chrome: coordinate clicks, keyboard,
// screenshots, accessibility tree with refs, console, network, JS, forms,
// file uploads, GIF recording.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { query, tool as sdkTool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const PORT = Number(process.env.CHROMIUM_BRIDGE_PORT) || 8929;

let sock = null;
let nextId = 1;
const pending = new Map();

// The plain-GET HTTP response lets the extension probe for the server silently:
// a caught fetch error does not show up in the extension's error list, unlike
// a failed `new WebSocket()`.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('chromium-bridge');
});
httpServer.listen(PORT, '127.0.0.1');
httpServer.on('error', (e) => console.error('[chromium-bridge] http server error:', e.message));

const wss = new WebSocketServer({
  server: httpServer,
  // Browser extensions only: regular pages have an https://… Origin
  verifyClient: (info) => (info.origin || '').startsWith('chrome-extension://'),
});

wss.on('connection', (ws, req) => {
  if (req.url && req.url.startsWith('/chat')) {
    handleChatConnection(ws);
    return;
  }
  sock = ws;
  console.error('[chromium-bridge] extension connected');
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  ws.on('close', () => { if (sock === ws) sock = null; });
});

wss.on('error', (e) => console.error('[chromium-bridge] ws server error:', e.message));

function connected() {
  return !!(sock && sock.readyState === 1);
}

// The browser's service worker can sleep for up to ~30 seconds between keepalive alarms.
async function waitForSock(ms = 12000) {
  const deadline = Date.now() + ms;
  while (!connected() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
  }
  return connected();
}

async function call(cmd, args = {}, timeoutMs = 20000) {
  if (!(await waitForSock())) {
    throw new Error('The Chromium Bridge extension is not connected. Check that the browser is running and the extension is loaded (chrome://extensions).');
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, cmd, args }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`The extension did not respond within ${timeoutMs / 1000}s (command ${cmd})`));
    }, timeoutMs);
  });
}

const server = new McpServer({ name: 'chromium-bridge', version: '0.5.0' });

// Each tool is registered twice: in the stdio MCP server (for Claude Code)
// and in toolDefs — the in-process MCP server for the chat panel is built from it.
const toolDefs = [];
function defTool(name, description, shape, handler) {
  toolDefs.push({ name, description, shape, handler });
  server.tool(name, description, shape, handler);
}

const text = (v) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});
const image = (dataUrl) => ({
  content: [{ type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' }],
});

const MODIFIER_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
function parseModifiers(str) {
  if (!str) return 0;
  let bits = 0;
  for (const p of str.split('+')) {
    const bit = MODIFIER_BITS[p.trim().toLowerCase()];
    if (!bit) throw new Error('unknown modifier: ' + p);
    bits |= bit;
  }
  return bits;
}

// ===== Basic tools =====

defTool(
  'browser_status',
  'Check whether the browser extension is connected to the bridge',
  {},
  async () => {
    if (!connected()) await waitForSock(3000);
    if (!connected()) return text({ connected: false });
    await call('ping');
    return text({ connected: true });
  },
);

defTool(
  'browser_tabs_list',
  'List open browser tabs (id, title, URL)',
  {},
  async () => text(await call('tabs_list')),
);

defTool(
  'browser_tab_create',
  'Open a new browser tab',
  { url: z.string().optional().describe('URL for the new tab (blank by default)') },
  async ({ url }) => text(await call('tab_create', { url })),
);

defTool(
  'browser_tab_close',
  'Close a browser tab by id',
  { tabId: z.number() },
  async ({ tabId }) => text(await call('tab_close', { tabId })),
);

defTool(
  'browser_navigate',
  'Navigate the given tab to a URL; url may be "back" or "forward" for history navigation',
  { tabId: z.number(), url: z.string() },
  async ({ tabId, url }) => text(await call('navigate', { tabId, url })),
);

defTool(
  'browser_page_text',
  'Get the page title, URL, and visible text',
  { tabId: z.number() },
  async ({ tabId }) => text(await call('page_text', { tabId })),
);

// ===== Computer control (analogous to the official extension's `computer`) =====

defTool(
  'browser_computer',
  'Mouse, keyboard, and screenshots in a browser tab (via the DevTools protocol; the tab does not need to be active). ' +
  'Actions: screenshot, zoom (region), left_click, right_click, double_click, triple_click, hover, ' +
  'left_click_drag (start_coordinate→coordinate), type (text), key (text = space-separated combos, e.g. "cmd+a Backspace"), ' +
  'scroll (scroll_direction+scroll_amount), scroll_to (ref), wait (duration). ' +
  'Coordinates — coordinate:[x,y] or a ref from browser_read_page/browser_find.',
  {
    tabId: z.number(),
    action: z.enum(['screenshot', 'zoom', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait']),
    coordinate: z.array(z.number()).length(2).optional().describe('[x, y] in pixels'),
    start_coordinate: z.array(z.number()).length(2).optional().describe('drag start for left_click_drag'),
    ref: z.string().optional().describe('element ref from browser_read_page/browser_find — alternative to coordinate'),
    text: z.string().optional().describe('text for type, or key combos for key'),
    modifiers: z.string().optional().describe('click modifiers: cmd, ctrl, alt, shift (joined with +)'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
    scroll_amount: z.number().optional().describe('wheel ticks, default 3'),
    region: z.array(z.number()).length(4).optional().describe('[x0, y0, x1, y1] for zoom'),
    duration: z.number().optional().describe('seconds for wait (max 10)'),
    repeat: z.number().optional().describe('repeat count for key'),
  },
  async (a) => {
    const { tabId, action } = a;
    const point = async () => {
      if (a.coordinate) return { x: a.coordinate[0], y: a.coordinate[1] };
      if (a.ref) return call('ref_point', { tabId, ref: a.ref });
      throw new Error(`${action} needs a coordinate or a ref`);
    };
    switch (action) {
      case 'screenshot': {
        const { dataUrl } = await call('screenshot', { tabId }, 30000);
        return image(dataUrl);
      }
      case 'zoom': {
        if (!a.region) throw new Error('zoom needs a region [x0,y0,x1,y1]');
        const [x0, y0, x1, y1] = a.region;
        const { dataUrl } = await call('screenshot', { tabId, clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, scale: 2 } }, 30000);
        return image(dataUrl);
      }
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        const { x, y } = await point();
        const button = action === 'right_click' ? 'right' : 'left';
        const clickCount = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
        return text(await call('mouse_click', { tabId, x, y, button, clickCount, modifiers: parseModifiers(a.modifiers) }));
      }
      case 'hover': {
        const { x, y } = await point();
        return text(await call('mouse_move', { tabId, x, y }));
      }
      case 'left_click_drag': {
        if (!a.start_coordinate || !a.coordinate) throw new Error('start_coordinate and coordinate are required');
        return text(await call('drag', {
          tabId,
          x1: a.start_coordinate[0], y1: a.start_coordinate[1],
          x2: a.coordinate[0], y2: a.coordinate[1],
        }));
      }
      case 'type': {
        if (a.text === undefined) throw new Error('type needs text');
        return text(await call('insert_text', { tabId, text: a.text }));
      }
      case 'key': {
        if (!a.text) throw new Error('key needs text, e.g. "Enter" or "cmd+a Backspace"');
        return text(await call('key_press', { tabId, combos: a.text.trim().split(/\s+/), repeat: a.repeat || 1 }));
      }
      case 'scroll': {
        const { x, y } = a.coordinate ? { x: a.coordinate[0], y: a.coordinate[1] } : { x: 400, y: 300 };
        const ticks = (a.scroll_amount || 3) * 100;
        const dir = a.scroll_direction || 'down';
        const deltaX = dir === 'left' ? -ticks : dir === 'right' ? ticks : 0;
        const deltaY = dir === 'up' ? -ticks : dir === 'down' ? ticks : 0;
        return text(await call('wheel', { tabId, x, y, deltaX, deltaY }));
      }
      case 'scroll_to': {
        if (!a.ref) throw new Error('scroll_to needs a ref');
        return text(await call('ref_point', { tabId, ref: a.ref }));
      }
      case 'wait': {
        const s = Math.min(a.duration || 1, 10);
        await new Promise(r => setTimeout(r, s * 1000));
        return text({ ok: true, waited: s });
      }
    }
  },
);

// ===== Reading the page =====

defTool(
  'browser_read_page',
  'Accessibility tree of the page with element ref ids (for ref clicks in browser_computer). filter=interactive — interactive elements only',
  { tabId: z.number(), filter: z.enum(['all', 'interactive']).optional() },
  async ({ tabId, filter }) => {
    const r = await call('ax_tree', { tabId, interactiveOnly: filter === 'interactive' }, 30000);
    return text(r.tree + `\n\n(elements with refs: ${r.refCount})`);
  },
);

defTool(
  'browser_find',
  'Find elements on the page by text/name/role; returns refs for clicking',
  { tabId: z.number(), query: z.string() },
  async ({ tabId, query }) => text(await call('find', { tabId, query }, 30000)),
);

// ===== Forms and DOM =====

defTool(
  'browser_form_input',
  'Set a form element value: input/textarea/contenteditable (text), select (option value or label), checkbox/radio ("true"/"false"). Target is given by selector or ref',
  {
    tabId: z.number(),
    selector: z.string().optional().describe('CSS selector'),
    ref: z.string().optional().describe('ref from browser_read_page/browser_find'),
    value: z.string(),
  },
  async ({ tabId, selector, ref, value }) => {
    if (!selector && !ref) throw new Error('selector or ref is required');
    return text(await call('form_input', { tabId, selector, ref, value }));
  },
);

defTool(
  'browser_click',
  'Click an element by CSS selector (DOM .click(); for real mouse clicks use browser_computer)',
  { tabId: z.number(), selector: z.string() },
  async ({ tabId, selector }) => text(await call('click', { tabId, selector })),
);

defTool(
  'browser_upload_file',
  'Put local files into an <input type="file"> by CSS selector',
  { tabId: z.number(), selector: z.string(), files: z.array(z.string()).describe('absolute file paths') },
  async ({ tabId, selector, files }) => text(await call('upload_file', { tabId, selector, files })),
);

// ===== Debugging =====

defTool(
  'browser_javascript',
  'Run JavaScript in the page context and return the result (await is supported)',
  { tabId: z.number(), code: z.string() },
  async ({ tabId, code }) => text(await call('eval', { tabId, code }, 30000)),
);

defTool(
  'browser_console_messages',
  'Console messages of a tab (collected from the first time any CDP tool touches the tab)',
  {
    tabId: z.number(),
    pattern: z.string().optional().describe('regex filter over the message text'),
    clear: z.boolean().optional().describe('clear the buffer after reading'),
  },
  async ({ tabId, pattern, clear }) => {
    let msgs = await call('console_read', { tabId, clear });
    if (pattern) {
      const re = new RegExp(pattern, 'i');
      msgs = msgs.filter(m => re.test(m.text));
    }
    return text(msgs.slice(-200));
  },
);

defTool(
  'browser_network_requests',
  'Network requests of a tab (method, URL, status; collected from the first time the tab is touched)',
  {
    tabId: z.number(),
    urlPattern: z.string().optional().describe('regex filter over the URL'),
    clear: z.boolean().optional(),
  },
  async ({ tabId, urlPattern, clear }) => {
    let reqs = await call('network_read', { tabId, clear });
    if (urlPattern) {
      const re = new RegExp(urlPattern, 'i');
      reqs = reqs.filter(r => re.test(r.url));
    }
    return text(reqs.slice(-200));
  },
);

// ===== Window and recording =====

defTool(
  'browser_resize_window',
  'Resize the browser window that contains the tab',
  { tabId: z.number(), width: z.number(), height: z.number() },
  async ({ tabId, width, height }) => text(await call('resize_window', { tabId, width, height })),
);

defTool(
  'browser_gif_start',
  'Start recording a GIF of the tab (a frame every intervalMs, 80 frames max)',
  { tabId: z.number(), intervalMs: z.number().optional().describe('frame interval, default 800ms') },
  async ({ tabId, intervalMs }) => text(await call('gif_start', { tabId, intervalMs }, 30000)),
);

defTool(
  'browser_gif_stop',
  'Stop recording and save the GIF to a file',
  { tabId: z.number(), path: z.string().describe('absolute path for the .gif') },
  async ({ tabId, path }) => {
    const { frames, intervalMs } = await call('gif_stop', { tabId }, 90000);
    if (!frames.length) throw new Error('no frames were recorded');
    const gif = GIFEncoder();
    let w0, h0, used = 0;
    for (const b64 of frames) {
      const png = PNG.sync.read(Buffer.from(b64, 'base64'));
      if (w0 === undefined) { w0 = png.width; h0 = png.height; }
      if (png.width !== w0 || png.height !== h0) continue;
      const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, w0, h0, { palette, delay: intervalMs });
      used++;
    }
    gif.finish();
    fs.writeFileSync(path, Buffer.from(gif.bytes()));
    return text({ path, frames: used, width: w0, height: h0 });
  },
);

// ===== Chat panel (extension popup) =====
// The panel connects to ws://127.0.0.1:8929/chat. Each connection gets its own
// Claude Agent SDK session (authenticated via the Claude Code login) with the
// same browser tools; built-in tools (Bash, Read, etc.) are disabled.

// An in-process MCP server is created per panel connection: a wrapper around
// the tools forwards images from results (screenshots, zoom) to that
// particular chat window.
function makeBrowserSdkServer(onImage) {
  return createSdkMcpServer({
    name: 'browser',
    version: '0.5.0',
    tools: toolDefs.map(t => sdkTool(t.name, t.description, t.shape, async (args) => {
      const res = await t.handler(args);
      try {
        for (const block of (res && res.content) || []) {
          if (block.type === 'image' && block.data) onImage(block);
        }
      } catch {}
      return res;
    })),
  });
}

const CHAT_SYSTEM_PROMPT =
  'You are Claude in a browser panel (the Chromium Bridge). ' +
  'You have tools to work with the browser: list tabs, read pages, take ' +
  'screenshots, click, type text, run JavaScript, read the console and network. ' +
  'When the question is about "this page" or "the current tab", call browser_tabs_list ' +
  'first and use the tab with active:true. Take a screenshot only when the page text ' +
  'does not answer the question. Respond in the user\'s language, briefly and to the ' +
  'point. Do not ask permission for safe actions (reading, screenshots, navigation) — just do them.';

// SDK sessions do not read Claude Code settings, so we read the "default model"
// from ~/.claude/settings.json ourselves (whatever was set via /model).
function claudeDefaultModel() {
  try {
    const s = JSON.parse(fs.readFileSync(os.homedir() + '/.claude/settings.json', 'utf8'));
    return (typeof s.model === 'string' && s.model) ? s.model : null;
  } catch {
    return null;
  }
}

// Mutating actions that require confirmation in "ask before acting" mode
const CONFIRM_TOOLS = new Set(['browser_navigate', 'browser_tab_close', 'browser_click', 'browser_form_input', 'browser_javascript', 'browser_upload_file']);
const CONFIRM_COMPUTER_ACTIONS = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag', 'type', 'key']);

function needsConfirm(toolName, input) {
  const t = toolName.replace(/^mcp__browser__/, '');
  if (CONFIRM_TOOLS.has(t)) return true;
  if (t === 'browser_computer') return CONFIRM_COMPUTER_ACTIONS.has(input && input.action);
  return false;
}

function handleChatConnection(ws) {
  let session = null;
  let chatModel = process.env.CHROMIUM_BRIDGE_CHAT_MODEL || null;
  let askMode = false;
  let confirmN = 0;
  const confirms = new Map(); // id -> resolve(boolean)
  const effectiveModel = () => chatModel || claudeDefaultModel();

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  const browserSdkServer = makeBrowserSdkServer((block) => {
    send({ type: 'screenshot', data: block.data, mimeType: block.mimeType || 'image/png' });
  });

  function rejectConfirms() {
    for (const resolve of confirms.values()) resolve(false);
    confirms.clear();
  }

  // Reading tools are always allowed; mutating tools in "ask" mode are
  // confirmed in the panel. askMode is read at call time — toggling takes
  // effect immediately, without recreating the session.
  async function canUseTool(toolName, input) {
    if (!askMode || !needsConfirm(toolName, input)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const id = ++confirmN;
    const allowed = await new Promise((resolve) => {
      confirms.set(id, resolve);
      send({ type: 'confirm', id, name: toolName, input });
      setTimeout(() => {
        if (confirms.has(id)) { confirms.delete(id); resolve(false); }
      }, 300000);
    });
    return allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'The user denied this action' };
  }

  send({ type: 'hello', extension: connected(), defaultModel: claudeDefaultModel() });

  function startSession(resumeId) {
    const queue = [];
    let notify = null;
    const s = {
      dead: false,
      push(text, images) {
        let content = text;
        if (Array.isArray(images) && images.length) {
          content = images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data },
          }));
          content.push({ type: 'text', text });
        }
        queue.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        });
        if (notify) { notify(); notify = null; }
      },
      close() {
        this.dead = true;
        if (notify) { notify(); notify = null; }
      },
      q: null,
    };
    async function* input() {
      while (!s.dead) {
        while (queue.length) yield queue.shift();
        await new Promise(r => { notify = r; });
      }
    }
    s.q = query({
      prompt: input(),
      options: {
        tools: [],
        mcpServers: { browser: browserSdkServer },
        // No allowedTools: auto-approval would bypass canUseTool
        permissionMode: 'default',
        canUseTool,
        includePartialMessages: true,
        systemPrompt: CHAT_SYSTEM_PROMPT,
        maxTurns: 100,
        ...(effectiveModel() ? { model: effectiveModel() } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });
    (async () => {
      try {
        for await (const m of s.q) {
          // After "new chat"/history switch the session is marked dead —
          // don't forward its trailing events to the panel
          if (s.dead) continue;
          if (m.type === 'stream_event') {
            const ev = m.event;
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
              send({ type: 'delta', text: ev.delta.text });
            } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
              send({ type: 'tool', name: ev.content_block.name });
            }
          } else if (m.type === 'system' && m.subtype === 'init') {
            // session id — the panel stores it to resume the conversation later
            send({ type: 'session', id: m.session_id });
          } else if (m.type === 'result') {
            send({
              type: 'turn_end',
              error: m.is_error ? (m.result || m.subtype || 'error') : undefined,
              // input_tokens covers only the uncached part; add cache for an honest figure
              usage: m.usage ? {
                input: (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0),
                output: m.usage.output_tokens || 0,
              } : undefined,
              cost_usd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
            });
          }
        }
      } catch (e) {
        if (!s.dead) send({ type: 'fatal', message: 'The Claude session ended: ' + String((e && e.message) || e) });
      } finally {
        s.dead = true;
        if (session === s) session = null;
      }
    })();
    return s;
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'user' && typeof msg.text === 'string' && msg.text.trim()) {
      if (!session || session.dead) {
        session = startSession(typeof msg.resume === 'string' && msg.resume ? msg.resume : undefined);
      }
      session.push(msg.text, Array.isArray(msg.images) ? msg.images.slice(0, 5) : undefined);
    } else if (msg.type === 'set_model') {
      chatModel = (typeof msg.model === 'string' && msg.model.trim()) ? msg.model.trim() : null;
      // Change the model of an active session on the fly; otherwise it applies at creation
      if (session && !session.dead && session.q) {
        session.q.setModel(effectiveModel() || undefined).catch(() => {});
      }
    } else if (msg.type === 'set_ask') {
      askMode = !!msg.ask;
      if (!askMode) rejectConfirms(); // don't silently run actions that were awaiting confirmation
    } else if (msg.type === 'confirm_reply') {
      const resolve = confirms.get(msg.id);
      if (resolve) { confirms.delete(msg.id); resolve(!!msg.allow); }
    } else if (msg.type === 'interrupt') {
      rejectConfirms();
      if (session && session.q) session.q.interrupt().catch(() => {});
    } else if (msg.type === 'new_chat') {
      if (session) {
        const old = session;
        session = null;
        old.close();
        if (old.q) old.q.interrupt().catch(() => {});
      }
    }
  });

  ws.on('close', () => {
    rejectConfirms();
    if (session) {
      const old = session;
      session = null;
      old.close();
      if (old.q) old.q.interrupt().catch(() => {});
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`[chromium-bridge] MCP server v0.5 ready: MCP on stdio, extension and chat on ws://127.0.0.1:${PORT}`);
