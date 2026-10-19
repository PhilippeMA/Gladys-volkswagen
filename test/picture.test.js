import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPublicImage } from '../src/picture.js';

const answer = (status, { location, body = '' } = {}) =>
  new Response(status >= 300 && status < 400 ? null : body, {
    status,
    headers: location ? { location } : {},
  });

test('downloads the image, following https redirects, with no cookie', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return url.endsWith('/short')
      ? answer(302, { location: 'https://cdn.example.com/car.png' })
      : answer(200, { body: Buffer.from('PNG') });
  };
  const body = await downloadPublicImage('https://example.com/short', { fetch });
  assert.equal(body.toString(), 'PNG');
  assert.deepEqual(
    seen.map((r) => r.url),
    ['https://example.com/short', 'https://cdn.example.com/car.png'],
  );
  assert.ok(seen.every((r) => !('cookie' in r.headers) && !('authorization' in r.headers)));
});

test('refuses plain http, also behind a redirect, and failed answers', async () => {
  await assert.rejects(downloadPublicImage('http://example.com/car.png'), /https/);
  const redirectToHttp = async () => answer(301, { location: 'http://example.com/car.png' });
  await assert.rejects(
    downloadPublicImage('https://example.com/car.png', { fetch: redirectToHttp }),
    /https/,
  );
  const notFound = async () => answer(404);
  await assert.rejects(
    downloadPublicImage('https://example.com/car.png', { fetch: notFound }),
    /HTTP 404/,
  );
  const loop = async (url) => answer(302, { location: url });
  await assert.rejects(downloadPublicImage('https://example.com/a', { fetch: loop }), /redirects/);
});
