/*
  Egyszerű WebRTC signaling szerver.
  Node.js + WebSocket alapú, szobánként max. 2 peer támogatásával.

  VÁLTOZTATÁSOK A DEPLOYHOZ (Railway/Render/Fly.io kompatibilis):
  - A portot mostantól a process.env.PORT-ból vesszük (host adja meg).
  - Keepalive ping/pong a stabil kapcsolatért (olcsó free tier-eken is).
  - Health endpoint: GET /health -> "OK"

  Indítás lokálisan:  npm i && npm start
  Kapcsolódás:        ws://localhost:8080  vagy élesben wss://<host>
*/

const http = require('http');
const WebSocket = require('ws');

const MAX_PEERS = 2;                  // max 2 kliens / szoba
const rooms = new Map();              // roomName -> Set<WebSocket>

// --- HTTP szerver (health + alap válasz) ---
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Signaling running\n');
});

// --- WebSocket szerver a fenti HTTP szerverhez kötve ---
const wss = new WebSocket.Server({ server });

// Üzenet küldése egy szoba összes kliensének (kivéve a feladót)
function broadcast(room, sender, msg) {
  const set = rooms.get(room) || new Set();
  set.forEach(ws => {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// Keepalive: ping/pong a halott kapcsolatok zárására (free tier barát)
function noop() {}
function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  // meta adatok a klienshez (szoba, név)
  ws.meta = { room: null, name: null };

  // bejövő üzenetek feldolgozása
  ws.on('message', raw => {
    let data;
    try {
      data = JSON.parse(raw); // JSON üzenetek elvártak
    } catch (e) {
      console.error('! Bad JSON:', raw);
      return;
    }
    const { type } = data;
    // életjel a klienstől → válasz pong
    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return; // NE menjen tovább az UNKNOWN logolásig
    }
    // szobához csatlakozás
    if (type === 'join') {
      const room = data.room;
      const name = data.name || 'peer';
      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);

      // max 2 kliens / szoba
      if (set.size >= MAX_PEERS) {
        console.log(`[REJECT] room=${room} name=${name} (full)`);
        ws.send(JSON.stringify({ type: 'room-full', room }));
        ws.close(1008, 'Room full'); // 1008 = policy violation
        return;
      }

      // sikeres csatlakozás
      ws.meta.room = room;
      ws.meta.name = name;
      set.add(ws);
      console.log(`[JOIN] room=${room} name=${name} peers=${set.size}`);

      // szoba többi tagjának jelzés
      broadcast(room, ws, JSON.stringify({ type: 'peer-joined', name }));
      return;
    }

    // csak akkor engedünk további üzeneteket, ha a kliens csatlakozott szobához
    if (!ws.meta.room) return;

    // WebRTC jelzés típusok: offer, answer, ice
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      console.log(`[${type.toUpperCase()}] from=${ws.meta.name} room=${ws.meta.room}`);
      broadcast(ws.meta.room, ws, JSON.stringify(data));
      return;
    }

    // ismeretlen üzenettípus
    console.log('[UNKNOWN]', data);
  });

  // kapcsolat lezárása esetén
  ws.on('close', () => {
    const r = ws.meta.room;
    if (r && rooms.has(r)) {
      const set = rooms.get(r);
      set.delete(ws);
      // ÚJ: szóljunk a bent maradt peer(ek)nek, hogy ez a kliens lelépett
      set.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'peer-left', name: ws.meta.name }));
        }
      });
      if (set.size === 0) rooms.delete(r); // üres szoba törlése
      console.log(`[LEAVE] room=${r} name=${ws.meta.name}`);
    }
  });
});

// Keepalive intervallum: 30s
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(noop);
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});

// --- szerver indítása ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server listening on ws://0.0.0.0:${PORT}`);
});
