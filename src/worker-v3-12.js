import baseWorker from './worker-v3-11.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_COOKIE_TTL = 60 * 60 * 24 * 30;
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    ...headers
  }
});

const parseCookies = (request) => {
  const header = request.headers.get('cookie') || '';
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
    })
  );
};

const base64UrlEncode = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const deriveAesKey = async (secret) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`ARSTORE_SHOPEE_TOKEN_V1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const encryptObject = async (value, secret) => {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return base64UrlEncode(combined);
};

const decryptObject = async (value, secret) => {
  if (!value || !secret) return null;
  try {
    const combined = base64UrlDecode(value);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await deriveAesKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(decoder.decode(plaintext));
  } catch (_) {
    return null;
  }
};

const importHmacKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const hmacHex = async (secret, value) => {
  const key = await importHmacKey(secret);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const getShopeeBase = (env) => (env.SHOPEE_API_BASE || SHOPEE_DEFAULT_BASE).replace(/\/$/, '');
const shopeeCookie = (token) => `${SHOPEE_COOKIE}=${token}; Path=/api/shopee; HttpOnly; Secure; SameSite=Lax; Max-Age=${SHOPEE_COOKIE_TTL}`;

const parseShopeeError = (data, fallback = 'Shopee request failed') =>
  data?.message || data?.error || data?.debug_message || fallback;

const buildPublicEndpoint = async (path, env) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(env.SHOPEE_PARTNER_KEY, `${env.SHOPEE_PARTNER_ID}${path}${timestamp}`);
  const endpoint = new URL(`${getShopeeBase(env)}${path}`);
  endpoint.searchParams.set('partner_id', env.SHOPEE_PARTNER_ID);
  endpoint.searchParams.set('timestamp', String(timestamp));
  endpoint.searchParams.set('sign', sign);
  return endpoint;
};

const buildShopEndpoint = async (path, token, env) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${env.SHOPEE_PARTNER_ID}${path}${timestamp}${token.access_token}${token.shop_id}`;
  const sign = await hmacHex(env.SHOPEE_PARTNER_KEY, baseString);
  const endpoint = new URL(`${getShopeeBase(env)}${path}`);
  endpoint.searchParams.set('partner_id', env.SHOPEE_PARTNER_ID);
  endpoint.searchParams.set('timestamp', String(timestamp));
  endpoint.searchParams.set('access_token', token.access_token);
  endpoint.searchParams.set('shop_id', String(token.shop_id));
  endpoint.searchParams.set('sign', sign);
  return endpoint;
};

const shopInfoProbe = async (token, env) => {
  try {
    const endpoint = await buildShopEndpoint('/api/v2/shop/get_shop_info', token, env);
    const response = await fetch(endpoint.toString(), { headers: { accept: 'application/json' } });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    return {
      ok: response.ok && !data?.error,
      status: response.status,
      data,
      message: parseShopeeError(data, 'Shopee token probe failed')
    };
  } catch (_) {
    return { ok: false, status: 502, data: null, message: 'Shopee API unreachable' };
  }
};

const refreshShopeeToken = async (token, env) => {
  if (!token?.refresh_token || !token?.shop_id) {
    return { ok: false, message: 'Shopee refresh token is missing. Reconnect Shopee.' };
  }
  try {
    const path = '/api/v2/auth/access_token/get';
    const endpoint = await buildPublicEndpoint(path, env);
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        refresh_token: token.refresh_token,
        shop_id: Number(token.shop_id),
        partner_id: Number(env.SHOPEE_PARTNER_ID)
      })
    });
    const data = await response.json();
    if (!response.ok || data?.error || !data?.access_token) {
      return { ok: false, message: parseShopeeError(data, 'Shopee token refresh failed') };
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      token: {
        ...token,
        access_token: data.access_token,
        refresh_token: data.refresh_token || token.refresh_token,
        expire_in: Number(data.expire_in || token.expire_in || 0),
        expires_at: Number(data.expire_in || 0) ? now + Number(data.expire_in) : null,
        refreshed_at: now
      }
    };
  } catch (_) {
    return { ok: false, message: 'Shopee token refresh unreachable' };
  }
};

const looksLikeTokenError = (message = '') => /access[_\s-]*token|invalid token|token.*invalid|token.*expired/i.test(String(message));

const handleTokenHealth = async (request, env) => {
  const sessionUrl = new URL('/api/auth/session', request.url);
  const sessionResponse = await baseWorker.fetch(new Request(sessionUrl.toString(), {
    method: 'GET',
    headers: request.headers
  }), env);
  if (!sessionResponse.ok) return json({ error: 'unauthorized' }, 401);

  if (!env.SESSION_SECRET || !env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const encrypted = parseCookies(request)[SHOPEE_COOKIE];
  const token = await decryptObject(encrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) {
    return json({ error: 'shopee_not_connected', reconnectRequired: true }, 401);
  }

  const probe = await shopInfoProbe(token, env);
  if (probe.ok) {
    return json({ ok: true, healthy: true, refreshed: false, shopId: String(token.shop_id) });
  }

  if (!looksLikeTokenError(probe.message)) {
    return json({ error: 'shopee_probe_failed', message: probe.message }, 502);
  }

  const refreshed = await refreshShopeeToken(token, env);
  if (!refreshed.ok) {
    return json({
      error: 'shopee_reconnect_required',
      message: refreshed.message || 'Shopee authorization must be renewed.',
      reconnectRequired: true
    }, 401);
  }

  const retry = await shopInfoProbe(refreshed.token, env);
  if (!retry.ok) {
    return json({
      error: 'shopee_reconnect_required',
      message: retry.message || 'Shopee rejected the refreshed token.',
      reconnectRequired: true
    }, 401);
  }

  const nextEncrypted = await encryptObject(refreshed.token, env.SESSION_SECRET);
  return json({
    ok: true,
    healthy: true,
    refreshed: true,
    shopId: String(refreshed.token.shop_id)
  }, 200, { 'set-cookie': shopeeCookie(nextEncrypted) });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/token-health' && request.method === 'GET') {
      return handleTokenHealth(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};