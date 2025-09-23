/*
  WebRTC signaling – 2 fős hívás, room-on belüli "aktív" státusszal.

  Újdonságok:
  [SR1] Külön "tagság" és "aktivitás": a szobában bárki bent lehet, de MAX_PEERS csak az aktívakra vonatkozik.
  [SR2] set-active: a kliens be-/kikapcsolja az aktivitását (joinCall -> true, leaveCall -> false).
  [SR3] hangup: akitől érkezik, annak active=false; a másik fél is "tudjon leavelni".
  [SR4] peer-left / close: kilépéskor active=false + tagságból is kivesszük.
  [SR5] heartbeat (ping/pong) – szellemek takarítása.
*/

const http = require('http');
const WebSocket = require('ws');

const MAX_PEERS = 2;                 // egyszerre aktív peerek száma
const rooms = new Map();             // room -> Set<WebSocket>

// --- HTTP (health) ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Signaling running\n');
});

// --- WS ---
const wss = new WebSocket.Server({ server });

function getRoomSet(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}

function activeCount(room) {
  const set = rooms.get(room) || new Set();
  let n = 0;
  set.forEach(ws => { if (ws.meta?.active) n++; });
  return n;
}

function broadcast(room, sender, obj) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const set = rooms.get(room) || new Set();
  set.forEach(ws => {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function kickSameName(room, name, except) {
  const set = rooms.get(room);
  if (!set) return;
  for (const peer of Array.from(set)) {
    if (peer !== except && peer.meta?.name === name) {
      try { peer.close(1000, 'replaced'); } catch {}
      set.delete(peer);
    }
  }
}

function joinRoom(ws, room, name) {
  const set = getRoomSet(room);

  // takarítás
  for (const p of Array.from(set)) {
    if (p.readyState !== WebSocket.OPEN) set.delete(p);
  }

  kickSameName(room, name, ws);

  // tagság (NEM számít a MAX-ba)
  ws.meta.room = room;
  ws.meta.name = name;
  ws.meta.active = false;           // alapból inaktív
  set.add(ws);

  const names = Array.from(set).map(x => x.meta?.name).filter(Boolean);
  ws.send(JSON.stringify({ type: 'room-state', room, peers: names, activeCount: activeCount(room) }));
  broadcast(room, ws, { type: 'peer-joined', name });
  console.log(`[JOIN] room=${room} name=${name} members=${set.size} active=${activeCount(room)}`);
}

function leaveRoom(ws) {
  const r = ws.meta.room;
  if (!r) return;
  const set = rooms.get(r);
  ws.meta.active = false;
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(r);
  }
  const name = ws.meta.name;
  ws.meta.room = null;
  ws.meta.name = null;
  broadcast(r, ws, { type: 'peer-left', name });
  console.log(`[LEAVE] room=${r} name=${name}`);
}

function setActive(ws, wantActive) {
  const r = ws.meta.room;
  if (!r) return { ok: false, reason: 'not-in-room' };
  const current = !!ws.meta.active;
  if (wantActive === current) return { ok: true, active: current };

  if (wantActive) {
    // induló hívás – csak ha van kapacitás
    if (activeCount(r) >= MAX_PEERS) {
      return { ok: false, reason: 'room-full' };
    }
    ws.meta.active = true;
  } else {
    ws.meta.active = false;
  }
  return { ok: true, active: ws.meta.active };
}

// heartbeat
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} leaveRoom(ws); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.meta = { room: null, name: null, active: false };

  ws.on('message', raw => {
    let msg = {};
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg.type;

    if (t === 'join') {
      const room = String(msg.room || '');
      const name = String(msg.name || 'peer');
      joinRoom(ws, room, name);
      return;
    }

    if (!ws.meta.room) {
      if (t === 'leave-room') { ws.send(JSON.stringify({ type: 'left' })); }
      return;
    }

    // aktivitás
    if (t === 'set-active') {
      const want = !!msg.active;
      const res = setActive(ws, want);
      if (!res.ok && res.reason === 'room-full') {
        ws.send(JSON.stringify({ type: 'room-full', room: ws.meta.room }));
      } else {
        ws.send(JSON.stringify({ type: 'active', active: !!res.active }));
      }
      return;
    }

    // jelzések
    if (t === 'offer' || t === 'answer' || t === 'ice') {
      // első offer/answer is beaktiválhat (biztonsági háló)
      if (!ws.meta.active) {
        const res = setActive(ws, true);
        if (!res.ok && res.reason === 'room-full') {
          ws.send(JSON.stringify({ type: 'room-full', room: ws.meta.room }));
          return;
        }
        ws.send(JSON.stringify({ type: 'active', active: true }));
      }
      broadcast(ws.meta.room, ws, msg);
      return;
    }

    // hívás-flow
    if (t === 'ring' || t === 'ring-accept' || t === 'ring-cancel') {
      broadcast(ws.meta.room, ws, {
        type: t,
        room: ws.meta.room,
        from: ws.meta.name,
        name: msg.name || ws.meta.name,
        ts: Date.now()
      });
      return;
    }

    if (t === 'hangup') {
      // a küldő inaktív lesz, a másik fél is tud reagálni (leaveCall)
      setActive(ws, false);
      broadcast(ws.meta.room, ws, {
        type: 'hangup',
        room: ws.meta.room,
        from: ws.meta.name,
        name: msg.name || ws.meta.name,
        ts: Date.now()
      });
      ws.send(JSON.stringify({ type: 'active', active: false }));
      return;
    }

    if (t === 'leave-room') {
      // valódi kilépés a roomból (ritkábban kell)
      leaveRoom(ws);
      ws.send(JSON.stringify({ type: 'left' }));
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);
});
