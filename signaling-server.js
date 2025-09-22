/*
  Egyszerű WebRTC signaling szerver – 2 fős szobákhoz.

  Újdonságok a korábbi verzióhoz képest:
  [SR1] "leave-room": soft leave – a kliens WS nyitva marad, de a szobából kijelentkezik,
       így nem foglal slotot (nem lesz "room full").
  [SR2] "hangup": partner tájékoztatása bontásról (a kliens nem fog próbálkozni új offerrel).
  [SR3] "kickSameName": ugyanazzal a névvel újracsatlakozónál a régi példányt cseréljük (nem dupláz
       slotot ugyanaz a user).
  [SR4] Heartbeat + takarítás: ping/pong és halott kliensek kivezetése.
  [SR5] "room-state": belépéskor visszaadjuk a bent lévő neveket (debug/UX).

  Indítás:  npm i && npm start
*/

const http = require('http');
const WebSocket = require('ws');

const MAX_PEERS = 2;                // max 2 aktív kliens / szoba
const rooms = new Map();            // roomName -> Set<WebSocket>

// --- HTTP server (health) ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Signaling running\n');
});

// --- WS server ---
const wss = new WebSocket.Server({ server });

// Helper: broadcast egy szoba többi tagjának
function broadcast(room, sender, obj) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const set = rooms.get(room) || new Set();
  set.forEach(ws => {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

// [SR3] Ugyanazzal a névvel érkező kliensnél a régit lecseréljük
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

// [SR1] Soft leave: kiveszi a klienst a szobából, WS marad nyitva
function leaveRoom(ws) {
  const r = ws.meta.room;
  if (!r) return;
  const set = rooms.get(r);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(r);
  }
  const name = ws.meta.name;
  ws.meta.room = null;
  // értesítsük a bent maradó(ka)t
  broadcast(r, ws, { type: 'peer-left', name });
  console.log(`[LEAVE] room=${r} name=${name}`);
}

// Heartbeat
function noop() {}
function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.meta = { room: null, name: null };

  ws.on('message', raw => {
    if (typeof raw === 'string' && raw.length > 65536) return;
    let data = {};
    try { data = JSON.parse(raw); } catch { return; }

    const { type } = data;

    // keepalive echo (opcionális)
    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }

    // ---- JOIN ----
    if (type === 'join') {
      const room = String(data.room || '');
      const name = String(data.name || 'peer');
      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);

      // [SR4] belépés előtt halottak kipucolása
      for (const p of Array.from(set)) {
        if (p.readyState !== WebSocket.OPEN) set.delete(p);
      }

      // [SR3] ugyanazzal a névvel lévő régi példány kinyomása
      kickSameName(room, name, ws);

      // kapacitás ellenőrzés (MAX_PEERS)
      if (set.size >= MAX_PEERS) {
        console.log(`[REJECT] room=${room} name=${name} (full)`);
        ws.send(JSON.stringify({ type: 'room-full', room }));
        ws.close(1008, 'Room full');
        return;
      }

      // sikeres join
      ws.meta.room = room;
      ws.meta.name = name;
      set.add(ws);

      console.log(`[JOIN] room=${room} name=${name} peers=${set.size}`);
      const names = Array.from(set).map(x => x.meta?.name).filter(Boolean);
      ws.send(JSON.stringify({ type: 'room-state', room, peers: names }));
      broadcast(room, ws, { type: 'peer-joined', name });
      return;
    }

    // Innentől csak szobatagok kommunikálnak
    if (!ws.meta.room) {
      // [SR1] "leave-room" akkor is jöhet, ha már nincs bent (NOP)
      if (type === 'leave-room') ws.send(JSON.stringify({ type:'left' }));
      return;
    }

    // ---- WebRTC jelzések ----
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      console.log(`[${type.toUpperCase()}] from=${ws.meta.name} room=${ws.meta.room}`);
      broadcast(ws.meta.room, ws, data);
      return;
    }

    // ---- Telefonos hívás-flow ----
    if (type === 'ring' || type === 'ring-accept' || type === 'ring-cancel' || type === 'hangup') {
      const room = ws.meta.room;
      const from = ws.meta.name;
      const out = {
        type,
        room,
        from,
        name: data.name || from,
        ts: Date.now()
      };
      // csak a másik félnek
      broadcast(room, ws, out);

      if (type === 'ring') {
        // kézbesítési ack: hány peer kapta meg
        const set = rooms.get(room) || new Set();
        let delivered = 0;
        set.forEach(peer => { if (peer !== ws && peer.readyState === WebSocket.OPEN) delivered++; });
        ws.send(JSON.stringify({ type: 'ring-ack', room, delivered }));
      }
      return;
    }

    // ---- [SR1] Soft leave üzenet ----
    if (type === 'leave-room') {
      leaveRoom(ws);
      ws.send(JSON.stringify({ type: 'left' }));
      return;
    }

    // ismeretlen
    // console.log('[UNKNOWN]', data);
  });

  // fizikai WS zárás → takarítás
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Heartbeat időzítő
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} leaveRoom(ws); return; }
    ws.isAlive = false;
    try { ws.ping(noop); } catch {}
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

// Start
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);
});
