import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const PORT = Number(process.env.PORT || 3000);
const RELAY_VERSION = '1.3.2';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 90_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const EGRESS_IP_TIMEOUT_MS = 10_000;
const EGRESS_IP_CACHE_TTL_MS = 5 * 60_000;
const EGRESS_IP_CHECK_URL = 'https://api.ipify.org?format=json';
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const FORWARDED_HEADERS = new Set(['accept', 'content-type']);
const STATIC_PROXY_PROVIDERS = new Set(['node4', 'noble']);
const SAFE_FORWARD_REASONS = new Set([
  'target_url_invalid',
  'target_protocol_not_allowed',
  'target_host_not_allowed',
  'target_credentials_not_allowed',
  'target_port_not_allowed',
  'method_not_allowed',
  'static_proxy_provider_invalid',
  'static_proxy_url_invalid',
  'static_proxy_protocol_invalid',
  'static_proxy_provider_mismatch',
  'static_proxy_host_invalid',
  'static_proxy_provider_required_for_ip',
  'static_proxy_credentials_missing',
  'static_proxy_port_invalid'
]);

let staticDispatcher = null;
let staticDispatcherKey = null;
let egressIpCache = null;

const safeErrorDiagnostic = (error) => ({
  name: String(error?.name || 'Error').slice(0, 80),
  code: error?.code ? String(error.code).slice(0, 120) : null,
  causeCode: error?.cause?.code ? String(error.cause.code).slice(0, 120) : null
});

const safeForwardReason = (error) => {
  const reason = String(error?.message || '');
  return SAFE_FORWARD_REASONS.has(reason) ? reason : null;
};

const logEvent = (event, fields = {}) => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    service: 'arstore-shopee-egress-relay',
    version: RELAY_VERSION,
    event,
    ...fields
  }));
};

const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-arstore-egress-relay': RELAY_VERSION,
    ...extraHeaders
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

const staticProxyProvider = (hostname) => {
  const host = String(hostname || '').toLowerCase();
  if (host === 'noble-ip.com' || host.endsWith('.noble-ip.com')) return 'noble';
  if (host === 'node4.io' || host.endsWith('.node4.io')) return 'node4';
  return null;
};

const configuredStaticProxyProvider = () => {
  const provider = String(process.env.STATIC_PROXY_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;
  if (!STATIC_PROXY_PROVIDERS.has(provider)) throw new Error('static_proxy_provider_invalid');
  return provider;
};

const getConfiguredStaticProxyUrl = () => String(
  process.env.STATIC_PROXY_URL || process.env.NOBLE_PROXY_URL || ''
).trim();

const validateStaticProxyUrl = (value) => {
  if (!value) return null;
  let proxy;
  try {
    proxy = new URL(String(value));
  } catch {
    throw new Error('static_proxy_url_invalid');
  }

  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error('static_proxy_protocol_invalid');
  }

  const hostProvider = staticProxyProvider(proxy.hostname);
  const providerHint = configuredStaticProxyProvider();
  const isIpEndpoint = net.isIP(proxy.hostname) !== 0;

  if (hostProvider && providerHint && hostProvider !== providerHint) {
    throw new Error('static_proxy_provider_mismatch');
  }

  const provider = hostProvider || (isIpEndpoint ? providerHint : null);
  if (!provider) throw new Error('static_proxy_host_invalid');
  if (isIpEndpoint && !providerHint) throw new Error('static_proxy_provider_required_for_ip');
  if (!proxy.username || !proxy.password) throw new Error('static_proxy_credentials_missing');

  const port = proxy.port ? Number(proxy.port) : null;
  if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('static_proxy_port_invalid');
  }

  return { url: proxy.toString(), provider, endpointType: isIpEndpoint ? 'ip' : 'hostname' };
};

const getStaticDispatcher = () => {
  const validated = validateStaticProxyUrl(getConfiguredStaticProxyUrl());
  if (!validated) return { dispatcher: null, provider: null, endpointType: null };

  if (!staticDispatcher || staticDispatcherKey !== validated.url) {
    staticDispatcher = new ProxyAgent(validated.url);
    staticDispatcherKey = validated.url;
    egressIpCache = null;
  }

  return {
    dispatcher: staticDispatcher,
    provider: validated.provider,
    endpointType: validated.endpointType
  };
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

const forwardShopeeRequest = async (payload, requestId) => {
  let target;
  try {
    target = new URL(String(payload?.url || ''));
  } catch {
    throw new Error('target_url_invalid');
  }

  if (target.protocol !== 'https:') throw new Error('target_protocol_not_allowed');
  if (!isShopeeHostAllowed(target.hostname)) throw new Error('target_host_not_allowed');
  if (target.username || target.password) throw new Error('target_credentials_not_allowed');
  if (target.port && target.port !== '443') throw new Error('target_port_not_allowed');

  const method = String(payload?.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) throw new Error('method_not_allowed');

  const headers = sanitizeForwardHeaders(payload?.headers);
  const body = method === 'GET' ? undefined : String(payload?.body ?? '');
  const { dispatcher, provider, endpointType } = getStaticDispatcher();

  logEvent('forward_upstream_start', {
    requestId,
    method,
    targetHost: target.hostname,
    targetPath: target.pathname,
    proxyConfigured: Boolean(dispatcher),
    proxyProvider: provider,
    proxyEndpointType: endpointType
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await undiciFetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    });

    logEvent('forward_upstream_response', {
      requestId,
      status: response.status,
      contentType: String(response.headers.get('content-type') || '').slice(0, 120)
    });
    return response;
  } catch (error) {
    logEvent('forward_upstream_error', {
      requestId,
      ...safeErrorDiagnostic(error)
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const resolveStaticEgressIp = async () => {
  const { dispatcher, provider, endpointType } = getStaticDispatcher();
  if (!dispatcher) throw new Error('static_proxy_not_configured');

  const now = Date.now();
  if (egressIpCache && (now - egressIpCache.checkedAtMs) < EGRESS_IP_CACHE_TTL_MS) {
    return { ...egressIpCache, cached: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EGRESS_IP_TIMEOUT_MS);

  try {
    const response = await undiciFetch(EGRESS_IP_CHECK_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      dispatcher,
      redirect: 'error',
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`egress_ip_http_${response.status}`);

    const payload = await response.json();
    const ip = String(payload?.ip || '').trim();
    if (net.isIP(ip) !== 4) throw new Error('egress_ip_not_ipv4');

    egressIpCache = {
      ip,
      provider,
      endpointType,
      checkedAt: new Date(now).toISOString(),
      checkedAtMs: now
    };

    return { ...egressIpCache, cached: false };
  } finally {
    clearTimeout(timeout);
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const configuredUrl = getConfiguredStaticProxyUrl();
    const staticEgressConfigured = Boolean(configuredUrl);
    let staticEgressValid = false;
    let staticEgressProvider = null;
    let staticEgressEndpointType = null;

    try {
      const validated = staticEgressConfigured ? validateStaticProxyUrl(configuredUrl) : null;
      staticEgressValid = Boolean(validated);
      staticEgressProvider = validated?.provider || null;
      staticEgressEndpointType = validated?.endpointType || null;
    } catch {
      staticEgressValid = false;
      staticEgressProvider = null;
      staticEgressEndpointType = null;
    }

    return json(res, 200, {
      ok: true,
      service: 'arstore-shopee-egress-relay',
      configured: Boolean(process.env.EGRESS_SHARED_SECRET),
      staticEgressConfigured,
      staticEgressValid,
      staticEgressProvider,
      staticEgressEndpointType,
      egressMode: staticEgressValid ? 'static-proxy' : 'direct',
      version: RELAY_VERSION
    });
  }

  if (req.method === 'GET' && url.pathname === '/egress-ip') {
    try {
      const result = await resolveStaticEgressIp();
      return json(res, 200, {
        ok: true,
        viaStaticProxy: true,
        provider: result.provider,
        endpointType: result.endpointType,
        ip: result.ip,
        checkedAt: result.checkedAt,
        cached: result.cached
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'egress_ip_timeout' : (error?.message || 'egress_ip_check_failed');
      return json(res, reason === 'egress_ip_timeout' ? 504 : 502, {
        ok: false,
        error: reason,
        diagnostic: safeErrorDiagnostic(error)
      });
    }
  }

  if (req.method !== 'POST' || url.pathname !== '/v1/forward') {
    return json(res, 404, { error: 'not_found' });
  }

  const requestId = crypto.randomUUID().slice(0, 12);
  logEvent('forward_received', { requestId });

  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    logEvent('forward_body_error', { requestId, ...safeErrorDiagnostic(error) });
    return json(res, error?.message === 'payload_too_large' ? 413 : 400, {
      error: error?.message || 'invalid_request',
      requestId
    }, { 'x-arstore-egress-request-id': requestId });
  }

  const verified = verifyRelaySignature(
    rawBody,
    req.headers['x-arstore-egress-timestamp'],
    req.headers['x-arstore-egress-signature']
  );

  if (!verified.ok) {
    logEvent('forward_auth_rejected', { requestId, reason: verified.reason });
    return json(res, 401, { error: verified.reason, requestId }, {
      'x-arstore-egress-request-id': requestId
    });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logEvent('forward_json_rejected', { requestId });
    return json(res, 400, { error: 'invalid_json', requestId }, {
      'x-arstore-egress-request-id': requestId
    });
  }

  try {
    const upstream = await forwardShopeeRequest(payload, requestId);
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'x-arstore-egress-relay': RELAY_VERSION,
      'x-arstore-egress-request-id': requestId
    });
    return res.end(body);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_fetch_failed';
    const diagnostic = safeErrorDiagnostic(error);
    const internalReason = safeForwardReason(error);
    logEvent('forward_failed', { requestId, reason, internalReason, ...diagnostic });
    return json(res, reason === 'upstream_timeout' ? 504 : 502, {
      error: reason,
      stage: 'relay_to_upstream',
      requestId,
      diagnostic: {
        ...diagnostic,
        internalReason
      }
    }, {
      'x-arstore-egress-request-id': requestId
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  logEvent('relay_listening', { port: PORT });
});
