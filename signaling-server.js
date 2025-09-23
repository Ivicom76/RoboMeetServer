/*
  WebRTC signaling – stabil RING/START protokoll call_id-val.

  Üzenetek (mind JSON):
  C → S:
    join{room,name}
    invite{room,from}                         -> S: invite-ok{call_id} (caller) + ring{call_id,from} (callee)
    ring-ack{call_id}
    accept{call_id}
    decline{call_id}
    hangup{call_id}
    offer{call_id,sdp} / answer{call_id,sdp} / ice{call_id,candidate{...}}  // CSAK START után!

  S → C:
    room-state{room,peers[]}
    invite-ok{call_id}
    ring{call_id,from}
    ringing{call_id}                          // callernek, ha callee ACK-olt
    start{call_id, role:"initiator"|"callee"} // csak ezután mehet a WebRTC
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

const rooms = new Map(); // room -> { members:Set<ws>, activeCall:{ id, room, caller, callee, state, started }, epoch:number }
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
function currentPeers(roomObj) {
  const names = [];
  roomObj.members.forEach(ws => ws.meta?.name && names.push(ws.meta.name));
  return names;
}

const ringTimers = new Map(); // call_id -> { roomObj, to, tries, timer }
function scheduleRingResend(call_id, roomObj, target) {
  const prev = ringTimers.get(call_id);
  if (prev?.timer) clearTimeout(prev.timer);
  const entry = prev || { tries: 0, roomObj, to: target, timer: null };
  if (entry.tries >= RING_RETRY_MAX) return;
  entry.tries++;
  entry.timer = setTimeout(() => {
    const call = roomObj.activeCall;
    if (!call || call.id !== call_id || call.started) return;
    if (entry.to?.readyState === WebSocket.OPEN) {
      send(entry.to, { type:'ring', call_id, from: call.caller?.meta?.name || 'peer' });
    }
    scheduleRingResend(call_id, roomObj, target);
  }, RING_RETRY_MS);
  ringTimers.set(call_id, entry);
}
function stopRingResend(call_id) {
  const e = ringTimers.get(call_id);
  if (e?.timer) clearTimeout(e.timer);
  ringTimers.delete(call_id);
}
function clearActiveCall(roomObj, reason) {
  const call = roomObj.activeCall;
  if (!call) return;
  stopRingResend(call.id);
  roomObj.members.forEach(ws => send(ws, { type:'end', call_id: call.id, reason }));
  roomObj.activeCall = null;
  roomObj.epoch++;
}
function leaveRoom(ws) {
  const r = ws.meta?.room;
  if (!r) return;
  const roomObj = rooms.get(r);
  if (!roomObj) return;
  roomObj.members.delete(ws);
  const call = roomObj.activeCall;
  if (call && (ws === call.caller || ws === call.callee)) clearActiveCall(roomObj, 'left');
  if (roomObj.members.size === 0) rooms.delete(r);
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
      const room = String(msg.room || 'default');
      const roomObj = getRoom(room);
      setMeta(ws, { room, name: String(msg.name || 'peer') });
      roomObj.members.add(ws);
      send(ws, { type:'room-state', room, peers: currentPeers(roomObj) });
      return;
    }

    const roomObj = rooms.get(ws.meta?.room);
    if (!roomObj) { send(ws, { type:'error', msg:'not in room' }); return; }

    if (t === 'invite') {
      if (roomObj.activeCall) { send(ws, { type:'busy', reason:'call-active' }); return; }
      let callee = null;
      for (const m of roomObj.members) { if (m !== ws) { callee = m; break; } }
      if (!callee) { send(ws, { type:'busy', reason:'no-peer' }); return; }

      const call_id = randomUUID();
      roomObj.activeCall = { id: call_id, room: ws.meta.room, caller: ws, callee, state:'RINGING', started:false };
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
      if (t === 'decline') { clearActiveCall(roomObj, 'declined'); return; }
      call.state = 'CONNECTING';
      call.started = true;
      stopRingResend(call.id);
      send(call.caller, { type:'start', call_id: call.id, role:'initiator' });
      send(call.callee, { type:'start', call_id: call.id, role:'callee' });
      return;
    }

    if (t === 'hangup') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id) return;
      clearActiveCall(roomObj, 'hangup');
      return;
    }

    // WebRTC jelzések – CSAK aktív call_id-ra és CSAK START után!
    if (t === 'offer' || t === 'answer' || t === 'ice') {
      const call = roomObj.activeCall;
      if (!call || call.id !== msg.call_id || !call.started) return; // drop
      const to = (ws === call.caller) ? call.callee : call.caller;
      send(to, msg);
      return;
    }

    if (t === 'leave-room') { leaveRoom(ws); return; }
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
