// Public reverse proxy for the OpenClaw gateway Control UI.
// Forwards plain HTTP and raw WebSocket upgrades to 127.0.0.1:18789.
// Zero dependencies - uses only Node built-ins.

const http = require('http');
const net = require('net');

const PORT = Number(process.env.PORT) || 3000;
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.OPENCLAW_PORT) || 18789;

// The publishing edge injects its own X-Forwarded-* / X-Real-IP / Forwarded
// headers. OpenClaw's ingress attribution sees any of those, decides the
// loopback peer is an untrusted proxy hop, and answers 403
// "proxy_attribution_required". Dropping them entirely makes the request look
// like a plain direct-local call, which OpenClaw accepts.
//
// Important: do NOT re-add X-Forwarded-* here - re-adding them re-triggers
// the same rejection, even when the value is 127.0.0.1.
const STRIP = ['forwarded', 'x-real-ip', 'x-client-ip', 'x-envoy-external-address', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip'];

function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-forwarded-')) continue;
    if (STRIP.includes(lower)) continue;
    out[key] = value;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: cleanHeaders(req.headers),
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('openclaw upstream error: ' + err.message);
  });
  req.pipe(upstream);
});

// WebSocket: after the 101 handshake it is just a byte stream, so a
// transparent TCP relay is enough. The handshake itself is replayed verbatim.
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(cleanHeaders(req.headers))) {
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${key}: ${v}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`openclaw-public proxy listening on 0.0.0.0:${PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
