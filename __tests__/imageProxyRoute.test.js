// __tests__/imageProxyRoute.test.js -- Tests for image proxy SSRF prevention
// Validates allowlist enforcement, path checks, and error handling.

'use strict';

const http = require('http');
const request = require('supertest');
const express = require('express');

// Build a minimal Express app with just the image proxy route
const imageProxy = require('../src/routes/imageProxyRoute');
const app = express();
app.use('/api/image-proxy', imageProxy);

/* ════════════════════════════════════════════════════════════
 *  Missing / Invalid URL
 * ════════════════════════════════════════════════════════════ */
describe('parameter validation', () => {
  test('returns 400 when url parameter is missing', async () => {
    const res = await request(app).get('/api/image-proxy');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url.*required/i);
  });

  test('returns 400 for invalid URL (no protocol)', async () => {
    const res = await request(app).get('/api/image-proxy?url=not-a-url');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('returns 400 for URL with no path extension', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/noext'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an image/i);
  });
});

/* ════════════════════════════════════════════════════════════
 *  SSRF Prevention -- Host Allowlist
 * ════════════════════════════════════════════════════════════ */
describe('SSRF host allowlist', () => {
  test('blocks non-allowlisted external host', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://evil.com/cat.jpg'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test('blocks localhost / 127.0.0.1', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('http://127.0.0.1/secret.jpg'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test('blocks internal IP (169.254.169.254 metadata)', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('http://169.254.169.254/latest/meta-data.jpg'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test('blocks 10.x.x.x private range', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('http://10.0.0.1/image.png'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test('blocks 192.168.x.x private range', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('http://192.168.1.1/photo.jpg'));
    expect(res.status).toBe(403);
  });

  test('blocks file:// protocol via URL parse', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('file:///etc/passwd.jpg'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  test('blocks FTP protocol', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('ftp://en.numista.com/image.jpg'));
    // new URL() will parse it, but hostname still won't match because transport check uses parsed.protocol
    expect([400, 403, 500, 502]).toContain(res.status);
  });

  test('allows en.numista.com', async () => {
    // This will actually try to fetch, but will likely timeout or get error
    // We just need to verify it passes the allowlist check (not 403)
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/catalogue/photos/nonexistent.jpg'));
    expect(res.status).not.toBe(403);
  });

  test('allows www.numista.com', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://www.numista.com/catalogue/photos/fake.png'));
    expect(res.status).not.toBe(403);
  });

  test('blocks subdomain bypass (evil.en.numista.com)', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://evil.en.numista.com/img.jpg'));
    expect(res.status).toBe(403);
  });

  test('blocks host with @ in URL (credential bypass attempt)', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com@evil.com/img.jpg'));
    // URL parser moves en.numista.com to username field, host becomes evil.com
    expect(res.status).toBe(403);
  });
});

/* ════════════════════════════════════════════════════════════
 *  Path Extension Validation
 * ════════════════════════════════════════════════════════════ */
describe('path extension validation', () => {
  test('blocks non-image extensions (.html)', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/page.html'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not an image/i);
  });

  test('blocks .js files', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/script.js'));
    expect(res.status).toBe(400);
  });

  test('blocks .json files', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/data.json'));
    expect(res.status).toBe(400);
  });

  test('accepts .jpg', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.jpg'));
    expect(res.status).not.toBe(400);
  });

  test('accepts .jpeg', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.jpeg'));
    expect(res.status).not.toBe(400);
  });

  test('accepts .png', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.png'));
    expect(res.status).not.toBe(400);
  });

  test('accepts .gif', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.gif'));
    expect(res.status).not.toBe(400);
  });

  test('accepts .webp', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.webp'));
    expect(res.status).not.toBe(400);
  });

  test('accepts .svg', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + encodeURIComponent('https://en.numista.com/photo.svg'));
    expect(res.status).not.toBe(400);
  });
});

/* ════════════════════════════════════════════════════════════
 *  Upstream response handling (mock HTTP server)
 * ════════════════════════════════════════════════════════════ */
describe('upstream response handling', () => {
  let mockServer;
  let mockPort;
  const ALLOWED = imageProxy._allowedHosts;

  beforeAll((done) => {
    mockServer = http.createServer((req, res) => {
      const url = req.url;
      if (url === '/ok.jpg') {
        const body = Buffer.alloc(100, 0xff);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': body.length });
        res.end(body);
      } else if (url === '/not-image.jpg') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>gotcha</html>');
      } else if (url === '/big.jpg') {
        // Stream >2MB
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        const chunk = Buffer.alloc(512 * 1024, 0xab);
        for (let i = 0; i < 6; i++) res.write(chunk); // 3MB
        res.end();
      } else if (url === '/404.jpg') {
        res.writeHead(404);
        res.end();
      } else if (url === '/500.jpg') {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    mockServer.listen(0, '127.0.0.1', () => {
      mockPort = mockServer.address().port;
      ALLOWED.add('127.0.0.1');
      done();
    });
  });

  afterAll((done) => {
    ALLOWED.delete('127.0.0.1');
    mockServer.close(done);
  });

  function mockUrl(path) {
    return encodeURIComponent(`http://127.0.0.1:${mockPort}${path}`);
  }

  test('proxies valid image with correct Content-Type', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + mockUrl('/ok.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toMatch(/public.*max-age=86400/);
    expect(res.body.length).toBe(100);
  });

  test('rejects upstream that returns non-image Content-Type', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + mockUrl('/not-image.jpg'));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/not.*image/i);
  });

  test('truncates response when upstream exceeds 2MB size limit', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + mockUrl('/big.jpg'));
    // Headers already sent as 200 before size exceeded, but body is truncated
    expect(res.status).toBe(200);
    // Body should be smaller than 3MB (the full upstream payload)
    expect(res.body.length).toBeLessThan(3 * 1024 * 1024);
  });

  test('forwards upstream 404 status', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + mockUrl('/404.jpg'));
    expect(res.status).toBe(404);
  });

  test('forwards upstream 500 status', async () => {
    const res = await request(app).get('/api/image-proxy?url=' + mockUrl('/500.jpg'));
    expect(res.status).toBe(500);
  });
});
