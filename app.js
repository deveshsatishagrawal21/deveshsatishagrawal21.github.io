/**
 * ChatServer — app.js
 * P2P real-time chat powered by Gun.js
 *
 * Architecture:
 *   gun.get('cs1').get('rooms').get(<room>).get('messages').get(<id>)  → message node
 *   gun.get('cs1').get('presence').get(<username>)                     → presence node
 *
 * Gun.js syncs via localStorage + public relay peers.
 * All data is eventually consistent across connected browsers.
 */

/* ─────────────────────────────────────────
   Constants
───────────────────────────────────────── */
const NS          = 'cs1';          // Gun namespace (bump to reset shared state)
const PEER_URLS   = [
  'https://gundb-relay-mlc.glitch.me/gun',
  'https://peer.wallie.io/gun',
  'https://gun-manhattan.herokuapp.com/gun',
];
const PRESENCE_TTL = 90_000;        // ms — consider user offline after this
const PING_INTERVAL = 30_000;       // ms — how often to refresh lastSeen
const DEFAULT_ROOMS = ['general', 'random', 'tech', 'gaming', 'music'];

/* Avatar colours — matched by CSS class .av-N */
const AV_COLOURS = 8;

/* ─────────────────────────────────────────
   State
───────────────────────────────────────── */
let gun;
let username     = '';
let currentRoom  = '';
let rooms        = [...DEFAULT_ROOMS];
const messages   = {};      // roomName → { msgId: msgData }
const onlineNow  = {};      // username → { username, lastSeen }
let presencePing = null;
let roomUnsub    = null;    // cleanup fn for current room listener

/* ─────────────────────────────────────────
   DOM helpers
───────────────────────────────────────── */
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (html) e.innerHTML   = html;
  return e;
};

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(str));
  return d.innerHTML;
}

function avatarClass(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return 'av-' + (Math.abs(h) % AV_COLOURS);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

/* ─────────────────────────────────────────
   Initialise Gun
───────────────────────────────────────── */
function initGun() {
  gun = Gun(PEER_URLS);

  // Show/hide connecting banner
  $('connection-banner').classList.remove('hidden');
  // Gun doesn't expose a clean "connected" event, but the banner
  // auto-hides after the first successful message sync (see renderRoom).
}

/* ─────────────────────────────────────────
   Login
───────────────────────────────────────── */
function doLogin(name) {
  name = name.trim().replace(/[^\w\-. ]/g, '').slice(0, 24);
  if (!name) { shakeInput($('username-input')); return; }

  username = name;
  localStorage.setItem('cs_username', username);

  $('login-screen').classList.add('hidden');
  $('chat-screen').classList.remove('hidden');
  $('me-label').textContent = username;

  initGun();
  startPresence();
  renderSidebar();
  joinRoom(rooms[0]);
}

function shakeInput(input) {
  input.style.borderColor = 'var(--red)';
  input.focus();
  setTimeout(() => { input.style.borderColor = ''; }, 1200);
}

/* ─────────────────────────────────────────
   Presence
───────────────────────────────────────── */
function startPresence() {
  const me = gun.get(NS).get('presence').get(username);

  function ping() {
    me.put({ username, lastSeen: Date.now(), online: true });
  }

  ping();
  presencePing = setInterval(ping, PING_INTERVAL);

  window.addEventListener('beforeunload', () => {
    me.put({ username, lastSeen: Date.now(), online: false });
  });

  // Watch all presence nodes
  gun.get(NS).get('presence').map().on((data, key) => {
    if (!data || !data.username) return;
    const alive = data.online && (Date.now() - data.lastSeen < PRESENCE_TTL);
    if (alive) {
      onlineNow[key] = data;
    } else {
      delete onlineNow[key];
    }
    renderOnlineUsers();
  });

  // Recheck staleness every 30 s (Gun fires on() only when data changes)
  setInterval(() => {
    Object.keys(onlineNow).forEach(k => {
      if (Date.now() - onlineNow[k].lastSeen >= PRESENCE_TTL) {
        delete onlineNow[k];
      }
    });
    renderOnlineUsers();
  }, 30_000);
}

/* ─────────────────────────────────────────
   Sidebar render
───────────────────────────────────────── */
function renderSidebar() {
  const list = $('room-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const li = el('li', 'room-item' + (r === currentRoom ? ' active' : ''));
    li.innerHTML = `<span class="hash">#</span> ${esc(r)}`;
    li.addEventListener('click', () => {
      closeMobileSidebar();
      joinRoom(r);
    });
    list.appendChild(li);
  });
}

function renderOnlineUsers() {
  const list  = $('user-list');
  const count = $('online-count');
  const users = Object.values(onlineNow);
  count.textContent = users.length;
  list.innerHTML = '';
  users.forEach(u => {
    const li = el('li', 'user-item');
    li.innerHTML = `<span class="presence-dot online"></span> ${esc(u.username)}`;
    list.appendChild(li);
  });
}

/* ─────────────────────────────────────────
   Room switching
───────────────────────────────────────── */
function joinRoom(room) {
  if (room === currentRoom) return;

  currentRoom = room;
  $('room-title').textContent = room;
  $('message-input').placeholder = `Message #${room}…`;

  // Reset message cache for this room
  if (!messages[room]) messages[room] = {};

  renderSidebar();
  renderMessages(room);
  subscribeRoom(room);
}

function subscribeRoom(room) {
  // Re-subscribe: Gun listeners accumulate, so we key them by room
  // and simply filter by currentRoom when rendering.
  gun.get(NS).get('rooms').get(room).get('messages').map().on((data, key) => {
    if (!data || !data.text || !data.ts) return;

    // Hide connection banner on first data received
    $('connection-banner').classList.add('hidden');

    if (!messages[room]) messages[room] = {};
    messages[room][key] = data;

    if (room === currentRoom) renderMessages(room);
  });
}

/* ─────────────────────────────────────────
   Message rendering
───────────────────────────────────────── */
function renderMessages(room) {
  const container = $('messages');
  const bucket    = messages[room] || {};
  const sorted    = Object.values(bucket)
    .filter(m => m && m.text && m.ts)
    .sort((a, b) => a.ts - b.ts);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="messages-placeholder"><p>No messages yet. Say hello!</p></div>`;
    return;
  }

  const wasAtBottom =
    container.scrollHeight - container.clientHeight <= container.scrollTop + 60;

  container.innerHTML = '';

  let lastAuthor = null;
  let lastTs     = 0;
  let lastDay    = null;

  sorted.forEach(msg => {
    const day = fmtDate(msg.ts);
    if (day !== lastDay) {
      container.appendChild(makeDayDivider(day));
      lastDay    = day;
      lastAuthor = null;
    }

    const grouped = lastAuthor === msg.author && (msg.ts - lastTs) < 5 * 60_000;
    container.appendChild(makeMsgRow(msg, grouped));

    lastAuthor = msg.author;
    lastTs     = msg.ts;
  });

  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

function makeDayDivider(label) {
  const div = el('div', 'day-divider');
  div.textContent = label;
  return div;
}

function makeMsgRow(msg, grouped) {
  const row   = el('div', 'msg-row' + (grouped ? ' grouped' : ''));
  const isMe  = msg.author === username;
  const avCls = avatarClass(msg.author);

  if (grouped) {
    row.innerHTML = `
      <div class="msg-avatar ${avCls}"></div>
      <div class="msg-body">
        <span class="msg-text">${linkify(esc(msg.text))}</span>
      </div>`;
  } else {
    row.innerHTML = `
      <div class="msg-avatar ${avCls}">${esc(msg.author[0])}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author${isMe ? ' is-me' : ''}">${esc(msg.author)}</span>
          <span class="msg-time">${fmtTime(msg.ts)}</span>
        </div>
        <span class="msg-text">${linkify(esc(msg.text))}</span>
      </div>`;
  }

  return row;
}

/** Turns http/https URLs in already-escaped text into clickable links */
function linkify(html) {
  return html.replace(
    /https?:\/\/[^\s&"<>]+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

/* ─────────────────────────────────────────
   Send message
───────────────────────────────────────── */
function sendMessage() {
  const input = $('message-input');
  const text  = input.value.trim();
  if (!text || !currentRoom) return;

  input.value = '';

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  gun.get(NS).get('rooms').get(currentRoom).get('messages').get(id).put({
    text,
    author : username,
    ts     : Date.now(),
  });
}

/* ─────────────────────────────────────────
   Create room
───────────────────────────────────────── */
function createRoom(raw) {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  if (!name)            return alert('Invalid channel name.');
  if (rooms.includes(name)) { joinRoom(name); return; }

  rooms.push(name);
  // Persist custom rooms in localStorage
  saveCustomRooms();
  renderSidebar();
  joinRoom(name);
}

function saveCustomRooms() {
  const custom = rooms.filter(r => !DEFAULT_ROOMS.includes(r));
  localStorage.setItem('cs_rooms', JSON.stringify(custom));
}

function loadCustomRooms() {
  try {
    const saved = JSON.parse(localStorage.getItem('cs_rooms') || '[]');
    saved.forEach(r => { if (!rooms.includes(r)) rooms.push(r); });
  } catch (_) {}
}

/* ─────────────────────────────────────────
   Mobile sidebar
───────────────────────────────────────── */
function openMobileSidebar() {
  const sb = document.querySelector('.sidebar');
  sb.classList.add('open');

  if (!document.querySelector('.sidebar-overlay')) {
    const ov = el('div', 'sidebar-overlay');
    ov.addEventListener('click', closeMobileSidebar);
    document.body.appendChild(ov);
  }
}

function closeMobileSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.querySelector('.sidebar-overlay')?.remove();
}

/* ─────────────────────────────────────────
   Event wiring
───────────────────────────────────────── */
// Login
$('join-btn').addEventListener('click', () => doLogin($('username-input').value));
$('username-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin($('username-input').value); });

// Send
$('send-btn').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// Change username
$('change-name-btn').addEventListener('click', () => {
  const n = prompt('New username:', username);
  if (!n) return;
  const clean = n.trim().replace(/[^\w\-. ]/g, '').slice(0, 24);
  if (!clean) return;

  // Mark old username offline
  gun.get(NS).get('presence').get(username).put({ username, lastSeen: Date.now(), online: false });
  clearInterval(presencePing);

  username = clean;
  localStorage.setItem('cs_username', username);
  $('me-label').textContent = username;
  startPresence();
});

// Add room button
$('add-room-btn').addEventListener('click', () => {
  $('room-modal').classList.remove('hidden');
  $('room-name-input').value = '';
  $('room-name-input').focus();
});

$('room-cancel-btn').addEventListener('click', () => $('room-modal').classList.add('hidden'));

$('room-create-btn').addEventListener('click', () => {
  createRoom($('room-name-input').value);
  $('room-modal').classList.add('hidden');
});

$('room-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { createRoom($('room-name-input').value); $('room-modal').classList.add('hidden'); }
  if (e.key === 'Escape') { $('room-modal').classList.add('hidden'); }
});

// Close modal on backdrop click
$('room-modal').addEventListener('click', e => {
  if (e.target === $('room-modal')) $('room-modal').classList.add('hidden');
});

// Mobile menu
$('menu-btn').addEventListener('click', openMobileSidebar);

/* ─────────────────────────────────────────
   Boot
───────────────────────────────────────── */
(function boot() {
  loadCustomRooms();
  const saved = localStorage.getItem('cs_username');
  if (saved) {
    $('username-input').value = saved;
    // Don't auto-login; let user confirm they still want that name
  }
  $('username-input').focus();
})();
