/*
  WebRTC signaling – stabil RING/START protokoll call_id-val.

  Fő elvek:
  - Minden hívásnak van CALL_ID (uuid) → csak erre engedünk WebRTC-t.
  - Szerver-vezérelt kapu: OFFER/ANSWER/ICE csak START után mehet.
  - Régi/kései csomagok eldobása (call_id + epoch).
  - RING és RINGING üzenetek ACK-kal, egyszerű automata újraküldéssel.

  Üzenetek (mind JSON):
  C → S:
    join{room,name}
    invite{room,from}                         -> S: invite-ok{call_id} (caller) + ring{call_id,from} (callee)
    ring-ack{call_id}
    accept{call_id}
    decline{call_id}
    hangup{call_id}

    offer{call_id,sdp} / answer{call_id,sdp} / ice{call_id,candidate{...}}  // csak START után!

  S → C:
    room-state{room,peers[]}
    ring{call_id,from}
    ringing{call_id}                          // csak callernek, ha callee ACK-olt
    start{call_id, role:"initiator"|"callee"} // ezután mehet a WebRTC
    end{call_id, reason:"declined"|"hangup"|"timeout"|"left"}
    busy{reason}
    error{msg}

  Health: GET /health → OK
*/

const http = require('http');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('OK'); return; }
  res.writeHead(200); res.end('Signaling up\n');
});

const wss = new WebSocket.Server({ server });

const rooms = new Map(); // room -> { members:Set<ws>, activeCall: { id, caller, callee, state, started, createdAt }, epoch:number }
const RING_RETRY_MS = 800;
const RING_RETRY_MAX = 6;

function getRoom(room) {
  if (!rooms.has(room)) rooms.set(room, { members: new Set(), activeCall: null, epoch: 0 });
  return rooms.get(room);
}
function send(ws, obj) { try { ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj)); } catch {} }
function bcast(roomObj, except, obj) {
  roomObj.members.forEach(ws => { if (ws !== except && ws.readyState === WebSocket.OPEN) send(ws, obj); });
}
function setMeta(ws, patch) { ws.meta = Object.assign(ws.meta || { room:null, name:null }, patch); }
function clearActiveCall(roomObj, reason) {
  const call = roomObj.activeCall;
  if (!call) return;
  // lezárjuk mindkét fél felé
  roomObj.members.forEach(ws => {
    if (ws.meta?.room === call.room) send(ws, { type:'end', call_id: call.id, reason });
  });
  roomObj.activeCall = null;
  roomObj.epoch++;
}

function currentPeers(roomObj) {
  const names = [];
  roomObj.members.forEach(ws => { if (ws.meta?.name) names.push(ws.meta.name); });
  return names;
}

// RING újraküldő tároló
const ringTimers = new Map(); // call_id -> { room, toWs, tries }

function scheduleRingResend(call_id, roomObj, target) {
  const key = call_id;
  ringTimers.get(key)?.timer && clearTimeout(ringTimers.get(key).timer);
  const entry = ringTimers.get(key) || { tries: 0, room: roomObj, to: target, timer: null };
  if (entry.tries >= RING_RETRY_MAX) { return; }
  entry.tries++;
  entry.timer = setTimeout(() => {
    const still = roomObj.activeCall && roomObj.activeCall.id === call_id && !roomObj.activeCall.started;
    if (!still) return;
    if (entry.to?.readyState === WebSocket.OPEN) send(entry.to, { type: 'ring', call_id, from: roomObj.activeCall.caller?.meta?.name || 'peer' });
    scheduleRingResend(call_id, roomObj, target);
  }, RING_RETRY_MS);
  ringTimers.set(key, entry);
}
function stopRingResend(call_id) {
  const e = ringTimers.get(call_id);
  if (e?.timer) clearTimeout(e.timer);
  ringTimers.delete(call_id);
}

function leaveRoom(ws) {
  const rname = ws.meta?.room;
  if (!rname) return;
  const roomObj = rooms.get(rname);
  if (!roomObj) return;

  roomObj.members.delete(ws);

  // Ha folyamatban lévő hívás résztvevője volt → END
  const call = roomObj.activeCall;
  if (call && (call.caller === ws || call.callee === ws)) {
    stopRingResend(call.id);
    clearActiveCall(roomObj, 'left');
  }

  if (roomObj.members.size === 0) rooms.delete(rname);
}

wss.on('connection', (ws) => {
  setMeta(ws, { room:null, name:null });
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (raw) => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type;

    if (t === 'join') {
      const roomObj = getRoom(String(msg.room || 'default'));
      setMeta(ws, { room: String(msg.room || 'default'), name: String(msg.name || 'peer') });
      roomObj.members.add(ws);
      send(ws, { type:'room-state', room: ws.meta.room, peers: currentPeers(roomObj) });
      return;
    }

    const roomObj = rooms.get(ws.meta?.room);
    if (!roomObj) { send(ws, { type:'error', msg:'not in room' }); return; }

    if (t === 'invite') {
      // csak 2 fős hívás
      if (roomObj.activeCall) { send(ws, { type:'busy', reason:'call-active' }); return; }
      // keressünk partner(eke)t
      let callee = null;
      for (const m of roomObj.members) { if (m !== ws) { callee = m; break; } }
      if (!callee) { send(ws, { type:'busy', reason:'no-peer' }); return; }

      const call_id = randomUUID();
      roomObj.activeCall = { id: call_id, room: ws.meta.room, caller: ws, callee, state:'RINGING', started:false, createdAt: Date.now() };
      send(ws, { type:'invite-ok', call_id });
      send(callee, { type:'ring', call_id, from: ws.meta.name || 'peer' });
      scheduleRingResend(call_id, roomObj, callee);
      return;
    }

    if (t === 'ring-ack') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id) return;
      stopRingResend(call.id);
      send(call.caller, { type:'ringing', call_id: call.id });
      return;
    }

    if (t === 'accept' || t === 'decline') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id) return;
      if (t === 'decline') {
        stopRingResend(call.id);
        clearActiveCall(roomObj, 'declined');
        return;
      }
      // accept
      call.state = 'CONNECTING';
      call.started = true;
      stopRingResend(call.id);
      // caller lesz az initiator
      send(call.caller, { type:'start', call_id: call.id, role:'initiator' });
      send(call.callee, { type:'start', call_id: call.id, role:'callee' });
      return;
    }

    if (t === 'hangup') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id) return;
      stopRingResend(call.id);
      clearActiveCall(roomObj, 'hangup');
      return;
    }

    // WebRTC jelzések – csak AKTÍV call_id-ra és csak START után!
    if (t === 'offer' || t === 'answer' || t === 'ice') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id || !call.started) {
        // drop
        return;
      }
      const target = (ws === call.caller) ? call.callee : call.caller;
      send(target, msg);
      return;
    }

    if (t === 'leave-room') {
      leaveRoom(ws);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} }
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30000);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, '0.0.0.0', () => console.log('Signaling on ws://0.0.0.0:' + PORT));
