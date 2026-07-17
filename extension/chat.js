// Chromium Bridge chat panel (action popup): WebSocket to the local server (/chat),
// the server runs messages through the Claude Agent SDK with the browser_* tools.
// Chat history lives in localStorage; the conversation context survives popup
// close via resume by session_id.

const WS_URL = 'ws://127.0.0.1:8929/chat';
const MAX_CHATS = 30;

// ===== Localization: English by default, Russian if the browser UI is Russian.
// The manual selector (Auto / English / Русский) overrides auto-detection. =====

const LANG_PREF = localStorage.getItem('cbLang') || 'auto';
const uiLang = ((chrome.i18n && chrome.i18n.getUILanguage()) || navigator.language || 'en').toLowerCase();
const RU = LANG_PREF === 'ru' || (LANG_PREF === 'auto' && uiLang.startsWith('ru'));

const T = RU ? {
  langTitle: 'Язык панели',
  langAuto: 'Авто',
  modelTitle: 'Модель',
  defaultModel: 'По умолчанию',
  defaultModelWith: (short) => 'По умолчанию (' + short + ')',
  historyTitle: 'История чатов',
  newChatTitle: 'Новый чат',
  emptyGreeting: 'Чем могу помочь?',
  emptyHint: 'Я вижу вкладки браузера: могу читать страницы, делать скриншоты и кликать.',
  askLabel: 'Спрашивать перед действием',
  placeholder: 'Спросите про открытые вкладки…',
  sendTitle: 'Отправить',
  stopTitle: 'Остановить',
  serverDown: 'Сервер недоступен. Запустите сессию Claude Code с мостом chromium-bridge',
  extDown: 'Расширение не подключено к мосту — команды браузера не сработают',
  connLost: 'Соединение с сервером потеряно.',
  sessionEnded: 'Сессия завершилась с ошибкой.',
  thinking: 'Думаю',
  stopped: 'Остановлено',
  allow: 'Разрешить',
  deny: 'Отклонить',
  allowedSuffix: ' — разрешено',
  deniedSuffix: ' — отклонено',
  historyEmpty: 'Пока пусто',
  untitled: 'Без названия',
  deleteTitle: 'Удалить',
  shotTitle: 'Клик — развернуть/свернуть',
  tokensLine: (inp, out) => '↑ ' + inp + ' · ↓ ' + out + ' ткн',
  costLine: (usd) => 'сессия $' + usd,
  imageQuestion: 'Что на изображении?',
  imagesSuffix: (n) => ' [+' + n + ' изобр.]',
  confirm: {
    type: (t) => 'Ввести текст: «' + t + '»',
    key: (k) => 'Нажать клавиши: ' + k,
    drag: (from, to) => 'Перетащить из ' + from + ' в ' + to,
    click: (action, place) => 'Клик (' + action + ') ' + place,
    atPoint: (xy) => 'в точке ' + xy,
    atRef: (ref) => 'по элементу ' + ref,
    navigate: (url) => 'Перейти по адресу: ' + url,
    closeTab: (id) => 'Закрыть вкладку ' + id,
    clickSelector: (sel) => 'Кликнуть по селектору: ' + sel,
    fill: (target, value) => 'Заполнить ' + target + ' значением «' + value + '»',
    field: 'поле',
    js: (code) => 'Выполнить JavaScript: ' + code,
    upload: (files) => 'Загрузить файлы: ' + files,
  },
  toolLabels: {
    browser_tabs_list: 'Смотрю вкладки',
    browser_page_text: 'Читаю страницу',
    browser_read_page: 'Изучаю структуру страницы',
    browser_find: 'Ищу элементы',
    browser_computer: 'Действую на странице',
    browser_navigate: 'Открываю страницу',
    browser_tab_create: 'Открываю вкладку',
    browser_tab_close: 'Закрываю вкладку',
    browser_click: 'Кликаю',
    browser_form_input: 'Заполняю форму',
    browser_javascript: 'Выполняю скрипт',
    browser_console_messages: 'Читаю консоль',
    browser_network_requests: 'Смотрю сетевые запросы',
    browser_upload_file: 'Загружаю файл',
    browser_resize_window: 'Меняю размер окна',
    browser_gif_start: 'Начинаю запись GIF',
    browser_gif_stop: 'Сохраняю GIF',
    browser_status: 'Проверяю подключение',
  },
} : {
  langTitle: 'Panel language',
  langAuto: 'Auto',
  modelTitle: 'Model',
  defaultModel: 'Default',
  defaultModelWith: (short) => 'Default (' + short + ')',
  historyTitle: 'Chat history',
  newChatTitle: 'New chat',
  emptyGreeting: 'How can I help?',
  emptyHint: 'I can see your browser tabs: I can read pages, take screenshots, and click.',
  askLabel: 'Ask before acting',
  placeholder: 'Ask about your open tabs…',
  sendTitle: 'Send',
  stopTitle: 'Stop',
  serverDown: 'Server unavailable. Start a Claude Code session with the chromium-bridge MCP',
  extDown: 'Extension is not connected to the bridge — browser commands will not work',
  connLost: 'Connection to the server was lost.',
  sessionEnded: 'The session ended with an error.',
  thinking: 'Thinking',
  stopped: 'Stopped',
  allow: 'Allow',
  deny: 'Deny',
  allowedSuffix: ' — allowed',
  deniedSuffix: ' — denied',
  historyEmpty: 'Nothing yet',
  untitled: 'Untitled',
  deleteTitle: 'Delete',
  shotTitle: 'Click to expand/collapse',
  tokensLine: (inp, out) => '↑ ' + inp + ' · ↓ ' + out + ' tok',
  costLine: (usd) => 'session $' + usd,
  imageQuestion: "What's in this image?",
  imagesSuffix: (n) => ' [+' + n + ' img]',
  confirm: {
    type: (t) => 'Type text: “' + t + '”',
    key: (k) => 'Press keys: ' + k,
    drag: (from, to) => 'Drag from ' + from + ' to ' + to,
    click: (action, place) => 'Click (' + action + ') ' + place,
    atPoint: (xy) => 'at ' + xy,
    atRef: (ref) => 'on element ' + ref,
    navigate: (url) => 'Navigate to: ' + url,
    closeTab: (id) => 'Close tab ' + id,
    clickSelector: (sel) => 'Click selector: ' + sel,
    fill: (target, value) => 'Fill ' + target + ' with “' + value + '”',
    field: 'field',
    js: (code) => 'Run JavaScript: ' + code,
    upload: (files) => 'Upload files: ' + files,
  },
  toolLabels: {
    browser_tabs_list: 'Looking at tabs',
    browser_page_text: 'Reading the page',
    browser_read_page: 'Inspecting page structure',
    browser_find: 'Finding elements',
    browser_computer: 'Acting on the page',
    browser_navigate: 'Opening a page',
    browser_tab_create: 'Opening a tab',
    browser_tab_close: 'Closing a tab',
    browser_click: 'Clicking',
    browser_form_input: 'Filling a form',
    browser_javascript: 'Running a script',
    browser_console_messages: 'Reading the console',
    browser_network_requests: 'Checking network requests',
    browser_upload_file: 'Uploading a file',
    browser_resize_window: 'Resizing the window',
    browser_gif_start: 'Starting GIF recording',
    browser_gif_stop: 'Saving the GIF',
    browser_status: 'Checking the connection',
  },
};

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const stopEl = document.getElementById('stop');
const statusEl = document.getElementById('status-bar');
const newChatEl = document.getElementById('new-chat');
const modelEl = document.getElementById('model');
const historyBtn = document.getElementById('history');
const askEl = document.getElementById('ask-mode');
const historyPanel = document.getElementById('history-panel');
const historyList = document.getElementById('history-list');

// Static markup ships in English; overwrite with the active locale
modelEl.title = T.modelTitle;
modelEl.options[0].textContent = T.defaultModel;
historyBtn.title = T.historyTitle;
newChatEl.title = T.newChatTitle;
document.getElementById('ask-label').textContent = T.askLabel;
inputEl.placeholder = T.placeholder;
sendEl.title = T.sendTitle;
stopEl.title = T.stopTitle;

// A native <select> stretches to its widest option, and option 0 becomes the
// long "Default (<model>)" at runtime — so size the control to the currently
// selected option's text instead. CSS max-width caps the long default case.
const modelSizer = document.createElement('span');
modelSizer.style.cssText = 'position:absolute; top:-9999px; left:-9999px; visibility:hidden; white-space:pre;';
document.body.appendChild(modelSizer);
function fitModelWidth() {
  const opt = modelEl.options[modelEl.selectedIndex];
  if (!opt) return;
  const cs = getComputedStyle(modelEl);
  modelSizer.style.fontSize = cs.fontSize;
  modelSizer.style.fontFamily = cs.fontFamily;
  modelSizer.style.fontWeight = cs.fontWeight;
  modelSizer.style.fontStyle = cs.fontStyle;
  modelSizer.style.letterSpacing = cs.letterSpacing;
  modelSizer.textContent = opt.textContent;
  const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth); // padding-right already reserves the chevron
  modelEl.style.width = Math.ceil(modelSizer.getBoundingClientRect().width + extra) + 'px';
}

// Language selector: the choice is stored and applied via popup reload;
// it is mirrored to chrome.storage so the service worker localizes the
// on-page badge the same way.
const langEl = document.getElementById('lang');
langEl.value = LANG_PREF;
langEl.title = T.langTitle;
langEl.options[0].textContent = T.langAuto;
try { chrome.storage.local.set({ lang: LANG_PREF }); } catch {}
langEl.addEventListener('change', () => {
  localStorage.setItem('cbLang', langEl.value);
  try { chrome.storage.local.set({ lang: langEl.value }); } catch {}
  location.reload();
});

let ws = null;
let busy = false;          // an assistant turn is in flight
let currentText = null;    // div of the current response
let currentRaw = '';       // raw text of the current response
let thinkingEl = null;
let stopRequested = false; // user pressed stop — don't show the turn error

// ===== Chat storage =====

let chats = [];
// cb* are the current keys; arc* is migration from the project's old name (Arc Bridge)
try { chats = JSON.parse(localStorage.getItem('cbChats') || localStorage.getItem('arcChats') || '[]'); } catch {}

function newChatObj() {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sessionId: null,
    title: '',
    items: [],   // {k: 'u'|'a'|'t'|'e'|'m', t: text}
    ts: Date.now(),
  };
}

let chat = chats.find(c => c.id === (localStorage.getItem('cbChatCurrent') || localStorage.getItem('arcChatCurrent'))) || newChatObj();

function saveChats() {
  if (chat.items.length && !chats.includes(chat)) chats.push(chat);
  if (chats.length > MAX_CHATS) chats = chats.slice(-MAX_CHATS);
  try {
    localStorage.setItem('cbChats', JSON.stringify(chats));
    localStorage.setItem('cbChatCurrent', chat.id);
  } catch {}
}

function record(kind, text) {
  chat.items.push({ k: kind, t: text });
  if (kind === 'u' && !chat.title) chat.title = text.slice(0, 60);
  chat.ts = Date.now();
  saveChats();
}

// ===== Rendering =====

function setStatus(text, isError) {
  if (!text) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', !!isError);
}

// Autoscroll only when the user is already at the bottom — don't yank the feed
// if they scrolled up to read something. force — for their own actions.
function scrollDown(force) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmpty() {
  const e = document.getElementById('empty-state');
  if (e) e.remove();
}

function renderUser(text, images) {
  hideEmpty();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.textContent = text;
  for (const img of images || []) {
    const el = document.createElement('img');
    el.className = 'user-img';
    el.src = 'data:' + (img.mimeType || 'image/png') + ';base64,' + img.data;
    el.onload = () => scrollDown(); // height changes after load — scroll again
    div.appendChild(el);
  }
  messagesEl.appendChild(div);
}

function renderAssistant(raw) {
  hideEmpty();
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = renderMarkdown(raw);
  messagesEl.appendChild(div);
  return div;
}

function renderChip(label, done) {
  hideEmpty();
  const chip = document.createElement('div');
  chip.className = 'tool-chip' + (done ? ' done' : '');
  chip.innerHTML = '<span class="dot"></span>';
  chip.appendChild(document.createTextNode(label));
  messagesEl.appendChild(chip);
}

function renderError(text) {
  const div = document.createElement('div');
  div.className = 'turn-error';
  div.textContent = text;
  messagesEl.appendChild(div);
}

function renderShot(src) {
  hideEmpty();
  const img = document.createElement('img');
  img.className = 'shot';
  img.src = src;
  img.title = T.shotTitle;
  img.addEventListener('click', () => img.classList.toggle('expanded'));
  img.onload = () => scrollDown(); // the image loads asynchronously
  messagesEl.appendChild(img);
  scrollDown();
}

function renderMeta(text) {
  const div = document.createElement('div');
  div.className = 'usage-line';
  div.textContent = text;
  messagesEl.appendChild(div);
}

function renderChat() {
  messagesEl.innerHTML = '';
  if (!chat.items.length) {
    const empty = document.createElement('div');
    empty.id = 'empty-state';
    const logo = document.createElement('div');
    logo.className = 'empty-logo';
    logo.textContent = '✳';
    const greeting = document.createElement('p');
    greeting.textContent = T.emptyGreeting;
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = T.emptyHint;
    empty.append(logo, greeting, hint);
    messagesEl.appendChild(empty);
    return;
  }
  for (const item of chat.items) {
    if (item.k === 'u') renderUser(item.t);
    else if (item.k === 'a') renderAssistant(item.t);
    else if (item.k === 't') renderChip(item.t, true);
    else if (item.k === 'e') renderError(item.t);
    else if (item.k === 'm') renderMeta(item.t);
  }
  scrollDown(true);
}

function showThinking() {
  removeThinking();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking';
  thinkingEl.textContent = T.thinking;
  messagesEl.appendChild(thinkingEl);
  scrollDown();
}

function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function toolLabel(name) {
  const t = name.replace(/^mcp__.*?__/, '');
  return T.toolLabels[t] || t;
}

function appendDelta(text) {
  removeThinking();
  hideEmpty();
  if (!currentText) {
    currentText = document.createElement('div');
    currentText.className = 'msg assistant';
    messagesEl.appendChild(currentText);
    currentRaw = '';
  }
  currentRaw += text;
  currentText.textContent = currentRaw;
  scrollDown();
}

// Finish the current text block: apply markdown and record it in history
function finishTextBlock() {
  if (!currentText) return;
  currentText.innerHTML = renderMarkdown(currentRaw);
  record('a', currentRaw);
  currentText = null;
  currentRaw = '';
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(raw) {
  // Alternate text/code when splitting on ``` (odd indexes are code)
  const parts = raw.split(/```(?:\w*)\n?/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += '<pre><code>' + escapeHtml(parts[i].replace(/\n$/, '')) + '</code></pre>';
    } else {
      let seg = parts[i];
      // white-space: pre-wrap would render newlines around <pre> as double gaps
      if (i > 0) seg = seg.replace(/^\n/, '');
      if (i < parts.length - 1) seg = seg.replace(/\n$/, '');
      html += escapeHtml(seg)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/(https?:\/\/[^\s<)]+)/g, (m) =>
          '<a href="' + m.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">' + m + '</a>');
    }
  }
  return html;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  const s = (n / 1000).toFixed(1);
  return (RU ? s.replace('.', ',') : s) + 'k';
}

function endTurn(msg) {
  removeThinking();
  finishTextBlock();
  for (const chip of messagesEl.querySelectorAll('.tool-chip:not(.done)')) chip.classList.add('done');
  if (msg && msg.error) {
    if (stopRequested) {
      renderMeta(T.stopped);
      record('m', T.stopped);
    } else {
      renderError(msg.error);
      record('e', msg.error);
    }
  }
  stopRequested = false;
  if (msg && (msg.usage || msg.cost_usd !== undefined)) {
    const parts = [];
    if (msg.usage) parts.push(T.tokensLine(fmtTokens(msg.usage.input), fmtTokens(msg.usage.output)));
    if (msg.cost_usd !== undefined) parts.push(T.costLine(msg.cost_usd.toFixed(4)));
    const meta = parts.join(' · ');
    renderMeta(meta);
    record('m', meta);
  }
  busy = false;
  sendEl.hidden = false;
  stopEl.hidden = true;
  updateSendState();
  scrollDown();
}

// ===== WebSocket =====

function sendModel() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_model', model: modelEl.value || null }));
  }
}

function sendAsk() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_ask', ask: askEl.checked }));
  }
}

// Human-readable description of the action for the confirmation card
function confirmDetail(name, input) {
  const t = name.replace(/^mcp__.*?__/, '');
  const i = input || {};
  const C = T.confirm;
  if (t === 'browser_computer') {
    const a = i.action;
    const place = i.coordinate ? C.atPoint(i.coordinate.join(', ')) : (i.ref ? C.atRef(i.ref) : '');
    if (a === 'type') return C.type(String(i.text || '').slice(0, 80));
    if (a === 'key') return C.key(String(i.text || ''));
    if (a === 'left_click_drag') return C.drag((i.start_coordinate || []).join(', '), (i.coordinate || []).join(', '));
    return C.click(a, place);
  }
  if (t === 'browser_navigate') return C.navigate(i.url);
  if (t === 'browser_tab_close') return C.closeTab(i.tabId);
  if (t === 'browser_click') return C.clickSelector(i.selector);
  if (t === 'browser_form_input') return C.fill(i.selector || i.ref || C.field, String(i.value).slice(0, 60));
  if (t === 'browser_javascript') return C.js(String(i.code || '').slice(0, 120));
  if (t === 'browser_upload_file') return C.upload((i.files || []).join(', '));
  return JSON.stringify(i).slice(0, 120);
}

function renderConfirm(msg) {
  removeThinking();
  hideEmpty();
  const card = document.createElement('div');
  card.className = 'confirm-card';
  const detail = document.createElement('div');
  detail.className = 'confirm-detail';
  detail.textContent = toolLabel(msg.name) + ' — ' + confirmDetail(msg.name, msg.input);
  const buttons = document.createElement('div');
  buttons.className = 'confirm-buttons';
  const allow = document.createElement('button');
  allow.className = 'allow';
  allow.textContent = T.allow;
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = T.deny;
  const decide = (ok) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'confirm_reply', id: msg.id, allow: ok }));
    }
    card.classList.add('decided');
    allow.disabled = deny.disabled = true;
    detail.textContent += ok ? T.allowedSuffix : T.deniedSuffix;
    showThinking(); // the turn continues after the decision
  };
  allow.addEventListener('click', () => decide(true));
  deny.addEventListener('click', () => decide(false));
  buttons.append(allow, deny);
  card.append(detail, buttons);
  messagesEl.appendChild(card);
  scrollDown();
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    setStatus(null);
    // the server keeps settings per connection — restore them after (re)connecting
    sendModel();
    sendAsk();
  };
  ws.onclose = () => {
    ws = null;
    setStatus(T.serverDown, true);
    if (busy) endTurn({ error: T.connLost });
    setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'hello':
        setStatus(msg.extension ? null : T.extDown, !msg.extension);
        if (msg.defaultModel) {
          // "claude-fable-5[1m]" → "fable-5"
          const short = msg.defaultModel.replace(/^claude-/, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
          modelEl.options[0].textContent = T.defaultModelWith(short);
          fitModelWidth();
        }
        break;
      case 'session':
        chat.sessionId = msg.id;
        saveChats();
        break;
      case 'delta': appendDelta(msg.text); break;
      case 'tool': {
        finishTextBlock();
        for (const chip of messagesEl.querySelectorAll('.tool-chip:not(.done)')) chip.classList.add('done');
        const label = toolLabel(msg.name);
        renderChip(label, false);
        record('t', label);
        showThinking(); // the agent keeps working — indicator under the chip
        break;
      }
      case 'screenshot':
        // Live display only; not recorded — base64 images would overflow localStorage
        renderShot('data:' + (msg.mimeType || 'image/png') + ';base64,' + msg.data);
        break;
      case 'confirm': renderConfirm(msg); break;
      case 'turn_end': endTurn(msg); break;
      case 'fatal': endTurn({ error: msg.message || T.sessionEnded }); break;
    }
  };
}

function updateSendState() {
  sendEl.disabled = busy || (!inputEl.value.trim() && !pendingImages.length) || !ws || ws.readyState !== WebSocket.OPEN;
}

// ===== Attachments (pasting images from the clipboard) =====

const attachStrip = document.getElementById('attach-strip');
let pendingImages = []; // {data, mimeType}

function renderAttachments() {
  attachStrip.innerHTML = '';
  pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'attach-thumb';
    const el = document.createElement('img');
    el.src = 'data:' + img.mimeType + ';base64,' + img.data;
    const del = document.createElement('button');
    del.textContent = '×';
    del.addEventListener('click', () => {
      pendingImages.splice(idx, 1);
      renderAttachments();
      updateSendState();
    });
    thumb.append(el, del);
    attachStrip.appendChild(thumb);
  });
}

inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1];
      if (pendingImages.length < 5) {
        pendingImages.push({ data, mimeType: item.type });
        renderAttachments();
        updateSendState();
      }
    };
    reader.readAsDataURL(file);
  }
});

function send() {
  const text = inputEl.value.trim();
  if ((!text && !pendingImages.length) || busy || !ws || ws.readyState !== WebSocket.OPEN) return;
  const images = pendingImages;
  pendingImages = [];
  renderAttachments();
  const shownText = text || T.imageQuestion;
  renderUser(shownText, images);
  scrollDown(true);
  // images are not recorded in history (base64 would overflow localStorage quickly)
  record('u', shownText + (images.length ? T.imagesSuffix(images.length) : ''));
  ws.send(JSON.stringify({
    type: 'user',
    text: shownText,
    images: images.length ? images : undefined,
    resume: chat.sessionId || undefined,
  }));
  inputEl.value = '';
  inputEl.style.height = 'auto';
  busy = true;
  sendEl.hidden = true;
  stopEl.hidden = false;
  showThinking();
  updateSendState();
}

// ===== Chat history =====

function switchToChat(target) {
  finishTextBlock();
  chat = target;
  localStorage.setItem('cbChatCurrent', chat.id);
  renderChat();
  historyPanel.hidden = true;
  // reset the active session on the server; the next message resumes the selected chat
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'new_chat' }));
  busy = false;
  sendEl.hidden = false;
  stopEl.hidden = true;
  updateSendState();
}

function renderHistory() {
  historyList.innerHTML = '';
  const sorted = [...chats].sort((a, b) => b.ts - a.ts);
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = T.historyEmpty;
    historyList.appendChild(empty);
    return;
  }
  for (const c of sorted) {
    const row = document.createElement('div');
    row.className = 'history-item' + (c.id === chat.id ? ' current' : '');
    const title = document.createElement('span');
    title.className = 'history-title';
    title.textContent = c.title || T.untitled;
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = new Date(c.ts).toLocaleString(RU ? 'ru' : undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const del = document.createElement('button');
    del.className = 'history-del';
    del.textContent = '×';
    del.title = T.deleteTitle;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      chats = chats.filter(x => x.id !== c.id);
      try { localStorage.setItem('cbChats', JSON.stringify(chats)); } catch {}
      if (c.id === chat.id) switchToChat(newChatObj());
      renderHistory();
    });
    row.append(title, date, del);
    row.addEventListener('click', () => switchToChat(c));
    historyList.appendChild(row);
  }
}

historyBtn.addEventListener('click', () => {
  historyPanel.hidden = !historyPanel.hidden;
  if (!historyPanel.hidden) renderHistory();
});

document.addEventListener('click', (e) => {
  if (!historyPanel.hidden && !historyPanel.contains(e.target) && !historyBtn.contains(e.target)) {
    historyPanel.hidden = true;
  }
});

// ===== Handlers =====

sendEl.addEventListener('click', send);

stopEl.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    stopRequested = true;
    ws.send(JSON.stringify({ type: 'interrupt' }));
  }
});

newChatEl.addEventListener('click', () => switchToChat(newChatObj()));

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

askEl.checked = (localStorage.getItem('cbAskMode') ?? localStorage.getItem('arcAskMode')) === '1';

askEl.addEventListener('change', () => {
  localStorage.setItem('cbAskMode', askEl.checked ? '1' : '');
  sendAsk();
});

modelEl.value = localStorage.getItem('cbChatModel') || localStorage.getItem('arcChatModel') || '';
if (modelEl.selectedIndex === -1) modelEl.value = '';
fitModelWidth();

modelEl.addEventListener('change', () => {
  localStorage.setItem('cbChatModel', modelEl.value);
  fitModelWidth();
  sendModel();
});

// scrollHeight omits the border, but box-sizing is border-box, so add the
// border back or the field shrinks by its border width on the first keystroke.
const inputBorder = (() => {
  const cs = getComputedStyle(inputEl);
  return parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
})();

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight + inputBorder, 140) + 'px';
  updateSendState();
});

renderChat();
updateSendState();
connect();
inputEl.focus();
