/**
 * ChatServer — app.js
 * Real-time chat powered by Firebase Realtime Database
 * ─────────────────────────────────────────────────────
 * ONE-TIME SETUP (takes ~3 minutes):
 *
 *  1. Go to https://console.firebase.google.com
 *  2. Click "Add project" → give it any name → Continue
 *  3. After creation, click the </> (Web) icon to register a web app
 *     App nickname: ChatServer  |  Skip Firebase Hosting → Register App
 *  4. Copy the firebaseConfig object shown, paste it below (replace the
 *     placeholder values).
 *  5. In the left sidebar: Build → Realtime Database → Create database
 *     → choose a server location → Start in TEST MODE → Enable
 *  6. Done — push to GitHub, the chat will work immediately.
 *
 * IMPORTANT: "Test mode" rules expire after 30 days by default.
 *   To make them permanent, go to Realtime Database → Rules and set:
 *   { "rules": { ".read": true, ".write": true } }
 * ─────────────────────────────────────────────────────
 */

/* ── Firebase config — replace ALL values below ── */
const firebaseConfig = {
  apiKey:            "AIzaSyBWQw7lyXRn9wzPEPfZ38WlFVNpjiiyuoc",
  authDomain:        "chatserver-c8f55.firebaseapp.com",
  databaseURL:       "https://chatserver-c8f55-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "chatserver-c8f55",
  storageBucket:     "chatserver-c8f55.firebasestorage.app",
  messagingSenderId: "814307622727",
  appId:             "1:814307622727:web:ab472a95e044f2e9e15662",
};
/* ─────────────────────────────────────────────── */

const DB_ROOT       = 'cs1';            // bump to wipe shared data
const MSG_HISTORY   = 120;             // messages loaded per room
const DEFAULT_ROOMS = ['general', 'random', 'tech', 'gaming', 'music'];
const AV_COLOURS    = 8;

/* ─────────────────────────────────────────────────────
   State
───────────────────────────────────────────────────── */
let db;
let firestoreDb;
let username    = '';
let currentRoom = '';
let rooms       = [...DEFAULT_ROOMS];

// Per-room message cache: roomName → Map<firebaseKey, msgObj>
const msgCache  = {};
// Active Firebase listeners: roomName → { ref, handler }
const listeners = {};

/* ─────────────────────────────────────────────────────
   DOM helpers
───────────────────────────────────────────────────── */
const $  = id  => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
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
  const d   = new Date(ts);
  const now = new Date();
  const y   = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString())   return 'Yesterday';
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function linkify(html) {
  return html.replace(
    /https?:\/\/[^\s"<>&]+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

/* ─────────────────────────────────────────────────────
   Firebase boot
───────────────────────────────────────────────────── */
function initFirebase() {
  // Guard: show error if config is still placeholder
  if (firebaseConfig.apiKey.startsWith('PASTE_')) {
    showConfigError();
    return false;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db          = firebase.database();
    firestoreDb = firebase.firestore();
    return true;
  } catch (err) {
    console.error('Firebase init error:', err);
    showConfigError(err.message);
    return false;
  }
}

function showConfigError(detail) {
  const banner = $('connection-banner');
  banner.textContent = detail
    ? `Firebase error: ${detail}`
    : '⚠ Firebase not configured. See setup instructions at the top of app.js.';
  banner.style.background  = 'rgba(224,82,96,.15)';
  banner.style.color       = 'var(--red)';
  banner.style.borderColor = 'rgba(224,82,96,.3)';
  banner.classList.remove('hidden');
}

/* ─────────────────────────────────────────────────────
   SHA-256 key hashing  (Web Crypto API — no dependencies)
───────────────────────────────────────────────────── */
async function hashKey(key) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ─────────────────────────────────────────────────────
   Login status helpers
───────────────────────────────────────────────────── */
function setLoginStatus(msg, type /* 'error'|'success'|'info' */) {
  const el = $('login-status');
  el.textContent = msg;
  el.className   = 'login-status ' + (type || '');
}

function setLoginBusy(busy) {
  const btn = $('join-btn');
  btn.disabled    = busy;
  btn.textContent = busy ? 'Checking…' : 'Enter Chat';
}

/* ─────────────────────────────────────────────────────
   Login  — verifies / registers username via Firestore
───────────────────────────────────────────────────── */
async function doLogin(rawName, rawKey) {
  const name = rawName.trim().replace(/[^\w\-. ]/g, '').slice(0, 24);
  const key  = rawKey.trim();

  if (!name) { setLoginStatus('Enter a username.', 'error'); $('username-input').focus(); return; }
  if (!key)  { setLoginStatus('Enter a secret key.', 'error'); $('key-input').focus(); return; }

  if (!initFirebase()) return;

  setLoginBusy(true);
  setLoginStatus('Checking…', 'info');

  try {
    const keyHash = await hashKey(key);
    const userRef = firestoreDb.collection('users').doc(name);
    const snap    = await userRef.get();

    if (!snap.exists) {
      // ── New username: register it ───────────────────
      await userRef.set({
        username:  name,
        keyHash,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastSeen:  firebase.firestore.FieldValue.serverTimestamp(),
      });
      setLoginStatus('Account created! Welcome, ' + name, 'success');
    } else {
      // ── Existing username: verify key ───────────────
      if (snap.data().keyHash !== keyHash) {
        setLoginStatus('Wrong secret key for "' + name + '".', 'error');
        setLoginBusy(false);
        return;
      }
      userRef.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() });
      setLoginStatus('Welcome back, ' + name + '!', 'success');
    }
  } catch (err) {
    setLoginStatus('Error: ' + err.message, 'error');
    setLoginBusy(false);
    return;
  }

  // ── Auth passed — enter chat ────────────────────────
  username = name;
  localStorage.setItem('cs_username', username);

  await new Promise(r => setTimeout(r, 600)); // let success message show briefly

  $('login-screen').classList.add('hidden');
  $('chat-screen').classList.remove('hidden');
  $('me-label').textContent = username;
  setLoginBusy(false);

  $('connection-banner').classList.remove('hidden');
  $('connection-banner').textContent = 'Connecting to Firebase…';
  $('connection-banner').style.cssText = '';

  db.ref('.info/connected').on('value', snap => {
    if (snap.val() === true) {
      $('connection-banner').classList.add('hidden');
    } else {
      $('connection-banner').classList.remove('hidden');
      $('connection-banner').textContent = 'Reconnecting…';
    }
  });

  startPresence();
  loadCustomRooms();
  renderSidebar();
  joinRoom('general');
}

function shakeInput(input) {
  input.style.borderColor = 'var(--red)';
  input.focus();
  setTimeout(() => { input.style.borderColor = ''; }, 1200);
}

/* ─────────────────────────────────────────────────────
   Presence  (uses Firebase onDisconnect — server-side)
───────────────────────────────────────────────────── */
function startPresence(oldUsername) {
  // Mark previous username offline if changing name
  if (oldUsername) {
    db.ref(`${DB_ROOT}/presence/${oldUsername}`).update({ online: false });
  }

  const presRef = db.ref(`${DB_ROOT}/presence/${username}`);

  db.ref('.info/connected').on('value', snap => {
    if (!snap.val()) return;

    // Server removes presence automatically on unexpected disconnect
    presRef.onDisconnect().update({
      online:   false,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
    });

    presRef.set({
      username,
      online:   true,
      lastSeen: firebase.database.ServerValue.TIMESTAMP,
    });
  });

  // Watch all presence nodes
  db.ref(`${DB_ROOT}/presence`).on('value', snap => {
    const data = snap.val() || {};
    renderOnlineUsers(data);
  });
}

/* ─────────────────────────────────────────────────────
   Sidebar
───────────────────────────────────────────────────── */
function renderSidebar() {
  const list = $('room-list');
  list.innerHTML = '';
  rooms.forEach(r => {
    const li = el('li', 'room-item' + (r === currentRoom ? ' active' : ''));
    li.innerHTML = `<span class="hash">#</span> ${esc(r)}`;
    li.addEventListener('click', () => { closeMobileSidebar(); joinRoom(r); });
    list.appendChild(li);
  });
}

function renderOnlineUsers(presenceData) {
  const list  = $('user-list');
  const count = $('online-count');
  const now   = Date.now();

  const online = Object.values(presenceData)
    .filter(u => u && u.online && u.username);

  count.textContent = online.length;
  list.innerHTML    = '';

  online.forEach(u => {
    const li = el('li', 'user-item');
    li.innerHTML = `<span class="presence-dot online"></span> ${esc(u.username)}`;
    list.appendChild(li);
  });
}

/* ─────────────────────────────────────────────────────
   Rooms
───────────────────────────────────────────────────── */
function joinRoom(room) {
  if (room === currentRoom) return;

  currentRoom = room;
  if (!msgCache[room]) msgCache[room] = new Map();

  $('room-title').textContent       = room;
  $('message-input').placeholder    = `Message #${room}…`;

  renderSidebar();
  clearMessages();
  subscribeRoom(room);
}

function subscribeRoom(room) {
  // Detach listener from previous room (save Firebase reads)
  const prev = listeners[room];
  if (prev) prev.ref.off('child_added', prev.handler);

  const ref     = db.ref(`${DB_ROOT}/rooms/${room}/messages`).limitToLast(MSG_HISTORY);
  const cache   = msgCache[room];
  let   initial = true;   // batch the first load

  const handler = snap => {
    const msg = snap.val();
    if (!msg || !msg.text || !msg.ts) return;
    cache.set(snap.key, msg);
    if (!initial && room === currentRoom) appendMessage(snap.key, msg, cache);
  };

  ref.once('value', () => {
    // All child_added events for existing data have fired
    initial = false;
    if (room === currentRoom) renderAllMessages(room);
  });

  ref.on('child_added', handler);
  listeners[room] = { ref, handler };
}

/* ─────────────────────────────────────────────────────
   Message rendering
───────────────────────────────────────────────────── */
function clearMessages() {
  $('messages').innerHTML = `<div class="messages-placeholder"><p>Loading…</p></div>`;
}

function renderAllMessages(room) {
  const container = $('messages');
  const sorted    = sortedMessages(room);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="messages-placeholder"><p>No messages yet. Say hello!</p></div>`;
    return;
  }

  container.innerHTML = '';
  let lastAuthor = null, lastTs = 0, lastDay = null;

  sorted.forEach(([key, msg]) => {
    const day = fmtDate(msg.ts);
    if (day !== lastDay) {
      container.appendChild(makeDivider(day));
      lastDay = day; lastAuthor = null;
    }
    const grouped = lastAuthor === msg.author && (msg.ts - lastTs) < 300_000;
    container.appendChild(makeMsgRow(msg, grouped));
    lastAuthor = msg.author;
    lastTs     = msg.ts;
  });

  container.scrollTop = container.scrollHeight;
}

/** Append a single new message (called for live child_added events) */
function appendMessage(key, msg, cache) {
  const container = $('messages');
  const placeholder = container.querySelector('.messages-placeholder');
  if (placeholder) placeholder.remove();

  const sorted = sortedMessages(currentRoom);
  const idx    = sorted.findIndex(([k]) => k === key);
  const prev   = idx > 0 ? sorted[idx - 1][1] : null;

  const grouped = prev && prev.author === msg.author && (msg.ts - prev.ts) < 300_000;

  // Insert day divider if needed
  const day     = fmtDate(msg.ts);
  const prevDay = prev ? fmtDate(prev.ts) : null;
  if (day !== prevDay) container.appendChild(makeDivider(day));

  const wasAtBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 80;
  container.appendChild(makeMsgRow(msg, grouped));
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
}

function sortedMessages(room) {
  return [...(msgCache[room] || new Map()).entries()].sort(([, a], [, b]) => a.ts - b.ts);
}

function makeDivider(label) {
  const d = el('div', 'day-divider');
  d.textContent = label;
  return d;
}

function makeMsgRow(msg, grouped) {
  const row  = el('div', 'msg-row' + (grouped ? ' grouped' : ''));
  const isMe = msg.author === username;
  const av   = avatarClass(msg.author);

  if (grouped) {
    row.innerHTML = `
      <div class="msg-avatar ${av}"></div>
      <div class="msg-body">
        <span class="msg-text">${linkify(esc(msg.text))}</span>
      </div>`;
  } else {
    row.innerHTML = `
      <div class="msg-avatar ${av}">${esc(msg.author[0])}</div>
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

/* ─────────────────────────────────────────────────────
   Send
───────────────────────────────────────────────────── */
function sendMessage() {
  const input = $('message-input');
  const text  = input.value.trim();
  if (!text || !currentRoom || !db) return;
  input.value = '';
  $('send-btn').disabled = true;
  setTimeout(() => { $('send-btn').disabled = false; }, 400);

  db.ref(`${DB_ROOT}/rooms/${currentRoom}/messages`).push({
    text,
    author: username,
    ts:     firebase.database.ServerValue.TIMESTAMP,
  });
}

/* ─────────────────────────────────────────────────────
   Create room
───────────────────────────────────────────────────── */
function createRoom(raw) {
  const name = raw.trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  if (!name) { alert('Invalid channel name.'); return; }
  if (!rooms.includes(name)) {
    rooms.push(name);
    saveCustomRooms();
    renderSidebar();
  }
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

/* ─────────────────────────────────────────────────────
   Mobile sidebar
───────────────────────────────────────────────────── */
function openMobileSidebar() {
  document.querySelector('.sidebar').classList.add('open');
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

/* ─────────────────────────────────────────────────────
   Event wiring
───────────────────────────────────────────────────── */
$('join-btn').addEventListener('click', () => doLogin($('username-input').value, $('key-input').value));

// Tab from username → secret key; Enter from key → submit
$('username-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('key-input').focus(); }
});
$('key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); doLogin($('username-input').value, $('key-input').value); }
});

$('send-btn').addEventListener('click', sendMessage);
$('message-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

$('change-name-btn').addEventListener('click', async () => {
  const newName = prompt('New username:');
  if (!newName) return;
  const clean = newName.trim().replace(/[^\w\-. ]/g, '').slice(0, 24);
  if (!clean || clean === username) return;

  const key = prompt('Secret key for "' + clean + '"\n(enter new key to register, or existing key to reclaim):');
  if (!key) return;

  let keyHash;
  try { keyHash = await hashKey(key.trim()); } catch (_) { return; }

  const userRef = firestoreDb.collection('users').doc(clean);
  const snap    = await userRef.get();

  if (snap.exists && snap.data().keyHash !== keyHash) {
    alert('Wrong secret key for "' + clean + '".');
    return;
  }
  if (!snap.exists) {
    await userRef.set({
      username:  clean,
      keyHash,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastSeen:  firebase.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    userRef.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() });
  }

  const old = username;
  username  = clean;
  localStorage.setItem('cs_username', username);
  $('me-label').textContent = username;
  startPresence(old);
});

$('add-room-btn').addEventListener('click', () => {
  $('room-modal').classList.remove('hidden');
  $('room-name-input').value = '';
  setTimeout(() => $('room-name-input').focus(), 50);
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
$('room-modal').addEventListener('click', e => {
  if (e.target === $('room-modal')) $('room-modal').classList.add('hidden');
});

$('menu-btn').addEventListener('click', openMobileSidebar);

/* ─────────────────────────────────────────────────────
   Boot
───────────────────────────────────────────────────── */
(function boot() {
  const saved = localStorage.getItem('cs_username');
  if (saved) $('username-input').value = saved;
  $('username-input').focus();
})();
