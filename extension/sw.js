// Chromium Bridge — service worker.
// Keeps a WebSocket to the local MCP server and executes its commands via
// chrome.tabs / chrome.scripting and chrome.debugger (CDP): coordinate clicks,
// keyboard, console, network, accessibility tree, JS, screenshots without
// activating the tab, GIF recording.
// The chat panel is an action popup (chat.html) opened by clicking the icon.

const WS_URL = 'ws://127.0.0.1:8929';
let ws = null;

let connecting = false;

async function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  try {
    // Silent probe: a failed `new WebSocket()` litters the extension's error list,
    // while a caught fetch error does not. Open the WebSocket only when the server is up.
    try {
      await fetch('http://127.0.0.1:8929/', { cache: 'no-store' });
    } catch {
      setTimeout(connect, 3000);
      return;
    }
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      ws = null;
      return;
    }
  } finally {
    connecting = false;
  }
  ws.onopen = () => console.log('[chromium-bridge] connected to MCP server');
  ws.onclose = () => { ws = null; setTimeout(connect, 3000); };
  ws.onerror = () => {};
  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const { id, cmd, args = {} } = msg;
    let reply;
    try {
      const handler = handlers[cmd];
      if (!handler) throw new Error('unknown command: ' + cmd);
      if (typeof args.tabId === 'number' && !NO_GLOW.has(cmd)) showActivity(args.tabId);
      reply = { id, result: await handler(args) };
    } catch (e) {
      reply = { id, error: String((e && e.message) || e) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
}

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ===== Per-tab state (debugger, buffers, refs) =====

const attached = new Set();
const tabState = new Map();

function state(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { console: [], network: new Map(), networkOrder: [], refs: new Map(), refN: 0, rec: null });
  }
  return tabState.get(tabId);
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!m.includes('Already attached')) {
      throw new Error('Could not attach debugger to the tab (DevTools may be open): ' + m);
    }
  }
  attached.add(tabId);
  for (const method of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable', 'Log.enable']) {
    try { await chrome.debugger.sendCommand({ tabId }, method); } catch {}
  }
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  const s = tabState.get(tabId);
  if (s && s.rec) clearInterval(s.rec.timer);
  tabState.delete(tabId);
});

function argToString(a) {
  if (!a) return '';
  if (a.type === 'string') return a.value;
  if (a.value !== undefined) { try { return JSON.stringify(a.value); } catch { return String(a.value); } }
  return a.description || a.type || '';
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  const s = state(source.tabId);
  if (method === 'Runtime.consoleAPICalled') {
    s.console.push({ level: params.type, text: (params.args || []).map(argToString).join(' '), ts: Date.now() });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails || {};
    s.console.push({ level: 'error', text: (d.exception && d.exception.description) || d.text || 'exception', ts: Date.now() });
  } else if (method === 'Log.entryAdded') {
    s.console.push({ level: params.entry.level, text: params.entry.text, ts: Date.now() });
  } else if (method === 'Network.requestWillBeSent') {
    s.network.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type, status: null, ts: Date.now() });
    s.networkOrder.push(params.requestId);
    while (s.networkOrder.length > 400) s.network.delete(s.networkOrder.shift());
  } else if (method === 'Network.responseReceived') {
    const r = s.network.get(params.requestId);
    if (r) { r.status = params.response.status; r.mimeType = params.response.mimeType; }
  } else if (method === 'Network.loadingFailed') {
    const r = s.network.get(params.requestId);
    if (r) r.error = params.errorText;
  }
  if (s.console.length > 500) s.console.splice(0, s.console.length - 500);
});

// ===== On-page activity indication =====

// Orange glow around the tab edges + a badge while Claude is acting.
// Every call extends the display; with no new actions it fades out after 2.5s.
function pageGlow(badgeText) {
  let el = document.getElementById('__chromiumBridgeGlow');
  if (!el) {
    el = document.createElement('div');
    el.id = '__chromiumBridgeGlow';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
      'box-shadow:inset 0 0 0 3px #D97757, inset 0 0 28px rgba(217,119,87,.35);' +
      'transition:opacity .3s;opacity:1;';
    const badge = document.createElement('div');
    badge.textContent = badgeText;
    badge.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);' +
      'background:#D97757;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
      'padding:3px 12px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25);';
    el.appendChild(badge);
    (document.body || document.documentElement).appendChild(el);
  }
  el.style.opacity = '1';
  clearTimeout(window.__chromiumBridgeGlowT);
  window.__chromiumBridgeGlowT = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 350);
  }, 2500);
}

// Claude's virtual cursor: CDP events don't move the real cursor, so we draw
// our own — it glides to the action point and pulses a ring on click.
function pageCursor(x, y, click) {
  let el = document.getElementById('__chromiumBridgeCursor');
  if (!el) {
    el = document.createElement('div');
    el.id = '__chromiumBridgeCursor';
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
      'width:20px;height:20px;transition:transform .25s ease;will-change:transform;';
    el.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20">' +
      '<path d="M2 1 L2 15 L6.2 11.8 L8.9 18 L11.4 16.9 L8.7 10.9 L14 10.5 Z" ' +
      'fill="#D97757" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(el);
  }
  el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  if (click) {
    if (!document.getElementById('__chromiumBridgeCursorStyle')) {
      const st = document.createElement('style');
      st.id = '__chromiumBridgeCursorStyle';
      st.textContent = '@keyframes __chromiumBridgeRing{from{transform:scale(.4);opacity:.8}to{transform:scale(1.7);opacity:0}}';
      (document.head || document.documentElement).appendChild(st);
    }
    const ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;z-index:2147483646;pointer-events:none;' +
      'width:28px;height:28px;margin:-14px 0 0 -14px;border:2px solid #D97757;border-radius:50%;' +
      'animation:__chromiumBridgeRing .45s ease-out forwards;';
    (document.body || document.documentElement).appendChild(ring);
    setTimeout(() => ring.remove(), 500);
  }
  clearTimeout(window.__chromiumBridgeCursorT);
  window.__chromiumBridgeCursorT = setTimeout(() => el.remove(), 3500);
}

function setGlowHidden(hidden) {
  for (const id of ['__chromiumBridgeGlow', '__chromiumBridgeCursor']) {
    const el = document.getElementById(id);
    if (el) el.style.display = hidden ? 'none' : '';
  }
}

// Commands that should not trigger the glow (screenshots — so it doesn't end up in the frame)
const NO_GLOW = new Set(['ping', 'tabs_list', 'tab_create', 'tab_close', 'screenshot', 'console_read', 'network_read', 'gif_start', 'gif_stop', 'ref_point']);

// Badge language follows the chat panel's selector (mirrored to chrome.storage);
// "auto" falls back to the browser UI language.
const BADGE = { en: '✳ Claude is working…', ru: '✳ Claude работает…' };
let langPref = 'auto';
try { chrome.storage.local.get('lang').then(r => { if (r && r.lang) langPref = r.lang; }); } catch {}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) langPref = changes.lang.newValue || 'auto';
});

function badgeText() {
  const ru = langPref === 'ru'
    || (langPref === 'auto' && chrome.i18n.getUILanguage().toLowerCase().startsWith('ru'));
  return BADGE[ru ? 'ru' : 'en'];
}

async function showActivity(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageGlow, args: [badgeText()] });
  } catch {}
}

async function showCursor(tabId, x, y, click = false) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageCursor, args: [x, y, !!click] });
  } catch {}
}

// ===== Keyboard =====

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let i = 1; i <= 12; i++) KEYS['f' + i] = { key: 'F' + i, code: 'F' + i, keyCode: 111 + i };

const MODIFIER_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, windows: 4, shift: 8 };

function parseCombo(combo) {
  let modifiers = 0;
  let keyDef = null;
  for (const part of combo.split('+')) {
    const p = part.trim().toLowerCase();
    if (p in MODIFIER_BITS) { modifiers |= MODIFIER_BITS[p]; continue; }
    if (KEYS[p]) { keyDef = { ...KEYS[p] }; continue; }
    if (part.trim().length === 1) {
      const ch = part.trim();
      const upper = ch.toUpperCase();
      keyDef = {
        key: ch,
        code: /[a-z]/i.test(ch) ? 'Key' + upper : /\d/.test(ch) ? 'Digit' + ch : '',
        keyCode: upper.charCodeAt(0),
        text: ch,
      };
      continue;
    }
    throw new Error('unknown key: ' + part);
  }
  if (!keyDef) throw new Error('no main key in combo: ' + combo);
  return { modifiers, keyDef };
}

async function pressKey(tabId, combo) {
  const { modifiers, keyDef } = parseCombo(combo);
  const base = { modifiers, key: keyDef.key, code: keyDef.code, windowsVirtualKeyCode: keyDef.keyCode, nativeVirtualKeyCode: keyDef.keyCode };
  const down = { ...base, type: keyDef.text && !(modifiers & ~8) ? 'keyDown' : 'rawKeyDown' };
  if (keyDef.text && !(modifiers & ~8)) down.text = keyDef.text;
  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ===== Helpers =====

async function exec(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  const value = res && res.result;
  if (value && value.__error) throw new Error(value.__error);
  return value;
}

async function refToBackendNode(tabId, ref) {
  const s = state(tabId);
  const backendNodeId = s.refs.get(ref);
  if (!backendNodeId) throw new Error(`unknown ref "${ref}" — call read_page or find first`);
  return backendNodeId;
}

async function refPoint(tabId, ref) {
  const backendNodeId = await refToBackendNode(tabId, ref);
  try { await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }); } catch {}
  const { model } = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = model.content;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider',
  'spinbutton', 'switch', 'tab', 'listbox', 'textfield', 'popupbutton', 'toggleButton',
]);
const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak']);

// form_input helper: runs in the page context via Runtime.callFunctionOn
// (this = element) or via chrome.scripting (selector passed as an argument).
function setElementValue(el, value) {
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (el instanceof HTMLSelectElement) {
    const opts = [...el.options];
    const opt = opts.find(o => o.value === String(value))
      || opts.find(o => o.text.trim() === String(value).trim());
    if (!opt) return { __error: 'no such option in select: ' + value };
    el.value = opt.value; fire();
    return { ok: true };
  }
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = value === true || value === 'true' || value === 'on' || value === '1';
    if (el.checked !== want) el.click();
    return { ok: true };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    fire();
    return { ok: true };
  }
  if (el.isContentEditable) {
    el.focus(); el.textContent = String(value); fire();
    return { ok: true };
  }
  return { __error: 'element does not accept a value' };
}

// ===== Commands =====

const handlers = {
  async ping() { return { ok: true }; },

  async tabs_list() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }));
  },

  async tab_create({ url }) {
    const t = await chrome.tabs.create({ url: url || 'about:blank' });
    return { id: t.id, windowId: t.windowId };
  },

  async tab_close({ tabId }) {
    await chrome.tabs.remove(tabId);
    return { ok: true };
  },

  async navigate({ tabId, url }) {
    if (url === 'back') { await chrome.tabs.goBack(tabId); return { ok: true }; }
    if (url === 'forward') { await chrome.tabs.goForward(tabId); return { ok: true }; }
    await chrome.tabs.update(tabId, { url });
    return { ok: true };
  },

  async page_text({ tabId }) {
    return exec(tabId, () => ({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 80000) : '',
    }));
  },

  async screenshot({ tabId, clip }) {
    try { await chrome.scripting.executeScript({ target: { tabId }, func: setGlowHidden, args: [true] }); } catch {}
    try {
      const params = { format: 'png' };
      if (clip) params.clip = clip;
      const { data } = await cdp(tabId, 'Page.captureScreenshot', params);
      return { dataUrl: 'data:image/png;base64,' + data };
    } catch (e) {
      // Fallback without the debugger: activate the tab and capture the visible area
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 350));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl };
    } finally {
      // Restore the glow if it is still active
      try { await chrome.scripting.executeScript({ target: { tabId }, func: setGlowHidden, args: [false] }); } catch {}
    }
  },

  async mouse_click({ tabId, x, y, button = 'left', clickCount = 1, modifiers = 0 }) {
    await showCursor(tabId, x, y, true);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
    return { ok: true, x, y };
  },

  async mouse_move({ tabId, x, y }) {
    await showCursor(tabId, x, y);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { ok: true };
  },

  async drag({ tabId, x1, y1, x2, y2 }) {
    await showCursor(tabId, x1, y1);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x1 + (x2 - x1) * i / steps,
        y: y1 + (y2 - y1) * i / steps,
        button: 'left',
      });
    }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    showCursor(tabId, x2, y2);
    return { ok: true };
  },

  async wheel({ tabId, x, y, deltaX = 0, deltaY = 0 }) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    return { ok: true };
  },

  async insert_text({ tabId, text }) {
    await cdp(tabId, 'Input.insertText', { text });
    return { ok: true };
  },

  async key_press({ tabId, combos, repeat = 1 }) {
    for (let r = 0; r < repeat; r++) {
      for (const combo of combos) await pressKey(tabId, combo);
    }
    return { ok: true };
  },

  async eval({ tabId, code }) {
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return { type: r.result.type, value: r.result.value !== undefined ? r.result.value : r.result.description };
  },

  async console_read({ tabId, clear }) {
    await ensureAttached(tabId);
    const s = state(tabId);
    const out = s.console.slice();
    if (clear) s.console = [];
    return out;
  },

  async network_read({ tabId, clear }) {
    await ensureAttached(tabId);
    const s = state(tabId);
    const out = s.networkOrder.map(id => s.network.get(id)).filter(Boolean);
    if (clear) { s.network.clear(); s.networkOrder = []; }
    return out;
  },

  async ax_tree({ tabId, interactiveOnly = false, maxChars = 50000 }) {
    const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
    const byId = new Map(nodes.map(n => [n.nodeId, n]));
    const s = state(tabId);
    s.refs.clear();
    s.refN = 0;
    const lines = [];
    const visit = (id, depth) => {
      const n = byId.get(id);
      if (!n) return;
      const role = (n.role && n.role.value) || '';
      const name = (n.name && n.name.value) || '';
      const isInt = INTERACTIVE_ROLES.has(role);
      const show = !n.ignored && role
        && (interactiveOnly ? isInt : (isInt || name || !SKIP_ROLES.has(role)));
      let nextDepth = depth;
      if (show) {
        let refTag = '';
        if (n.backendDOMNodeId && (isInt || name)) {
          s.refN++;
          const ref = 'ref_' + s.refN;
          s.refs.set(ref, n.backendDOMNodeId);
          refTag = ' [' + ref + ']';
        }
        lines.push('  '.repeat(Math.min(depth, 20)) + role + (name ? ` "${name.slice(0, 80)}"` : '') + refTag);
        nextDepth = depth + 1;
      }
      for (const c of n.childIds || []) visit(c, nextDepth);
    };
    if (nodes.length) visit(nodes[0].nodeId, 0);
    let out = lines.join('\n');
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…(truncated, use interactiveOnly or find)';
    return { tree: out, refCount: s.refN };
  },

  async find({ tabId, query }) {
    const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
    const q = query.toLowerCase();
    const s = state(tabId);
    const matches = [];
    for (const n of nodes) {
      if (n.ignored || !n.backendDOMNodeId) continue;
      const role = (n.role && n.role.value) || '';
      const name = (n.name && n.name.value) || '';
      if (!name && !INTERACTIVE_ROLES.has(role)) continue;
      if ((name + ' ' + role).toLowerCase().includes(q)) {
        s.refN++;
        const ref = 'ref_' + s.refN;
        s.refs.set(ref, n.backendDOMNodeId);
        matches.push({ ref, role, name: name.slice(0, 100) });
        if (matches.length >= 20) break;
      }
    }
    return matches;
  },

  async ref_point({ tabId, ref }) {
    return refPoint(tabId, ref);
  },

  async form_input({ tabId, selector, ref, value }) {
    if (ref) {
      const backendNodeId = await refToBackendNode(tabId, ref);
      const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
      const fnSource = `function(value) { const el = this; return (${setElementValue.toString()})(el, value); }`;
      const res = await cdp(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: fnSource,
        arguments: [{ value }],
        returnByValue: true,
      });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      const v = res.result.value;
      if (v && v.__error) throw new Error(v.__error);
      return v;
    }
    // Duplicates setElementValue: eval in the isolated world is blocked by the
    // extension CSP, and executeScript serializes the function — closures are unavailable.
    return exec(tabId, (sel, value) => {
      const el = document.querySelector(sel);
      if (!el) return { __error: 'element not found: ' + sel };
      const fire = () => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      if (el instanceof HTMLSelectElement) {
        const opts = [...el.options];
        const opt = opts.find(o => o.value === String(value))
          || opts.find(o => o.text.trim() === String(value).trim());
        if (!opt) return { __error: 'no such option in select: ' + value };
        el.value = opt.value; fire();
        return { ok: true };
      }
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = value === true || value === 'true' || value === 'on' || value === '1';
        if (el.checked !== want) el.click();
        return { ok: true };
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
        fire();
        return { ok: true };
      }
      if (el.isContentEditable) {
        el.focus(); el.textContent = String(value); fire();
        return { ok: true };
      }
      return { __error: 'element does not accept a value' };
    }, [selector, value]);
  },

  async fill({ tabId, selector, text }) {
    return handlers.form_input({ tabId, selector, value: text });
  },

  async click({ tabId, selector }) {
    return exec(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { __error: 'element not found: ' + sel };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true };
    }, [selector]);
  },

  async upload_file({ tabId, selector, files }) {
    const { root } = await cdp(tabId, 'DOM.getDocument');
    const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error('element not found: ' + selector);
    await cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files });
    return { ok: true };
  },

  async resize_window({ tabId, width, height }) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height, state: 'normal' });
    return { ok: true };
  },

  async gif_start({ tabId, intervalMs = 800, maxFrames = 80, targetWidth = 800 }) {
    const s = state(tabId);
    if (s.rec) throw new Error('recording is already running for this tab');
    await ensureAttached(tabId);
    const m = await cdp(tabId, 'Page.getLayoutMetrics');
    const vp = m.cssVisualViewport || m.visualViewport;
    const w = Math.round(vp.clientWidth);
    const h = Math.round(vp.clientHeight);
    const scale = Math.min(1, targetWidth / w);
    const rec = { frames: [], intervalMs, timer: null };
    const capture = async () => {
      if (rec.frames.length >= maxFrames) { clearInterval(rec.timer); return; }
      try {
        const { data } = await cdp(tabId, 'Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width: w, height: h, scale },
        });
        rec.frames.push(data);
      } catch {}
    };
    rec.timer = setInterval(capture, intervalMs);
    s.rec = rec;
    await capture();
    return { ok: true, width: Math.round(w * scale), height: Math.round(h * scale) };
  },

  async gif_stop({ tabId }) {
    const s = state(tabId);
    const rec = s.rec;
    if (!rec) throw new Error('recording was not started (gif_start)');
    clearInterval(rec.timer);
    s.rec = null;
    return { frames: rec.frames, intervalMs: rec.intervalMs };
  },
};
