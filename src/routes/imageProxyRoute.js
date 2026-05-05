'use strict';

const { Router } = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const router = Router();

// Allowlist of hostnames we'll proxy images from
const ALLOWED_HOSTS = new Set([
  'en.numista.com',
  'www.numista.com',
]);

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB cap

/**
 * GET /api/image-proxy?url=<encoded-url>
 * Proxies images from allowlisted hosts to bypass hotlink protection.
 */
router.get('/', (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ error: 'url parameter required' });

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(403).json({ error: 'host not allowed' });
  }

  // Only allow image-like paths
  if (!/\.(jpe?g|png|gif|webp|svg)$/i.test(parsed.pathname)) {
    return res.status(400).json({ error: 'not an image path' });
  }

  const transport = parsed.protocol === 'https:' ? https : http;

  const proxyReq = transport.get(parsed.href, { timeout: 8000 }, (upstream) => {
    if (upstream.statusCode !== 200) {
      res.status(upstream.statusCode).end();
      upstream.resume();
      return;
    }

    const ct = upstream.headers['content-type'] || '';
    if (!ct.startsWith('image/')) {
      res.status(502).json({ error: 'upstream did not return an image' });
      upstream.resume();
      return;
    }

    // Reject before streaming if Content-Length exceeds cap
    const contentLength = parseInt(upstream.headers['content-length'], 10);
    if (contentLength > MAX_SIZE) {
      res.status(413).json({ error: 'Image too large' });
      upstream.destroy();
      return;
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    let received = 0;
    upstream.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_SIZE) {
        upstream.destroy();
        // Headers already sent (200) -- terminate the response.
        res.end();
        return;
      }
      res.write(chunk);
    });
    upstream.on('end', () => res.end());
    upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
  });

  proxyReq.on('error', () => { if (!res.headersSent) res.status(502).end(); });
  proxyReq.on('timeout', () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).end(); });
});

module.exports = router;
module.exports._allowedHosts = ALLOWED_HOSTS;
