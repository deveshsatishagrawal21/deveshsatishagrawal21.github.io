/**
 * video.js — WebRTC group video calls
 *
 * Topology  : full-mesh (each peer connects directly to every other)
 * Signaling : Firebase Realtime Database  (reuses db from app.js)
 * NAT trav. : Google STUN (works for most networks)
 *
 * Firebase layout:
 *  cs1/calls/{room}/
 *    participants/{username}              → { username, ts }
 *    connections/{initiator}___{responder}/
 *      offer                             → { type, sdp }
 *      answer                            → { type, sdp }
 *      initiatorIce/{-id}               → RTCIceCandidate JSON
 *      responderIce/{-id}               → RTCIceCandidate JSON
 *
 * Role rule: alphabetically-higher username is the INITIATOR for
 *            each pair, so exactly one side creates the offer.
 */

/* ═══════════════════════════════════════════════════════════════
   Config
═══════════════════════════════════════════════════════════════ */
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 10,
};

/* ═══════════════════════════════════════════════════════════════
   State
═══════════════════════════════════════════════════════════════ */
let localStream     = null;   // camera + mic
let screenStream    = null;   // screen share (when active)
let peerConns       = {};     // peerUsername → RTCPeerConnection
let iceQueues       = {};     // peerUsername → ICE candidate array (pre-remote-desc buffer)
let callRoom        = null;   // room currently in a call
let participantsRef = null;   // Firebase ref being listened
let isMuted         = false;
let isCamOff        = false;
let isSharing       = false;
const audioAnalysers = {};    // peerUsername → { ctx, interval }

/* ═══════════════════════════════════════════════════════════════
   DOM
═══════════════════════════════════════════════════════════════ */
const callOverlay   = document.getElementById('call-overlay');
const callBtn       = document.getElementById('call-btn');
const callIndicator = document.getElementById('call-indicator');
const videoGrid     = document.getElementById('video-grid');
const muteBtn       = document.getElementById('mute-btn');
const cameraBtn     = document.getElementById('camera-btn');
const shareBtn      = document.getElementById('share-screen-btn');
const endCallBtn    = document.getElementById('end-call-btn');
const pipBtn        = document.getElementById('pip-btn');
const callRoomLabel = document.getElementById('call-room-label');
const callCountEl   = document.getElementById('call-count-label');

/* ═══════════════════════════════════════════════════════════════
   Entry / exit
═══════════════════════════════════════════════════════════════ */
callBtn.addEventListener('click', () => { callRoom ? leaveCall() : startJoin(); });
endCallBtn.addEventListener('click', leaveCall);

async function startJoin() {
  if (!db || !username) { alert('Log in first.'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 },
    });
  } catch (err) {
    alert('Could not access camera / microphone:\n' + err.message);
    return;
  }

  callRoom = currentRoom;
  callRoomLabel.textContent = '#' + callRoom;
  callOverlay.classList.remove('hidden');
  callBtn.classList.add('in-call');
  callIndicator.classList.remove('hidden');
  isMuted = isCamOff = isSharing = false;
  muteBtn.classList.remove('toggled-off');
  cameraBtn.classList.remove('toggled-off');
  shareBtn.classList.remove('sharing');

  addVideoTile('__local__', localStream, true);

  // Register presence
  const myRef = db.ref(`${DB_ROOT}/calls/${callRoom}/participants/${username}`);
  myRef.set({ username, ts: firebase.database.ServerValue.TIMESTAMP });
  myRef.onDisconnect().remove();

  // Watch participants
  participantsRef = db.ref(`${DB_ROOT}/calls/${callRoom}/participants`);

  participantsRef.on('child_added', snap => {
    const peer = snap.key;
    if (peer === username || peerConns[peer]) return;
    // Higher username (alphabetically) is initiator to break ties
    connectToPeer(peer, callRoom, username > peer);
  });

  participantsRef.on('child_removed', snap => removePeer(snap.key));
}

function leaveCall() {
  if (!callRoom) return;

  Object.keys(peerConns).forEach(removePeer);

  localStream?.getTracks().forEach(t => t.stop());
  screenStream?.getTracks().forEach(t => t.stop());
  localStream = screenStream = null;

  db.ref(`${DB_ROOT}/calls/${callRoom}/participants/${username}`).remove();
  participantsRef?.off();
  participantsRef = null;

  callRoom = null;
  videoGrid.innerHTML = '';
  callOverlay.classList.add('hidden');
  callBtn.classList.remove('in-call');
  callIndicator.classList.add('hidden');
}

/* ═══════════════════════════════════════════════════════════════
   WebRTC peer connection
═══════════════════════════════════════════════════════════════ */
async function connectToPeer(peer, room, iAmInitiator) {
  if (peerConns[peer]) return;

  const pc           = new RTCPeerConnection(ICE_CONFIG);
  peerConns[peer]    = pc;
  iceQueues[peer]    = [];

  addPeerTile(peer);

  // Attach local tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // Receive remote stream
  const remoteStream = new MediaStream();
  pc.ontrack = evt => {
    evt.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    attachStreamToTile(peer, remoteStream);
  };

  // ── Signal paths ──────────────────────────────────────────
  const initiator  = iAmInitiator ? username : peer;
  const responder  = iAmInitiator ? peer     : username;
  const connPath   = `${DB_ROOT}/calls/${room}/connections/${initiator}___${responder}`;
  const myIceKey   = iAmInitiator ? 'initiatorIce' : 'responderIce';
  const theirIceKey = iAmInitiator ? 'responderIce' : 'initiatorIce';

  // ── Send our ICE candidates ────────────────────────────────
  pc.onicecandidate = evt => {
    if (evt.candidate) {
      db.ref(`${connPath}/${myIceKey}`).push(evt.candidate.toJSON());
    }
  };

  // ── Receive their ICE candidates (buffered until remote desc) ─
  db.ref(`${connPath}/${theirIceKey}`).on('child_added', async snap => {
    const c = snap.val();
    if (!c) return;
    if (pc.remoteDescription) {
      await safeAddIce(pc, c);
    } else {
      iceQueues[peer].push(c);
    }
  });

  async function flushIceQueue() {
    for (const c of iceQueues[peer] || []) await safeAddIce(pc, c);
    iceQueues[peer] = [];
  }

  // ── Connection state monitoring ────────────────────────────
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    updateTileConnState(peer, s);
    if (s === 'connected') watchAudioLevel(peer, remoteStream);
    if (s === 'failed') {
      // Attempt a single ICE restart
      if (iAmInitiator && pc.signalingState !== 'closed') {
        pc.restartIce();
        pc.createOffer({ iceRestart: true }).then(o => {
          pc.setLocalDescription(o);
          db.ref(`${connPath}/offer`).set({ type: o.type, sdp: o.sdp });
        });
      }
    }
    if (s === 'closed') removePeer(peer);
  };

  // ── Offer / answer exchange ────────────────────────────────
  if (iAmInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await db.ref(`${connPath}/offer`).set({ type: offer.type, sdp: offer.sdp });

    db.ref(`${connPath}/answer`).on('value', async snap => {
      const val = snap.val();
      if (!val || pc.currentRemoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(val));
      await flushIceQueue();
    });

  } else {
    db.ref(`${connPath}/offer`).on('value', async snap => {
      const val = snap.val();
      if (!val || pc.currentRemoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(val));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await db.ref(`${connPath}/answer`).set({ type: answer.type, sdp: answer.sdp });
      await flushIceQueue();
    });
  }
}

async function safeAddIce(pc, candidate) {
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
}

function removePeer(peer) {
  const pc = peerConns[peer];
  if (pc) { pc.close(); delete peerConns[peer]; }
  delete iceQueues[peer];

  if (audioAnalysers[peer]) {
    clearInterval(audioAnalysers[peer].interval);
    try { audioAnalysers[peer].ctx.close(); } catch (_) {}
    delete audioAnalysers[peer];
  }

  document.getElementById(`tile-${peer}`)?.remove();
  updateCount();
}

/* ═══════════════════════════════════════════════════════════════
   Controls
═══════════════════════════════════════════════════════════════ */
muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.classList.toggle('toggled-off', isMuted);
  refreshLocalLabel();
});

cameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  cameraBtn.classList.toggle('toggled-off', isCamOff);
  refreshLocalLabel();

  const tile  = document.getElementById('tile-__local__');
  if (!tile) return;
  const video = tile.querySelector('video');
  if (video) video.style.visibility = isCamOff ? 'hidden' : 'visible';

  if (isCamOff) {
    if (!tile.querySelector('.video-avatar')) tile.appendChild(makeAvatar(username));
  } else {
    tile.querySelector('.video-avatar')?.remove();
  }
});

shareBtn.addEventListener('click', async () => {
  if (!localStream) return;
  if (isSharing) {
    stopSharing();
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (_) {
    return;
  }
  isSharing = true;
  shareBtn.classList.add('sharing');
  const track = screenStream.getVideoTracks()[0];
  replaceVideoTrack(track);
  const tile  = document.getElementById('tile-__local__');
  const video = tile?.querySelector('video');
  if (video) video.srcObject = new MediaStream([...localStream.getAudioTracks(), track]);
  track.onended = stopSharing;
});

function stopSharing() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;
  isSharing = false;
  shareBtn.classList.remove('sharing');
  // Restore camera track
  const camTrack = localStream?.getVideoTracks()[0];
  if (camTrack) {
    replaceVideoTrack(camTrack);
    const tile  = document.getElementById('tile-__local__');
    const video = tile?.querySelector('video');
    if (video) video.srcObject = localStream;
  }
}

function replaceVideoTrack(newTrack) {
  Object.values(peerConns).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (sender) sender.replaceTrack(newTrack);
  });
}

pipBtn.addEventListener('click', async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      const vid = videoGrid.querySelector('video:not(#tile-__local__ video)')
               || videoGrid.querySelector('video');
      if (vid) await vid.requestPictureInPicture();
    }
  } catch (_) {}
});

/* ═══════════════════════════════════════════════════════════════
   Tile rendering helpers
═══════════════════════════════════════════════════════════════ */
function addVideoTile(id, stream, isLocal) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.srcObject   = stream;
  video.autoplay    = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = isLocal ? 'You' : id;

  tile.appendChild(video);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
  updateCount();
}

function addPeerTile(peer) {
  if (document.getElementById(`tile-${peer}`)) return;

  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${peer}`;

  const loader = document.createElement('div');
  loader.className = 'tile-connecting';
  loader.innerHTML = '<div class="spinner"></div><span>Connecting…</span>';

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = peer;

  tile.appendChild(loader);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
  updateCount();
}

function attachStreamToTile(peer, stream) {
  const tile = document.getElementById(`tile-${peer}`);
  if (!tile) return;
  tile.querySelector('.tile-connecting')?.remove();
  tile.querySelector('.video-avatar')?.remove();

  let video = tile.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay    = true;
    video.playsInline = true;
    tile.insertBefore(video, tile.firstChild);
  }
  video.srcObject = stream;
}

function updateTileConnState(peer, state) {
  const tile = document.getElementById(`tile-${peer}`);
  if (!tile) return;
  if (state === 'connected') tile.querySelector('.tile-connecting')?.remove();
  if (state === 'disconnected') {
    tile.querySelector('.tile-connecting')?.remove();
    if (!tile.querySelector('.tile-connecting')) {
      const ldr = document.createElement('div');
      ldr.className = 'tile-connecting';
      ldr.innerHTML = '<div class="spinner"></div><span>Reconnecting…</span>';
      tile.prepend(ldr);
    }
  }
}

function makeAvatar(name) {
  const cls = typeof avatarClass === 'function' ? avatarClass(name) : 'av-0';
  const wrap = document.createElement('div');
  wrap.className = 'video-avatar';
  const circle = document.createElement('div');
  circle.className = `av-circle ${cls}`;
  circle.textContent = (name[0] || '?').toUpperCase();
  wrap.appendChild(circle);
  return wrap;
}

function refreshLocalLabel() {
  const tile  = document.getElementById('tile-__local__');
  const label = tile?.querySelector('.tile-label');
  if (!label) return;
  const parts = ['You'];
  if (isMuted)  parts.push('🔇');
  if (isCamOff) parts.push('📵');
  label.textContent = parts.join(' ');
}

function updateCount() {
  if (callCountEl) callCountEl.textContent = videoGrid.querySelectorAll('.video-tile').length;
}

/* ═══════════════════════════════════════════════════════════════
   Audio level visualisation  (speaking border highlight)
═══════════════════════════════════════════════════════════════ */
function watchAudioLevel(peer, stream) {
  if (audioAnalysers[peer]) return;
  try {
    const ctx      = new AudioContext();
    const src      = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf      = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      const avg  = buf.reduce((s, v) => s + v, 0) / buf.length;
      const tile = document.getElementById(`tile-${peer}`);
      tile?.classList.toggle('speaking', avg > 12);
    }, 120);
    audioAnalysers[peer] = { ctx, interval };
  } catch (_) {}
}
