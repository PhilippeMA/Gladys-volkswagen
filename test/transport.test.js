import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { httpsFetch } from '../src/vw/transport.js';

// A local server that echoes what it received.
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('sends exactly the given headers, nothing fetch-specific', async () => {
  let received;
  await withServer(
    (req, res) => {
      received = req.headers;
      res.end('ok');
    },
    async (base) => {
      await httpsFetch(`${base}/x`, { headers: { 'user-agent': 'Volkswagen/3.51.1-android/14' } });
    },
  );
  assert.equal(received['user-agent'], 'Volkswagen/3.51.1-android/14');
  assert.equal(received['sec-fetch-mode'], undefined);
  assert.equal(received['accept-language'], undefined);
});

test('never follows redirects, keeps every Set-Cookie and decodes gzip', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/elsewhere', 'set-cookie': ['a=1', 'b=2'] });
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' });
        res.end(zlib.gzipSync(JSON.stringify({ method: req.method, body })));
      });
    },
    async (base) => {
      const redirect = await httpsFetch(`${base}/redirect`);
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/elsewhere');
      assert.deepEqual(redirect.headers.getSetCookie(), ['a=1', 'b=2']);

      const posted = await httpsFetch(`${base}/echo`, { method: 'POST', body: '{"x":1}' });
      assert.deepEqual(await posted.json(), { method: 'POST', body: '{"x":1}' });
    },
  );
});
