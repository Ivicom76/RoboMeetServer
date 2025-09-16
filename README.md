# WebRTC Signaling Server (Node.js + ws)

Egyszerű WebSocket alapú signaling szerver (szobánként max. 2 peer).
Railway/Render/Fly.io kompatibilis: a portot a `PORT` env változóból veszi.

## Használat

```bash
npm install
npm start
# lokál végpont: ws://localhost:8080  (health: http://localhost:8080/health)
```

## Deploy Railway-re (gyors)

1. Új GitHub repo -> töltsd fel ezt a mappát.
2. Railway -> New Project -> Deploy from GitHub.
3. Első indulás után kapsz egy publikus URL-t: `https://<app>.up.railway.app`
4. WebSocket kliensből használj **wss**-t:
   ```js
   const ws = new WebSocket('wss://<app>.up.railway.app');
   ws.onopen = () => ws.send(JSON.stringify({type:'join', room:'demo-001', name:'webclient'}));
   ws.onmessage = (e) => console.log('msg:', e.data);
   ```

> Megjegyzés: böngészőből, ha HTTPS oldalról kapcsolódsz, kötelező a `wss://` (nem `ws://`).

## Üzenetformátumok

- `{"type":"join","room":"demo-001","name":"alice"}`
- `{"type":"offer","sdp":{...}}`
- `{"type":"answer","sdp":{...}}`
- `{"type":"ice","candidate":{...}}`

A szerver csak továbbítja a jelzést a szobán belüli másik peernek.
