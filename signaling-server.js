/*
  WebRTC signaling – stabil RING/START protokoll call_id-val + START előtti pufferelés.

  Üzenetek (JSON):
  C → S:
    join{room,name}
    invite{room,from}                         -> S: invite-ok{call_id} (caller) + ring{call_id,from} (callee)
    ring-ack{call_id}
    accept{call_id}
    decline{call_id}
    hangup{call_id}
    offer{call_id,sdp} / answer{call_id,sdp} / ice{call_id,candidate{...}}  // START előtt puffereljük!

  S → C:
    room-state{room,peers[]}
    invite-ok{call_id}
    ring{call_id,from}
    ringing{call_id}                          // callernek, ha callee ACK-olt
    start{call_id, role:"initiator"|"callee"} // ezután a puffer FLUSH és mehet a WebRTC
    end{call_id, reason:"declined"|"hangup"|"timeout"|"left"}
    busy{reason}
    error{msg}

  Health: GET /health → OK
*/

const http = require('http');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

// --- HTTP szerver (health + alap válasz) ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }
  res.writeHead(200); res.end('Signaling up\n');
});

// --- WebSocket szerver ---
const wss = new WebSocket.Server({ server });

// Szoba → { members:Set<ws>, activeCall:{ id, caller, callee, started, state, pending:[] } }
const rooms = new Map();

// RING újraküldés (ha a callee nem ack-ol)
const RING_RETRY_MS  = 800;
const RING_RETRY_MAX = 6;
const ringTimers = new Map(); // call_id -> { tries, timer, roomKey }

function getRoom(roomKey) {
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, { members: new Set(), activeCall: null });
  }
  return rooms.get(roomKey);
}

function send(ws, obj) {
  try { ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj)); } catch {}
}

function currentPeers(roomObj) {
  const names = [];
  roomObj.members.forEach(ws => { if (ws.meta?.name) names.push(ws.meta.name); });
  return names;
}

function setMeta(ws, patch) {
  ws.meta = Object.assign(ws.meta || { room:null, name:null }, patch);
}

function otherPeer(call, fromWs) {
  return (fromWs === call.caller) ? call.callee : call.caller;
}

function scheduleRingResend(callId, roomKey) {
  const prev = ringTimers.get(callId);
  if (prev?.timer) clearTimeout(prev.timer);
  const entry = prev || { tries: 0, timer: null, roomKey };
  if (entry.tries >= RING_RETRY_MAX) { ringTimers.set(callId, entry); return; }
  entry.tries++;

  entry.timer = setTimeout(() => {
    const roomObj = rooms.get(entry.roomKey);
    const call = roomObj?.activeCall;
    if (!roomObj || !call || call.id !== callId || call.started) return;
    // küldjünk ismét RING-et a callee-nek, ha még mindig nem kezdődött
    send(call.callee, { type:'ring', call_id: call.id, from: call.caller?.meta?.name || 'peer' });
    scheduleRingResend(callId, entry.roomKey);
  }, RING_RETRY_MS);

  ringTimers.set(callId, entry);
}

function stopRingResend(callId) {
  const e = ringTimers.get(callId);
  if (e?.timer) clearTimeout(e.timer);
  ringTimers.delete(callId);
}

// START előtti offer/answer/ice puffer flush-olása START után
function flushPending(call) {
  if (!call || !call.started) return;
  const list = call.pending || [];
  call.pending = [];
  for (const msg of list) {
    const to = msg.__to;           // flush-hoz eltároltuk, hova kell mennie
    delete msg.__to;
    send(to, msg);
  }
}

// Hívás lezárása és takarítás
function clearActiveCall(roomObj, reason) {
  const call = roomObj.activeCall;
  if (!call) return;
  stopRingResend(call.id);
  // értesítsünk minden szobatagot a befejezésről (hívás mindenkire érvényes abban a room-ban)
  roomObj.members.forEach(ws => send(ws, { type:'end', call_id: call.id, reason }));
  call.pending = [];
  roomObj.activeCall = null;
}

// Kilépés a szobából (socket zárás vagy explicit leave)
function leaveRoom(ws) {
  const roomKey = ws.meta?.room;
  if (!roomKey) return;
  const roomObj = rooms.get(roomKey);
  if (!roomObj) return;
  roomObj.members.delete(ws);

  // Ha aktív hívás résztvevője volt, zárjuk le
  const call = roomObj.activeCall;
  if (call && (ws === call.caller || ws === call.callee)) {
    clearActiveCall(roomObj, 'left');
  }

  if (roomObj.members.size === 0) rooms.delete(roomKey);
}

// --- WS kapcsolatok kezelése ---
wss.on('connection', (ws) => {
  setMeta(ws, { room:null, name:null });
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type;

    // --- JOIN ---
    if (t === 'join') {
      const roomKey = String(msg.room || 'default');
      const roomObj = getRoom(roomKey);
      setMeta(ws, { room: roomKey, name: String(msg.name || 'peer') });
      roomObj.members.add(ws);
      // visszaadjuk a jelen lévő neveket
      send(ws, { type:'room-state', room: roomKey, peers: currentPeers(roomObj) });
      return;
    }

    // a továbbiakban csak akkor dolgozunk, ha a socket bent van egy szobában
    const roomKey = ws.meta?.room;
    const roomObj = roomKey ? rooms.get(roomKey) : null;
    if (!roomObj) { send(ws, { type:'error', msg:'not in room' }); return; }

    // --- INVITE ---
    if (t === 'invite') {
      if (roomObj.activeCall) { send(ws, { type:'busy', reason:'call-active' }); return; }
      // egyszerű 1:1 – az első másik tag legyen a callee
      let callee = null;
      for (const m of roomObj.members) { if (m !== ws) { callee = m; break; } }
      if (!callee) { send(ws, { type:'busy', reason:'no-peer' }); return; }

      const call_id = randomUUID();
      roomObj.activeCall = {
        id: call_id,
        caller: ws,
        callee,
        started: false,
        state: 'RINGING',
        pending: []        // <-- START előtti offer/answer/ice ide kerül
      };

      // caller visszaigazolás + RING a callee-nek
      send(ws,      { type:'invite-ok', call_id });
      send(callee,  { type:'ring',      call_id, from: ws.meta?.name || 'peer' });

      scheduleRingResend(call_id, roomKey);
      return;
    }

    // --- RING ACK (callee jelez: "csörög nálam") ---
    if (t === 'ring-ack') {
      const c = roomObj.activeCall;
      if (!c || c.id !== msg.call_id) return;
      stopRingResend(c.id);
      send(c.caller, { type:'ringing', call_id: c.id });
      return;
    }

    // --- ACCEPT / DECLINE ---
    if (t === 'accept' || t === 'decline') {
      const c = roomObj.activeCall;
      if (!c || c.id !== msg.call_id) return;

      if (t === 'decline') { clearActiveCall(roomObj, 'declined'); return; }

      // elfogadva → START
      c.state = 'CONNECTING';
      c.started = true;
      stopRingResend(c.id);
      send(c.caller, { type:'start', call_id: c.id, role:'initiator' });
      send(c.callee, { type:'start', call_id: c.id, role:'callee' });

      // START után azonnal FLUSH minden korábban beérkezett offer/ice
      flushPending(c);
      return;
    }

    // --- HANGUP ---
    if (t === 'hangup') {
      const c = roomObj.activeCall;
      if (!c || c.id !== msg.call_id) return;
      clearActiveCall(roomObj, 'hangup');
      return;
    }

    // --- WebRTC jelzések (offer/answer/ice) ---
    if (t === 'offer' || t === 'answer' || t === 'ice') {
      const c = roomObj.activeCall;
      if (!c || c.id !== msg.call_id) return;

      const to = otherPeer(c, ws);
      if (!to) return;

      // normalizált forward payload
      const forward = (t === 'ice')
        ? { type:'ice', call_id: c.id, candidate: msg.candidate }
        : { type:t,     call_id: c.id, sdp: msg.sdp };

      if (c.started) {
        // már él a hívás → azonnal továbbítjuk
        send(to, forward);
      } else {
        // START előtt vagyunk → puffereljük és START után flush-oljuk
        forward.__to = to;       // ide kell majd mennie flush-kor
        c.pending.push(forward);
      }
      return;
    }

    if (t === 'leave-room') { leaveRoom(ws); return; }

    // ismeretlen üzenet
    send(ws, { type:'error', msg:'unknown message type' });
  });

  // kilépés/hiba
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// --- Heartbeat a fél-behalt kliensek lekezelésére ---
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// --- Indítás ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Signaling on ws://0.0.0.0:' + PORT);
});
