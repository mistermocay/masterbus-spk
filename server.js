const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createSpk, deleteSpk, getSpk, getSpkDrawing, listSpk } = require('./database');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const allowedClientIps = new Set(
  (process.env.ALLOWED_CLIENT_IPS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);
const maxRequestBytes = 3 * 1024 * 1024;
const indexPath = path.join(__dirname, 'index.html');

for (const ip of allowedClientIps) {
  if (net.isIP(ip) === 0) throw new Error(`ALLOWED_CLIENT_IPS berisi alamat IP tidak valid: ${ip}`);
}

function isLoopbackHost(value) {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

if (!isLoopbackHost(host) && allowedClientIps.size === 0) {
  throw new Error('HOST non-lokal membutuhkan ALLOWED_CLIENT_IPS yang berisi IP VPN/kantor.');
}

function requestIp(request) {
  return (request.socket.remoteAddress || '').replace(/^::ffff:/, '').toLowerCase();
}

function isAllowedClient(request) {
  const ip = requestIp(request);
  return ip === '127.0.0.1' || ip === '::1' || allowedClientIps.has(ip);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maxRequestBytes) {
        const error = new Error('Ukuran permintaan terlalu besar.');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Isi permintaan bukan JSON yang valid.');
        error.statusCode = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function handleRequest(request, response) {
  if (!isAllowedClient(request)) return sendJson(response, 403, { error: 'Akses hanya diizinkan dari jaringan yang terdaftar.' });

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = await fs.readFile(indexPath);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    });
    return response.end(html);
  }
  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === 'GET' && pathname === '/api/spk') {
    return sendJson(response, 200, await listSpk());
  }
  if (request.method === 'POST' && pathname === '/api/spk') {
    if (!request.headers['content-type']?.startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Content-Type harus application/json.' });
    }
    return sendJson(response, 201, await createSpk(await readJson(request)));
  }

  const match = pathname.match(/^\/api\/spk\/([A-Za-z0-9_-]+)(\/drawing)?$/);
  if (match) {
    const [, id, drawingRoute] = match;
    if (request.method === 'GET' && drawingRoute) {
      const drawing = await getSpkDrawing(id);
      response.writeHead(200, {
        'Content-Type': drawing.contentType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(drawing.buffer);
    }
    if (request.method === 'GET' && !drawingRoute) {
      const record = await getSpk(id);
      return record ? sendJson(response, 200, record) : sendJson(response, 404, { error: 'SPK tidak ditemukan.' });
    }
    if (request.method === 'DELETE' && !drawingRoute) {
      const removed = await deleteSpk(id);
      return removed ? sendJson(response, 200, { ok: true }) : sendJson(response, 404, { error: 'SPK tidak ditemukan.' });
    }
  }

  return sendJson(response, 404, { error: 'Endpoint tidak ditemukan.' });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    console.error('Permintaan API gagal.', error);
    if (!response.headersSent) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      sendJson(response, statusCode, {
        error: statusCode >= 500 ? 'Terjadi kesalahan pada server.' : error.message
      });
    } else {
      response.destroy(error);
    }
  });
});

server.listen(port, host, () => {
  console.log(`Master SPK berjalan di http://${host}:${port}`);
});

server.on('error', error => {
  console.error('Server Master SPK gagal dijalankan.', error);
  process.exitCode = 1;
});
