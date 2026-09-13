import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 90_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const FORWARDED_HEADERS = new Set(['accept', 'content-type']);

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(new Error('payload_too_large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const isShopeeHostAllowed = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;

  const configured = String(process.env.ALLOWED_SHOPEE_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (configured.length) return configured.includes(host);

  return host === 'shopeemobile.com' || host.endsWith('.shopeemobile.com');
};

const safeSignatureEqual = (providedHex, expectedHex) => {
  try {
    const provided = Buffer.from(String(providedHex || ''), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
};

const verifyRelaySignature = (rawBody, timestampHeader, signatureHeader) => {
  const secret = process.env.EGRESS_SHARED_SECRET;
  if (!secret) return { ok: false, reason: 'relay_not_configured' };

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'stale_request' };
  }

  const signed = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (!safeSignatureEqual(signatureHeader, expected)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true };
};

const sanitizeForwardHeaders = (headers = {}) => {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = String(key).toLowerCase();
    if (!FORWARDED_HEADERS.has(normalized)) continue;
    if (typeof value !== 'string') continue;
    output[normalized] = value.slice(0, 512);
  }
  return output;
};

const forwardShopeeRequest = async (payload) => {
  const target = new URL(String(payload?.url || ''));
  if (target.protocol !== 'https:') throw new Error('target_protocol_not_allowed');
  if (!isShopeeHostAllowed(target.hostname)) throw new Error('target_host_not_allowed');
  if (target.username || target.password) throw new Error('target_credentials_not_allowed');
  if (target.port && target.port !== '443') throw new Error('target_port_not_allowed');

  const method = String(payload?.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error('method_not_allowed');

  const headers = sanitizeForwardHeaders(payload?.headers);
  const body = method === 'GET' ? undefined : String(payload?.body ?? '');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'arstore-shopee-egress-relay',
      configured: Boolean(process.env.EGRESS_SHARED_SECRET),
      version: '1.0.0'
    });
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/forward') {
    return json(res, 404, { error: 'not_found' });
  }

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    return json(res, error?.message === 'payload_too_large' ? 413 : 400, {
      error: error?.message || 'invalid_request'
    });
  }

  const verified = verifyRelaySignature(
    rawBody,
    req.headers['x-arstore-egress-timestamp'],
    req.headers['x-arstore-egress-signature']
  );

  if (!verified.ok) return json(res, 401, { error: verified.reason });

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return json(res, 400, { error: 'invalid_json' });
  }

  try {
    const upstream = await forwardShopeeRequest(payload);
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'x-arstore-egress-relay': 'v1'
    });
    return res.end(body);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'upstream_timeout' : (error?.message || 'upstream_failed');
    return json(res, reason === 'upstream_timeout' ? 504 : 502, { error: reason });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AR STORE Shopee egress relay listening on :${PORT}`);
});
