import baseWorker from './worker-v3-11.js';
import { shopeeFetch } from './shopee-egress.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const OAUTH_COOKIE = 'arstore_oauth';
const SHOPEE_COOKIE_TTL = 60 * 60 * 24 * 30;
const TOKEN_REFRESH_WINDOW = 15 * 60;
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
const clearOauthCookie = () => `${OAUTH_COOKIE}=; Path=/shopee/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

const parseShopeeError = (data, fallback = 'Shopee request failed') =>
  data?.message || data?.error || data?.debug_message || fallback;

const maskPartnerId = (value) => {
  const text = String(value || '');
  if (!text) return 'Not configured';
  if (text.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(text.length - 4, 8))}${text.slice(-4)}`;
};

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

const sessionIsValid = async (request, env) => {
  const sessionUrl = new URL('/api/auth/session', request.url);
  const response = await baseWorker.fetch(new Request(sessionUrl.toString(), {
    method: 'GET',
    headers: request.headers
  }), env);
  return response.ok;
};

const shopInfoProbe = async (token, env) => {
  try {
    const endpoint = await buildShopEndpoint('/api/v2/shop/get_shop_info', token, env);
    const response = await shopeeFetch(env, endpoint.toString(), { headers: { accept: 'application/json' } });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    const contentType = String(response.headers.get('content-type') || '').slice(0, 160);
    const relayVersion = String(response.headers.get('x-arstore-egress-relay') || '').slice(0, 80) || null;
    return {
      ok: response.ok && !data?.error,
      status: response.status,
      data,
      message: parseShopeeError(data, 'Shopee token probe failed'),
      diagnostic: {
        stage: 'shopee_upstream_response',
        upstreamStatus: response.status,
        responseFormat: data ? 'json' : 'non-json',
        contentType: contentType || null,
        relayVersion
      }
    };
  } catch (_) {
    return {
      ok: false,
      status: 502,
      data: null,
      message: 'Shopee API unreachable',
      diagnostic: {
        stage: 'worker_to_relay_fetch_exception',
        upstreamStatus: null,
        responseFormat: null,
        contentType: null,
        relayVersion: null
      }
    };
  }
};

const refreshShopeeToken = async (token, env) => {
  if (!token?.refresh_token || !token?.shop_id) {
    return { ok: false, error: 'refresh_token_missing', message: 'Shopee refresh token is missing. Reconnect Shopee.' };
  }
  try {
    const path = '/api/v2/auth/access_token/get';
    const endpoint = await buildPublicEndpoint(path, env);
    const response = await shopeeFetch(env, endpoint.toString(), {
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
      return { ok: false, error: 'refresh_failed', message: parseShopeeError(data, 'Shopee token refresh failed') };
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
    return { ok: false, error: 'refresh_unreachable', message: 'Shopee token refresh unreachable' };
  }
};

const getFreshToken = async (request, env, minValidity = TOKEN_REFRESH_WINDOW) => {
  const encrypted = parseCookies(request)[SHOPEE_COOKIE];
  const token = await decryptObject(encrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) return { ok: false, error: 'shopee_not_connected', token: null };

  const now = Math.floor(Date.now() / 1000);
  const remaining = token.expires_at ? token.expires_at - now : Number.MAX_SAFE_INTEGER;
  if (remaining > minValidity) return { ok: true, token, refreshed: false, setCookie: null };

  const refreshed = await refreshShopeeToken(token, env);
  if (!refreshed.ok) return { ...refreshed, token };
  const nextEncrypted = await encryptObject(refreshed.token, env.SESSION_SECRET);
  return {
    ok: true,
    token: refreshed.token,
    refreshed: true,
    setCookie: shopeeCookie(nextEncrypted)
  };
};

const looksLikeTokenError = (message = '') => /access[_\s-]*token|invalid token|token.*invalid|token.*expired/i.test(String(message));

const handleShopeeStatus = async (request, env) => {
  if (!(await sessionIsValid(request, env))) return json({ error: 'unauthorized' }, 401);

  const configured = Boolean(env.SHOPEE_PARTNER_ID && env.SHOPEE_PARTNER_KEY);
  const callbackUrl = env.SHOPEE_REDIRECT_URL || `${new URL(request.url).origin}/shopee/callback`;
  if (!configured || !env.SESSION_SECRET) {
    return json({
      configured,
      connected: false,
      partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID),
      shopId: null,
      tokenExpiresAt: null,
      callbackUrl,
      storage: 'not connected'
    });
  }

  const fresh = await getFreshToken(request, env);
  if (!fresh.ok) {
    const token = fresh.token || await decryptObject(parseCookies(request)[SHOPEE_COOKIE], env.SESSION_SECRET);
    return json({
      configured: true,
      connected: Boolean(token?.access_token && token?.shop_id),
      partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID),
      shopId: token?.shop_id ? String(token.shop_id) : null,
      tokenExpiresAt: token?.expires_at || null,
      callbackUrl,
      storage: token ? 'encrypted HttpOnly cookie' : 'not connected',
      refreshError: fresh.error || null
    });
  }

  return json({
    configured: true,
    connected: true,
    partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID),
    shopId: String(fresh.token.shop_id),
    tokenExpiresAt: fresh.token.expires_at || null,
    tokenRefreshed: fresh.refreshed,
    callbackUrl,
    storage: 'encrypted HttpOnly cookie'
  }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const handleShopInfo = async (request, env) => {
  if (!(await sessionIsValid(request, env))) return json({ error: 'unauthorized' }, 401);
  if (!env.SESSION_SECRET || !env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const fresh = await getFreshToken(request, env);
  if (!fresh.ok) {
    return json({
      error: fresh.error || 'shopee_token_refresh_failed',
      message: fresh.message || null
    }, fresh.error === 'shopee_not_connected' ? 401 : 502);
  }

  const result = await shopInfoProbe(fresh.token, env);
  if (!result.ok) {
    return json({ error: 'shopee_api_error', message: result.message, diagnostic: result.diagnostic || null }, 502,
      fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
  }

  return json({
    ok: true,
    shop: result.data?.response || result.data,
    tokenRefreshed: fresh.refreshed
  }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const handleShopeeCallback = async (request, env) => {
  const requestUrl = new URL(request.url);
  if (!(await sessionIsValid(request, env))) {
    const login = new URL('/seller-login/', requestUrl.origin);
    login.searchParams.set('next', '/dashboard/');
    return Response.redirect(login.toString(), 302);
  }
  if (!env.SESSION_SECRET || !env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY) {
    const destination = new URL('/dashboard/', requestUrl.origin);
    destination.searchParams.set('shopee', 'error');
    destination.searchParams.set('reason', 'configuration');
    destination.hash = 'connection';
    return Response.redirect(destination.toString(), 302);
  }
  if (!parseCookies(request)[OAUTH_COOKIE]) {
    const destination = new URL('/dashboard/', requestUrl.origin);
    destination.searchParams.set('shopee', 'error');
    destination.searchParams.set('reason', 'oauth_session');
    destination.hash = 'connection';
    return Response.redirect(destination.toString(), 302);
  }

  const code = requestUrl.searchParams.get('code');
  const shopId = requestUrl.searchParams.get('shop_id');
  if (!code || !shopId) {
    const destination = new URL('/dashboard/', requestUrl.origin);
    destination.searchParams.set('shopee', 'error');
    destination.searchParams.set('reason', 'missing_code');
    destination.hash = 'connection';
    return Response.redirect(destination.toString(), 302);
  }

  let tokenResponse;
  try {
    const endpoint = await buildPublicEndpoint('/api/v2/auth/token/get', env);
    const response = await shopeeFetch(env, endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        shop_id: Number(shopId),
        partner_id: Number(env.SHOPEE_PARTNER_ID)
      })
    });
    tokenResponse = await response.json();
  } catch (_) {
    const destination = new URL('/dashboard/', requestUrl.origin);
    destination.searchParams.set('shopee', 'error');
    destination.searchParams.set('reason', 'token_exchange');
    destination.hash = 'connection';
    return Response.redirect(destination.toString(), 302);
  }

  if (!tokenResponse?.access_token || tokenResponse?.error) {
    const destination = new URL('/dashboard/', requestUrl.origin);
    destination.searchParams.set('shopee', 'error');
    destination.searchParams.set('reason', 'token_rejected');
    destination.hash = 'connection';
    return Response.redirect(destination.toString(), 302);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || null,
    expire_in: Number(tokenResponse.expire_in || 0),
    expires_at: Number(tokenResponse.expire_in || 0) ? now + Number(tokenResponse.expire_in) : null,
    shop_id: String(shopId),
    connected_at: now
  };
  const encrypted = await encryptObject(payload, env.SESSION_SECRET);
  const destination = new URL('/dashboard/', requestUrl.origin);
  destination.searchParams.set('shopee', 'connected');
  destination.hash = 'connection';
  const headers = new Headers({ location: destination.toString(), 'cache-control': 'no-store' });
  headers.append('set-cookie', shopeeCookie(encrypted));
  headers.append('set-cookie', clearOauthCookie());
  return new Response(null, { status: 302, headers });
};

const handleTokenHealth = async (request, env) => {
  if (!(await sessionIsValid(request, env))) return json({ error: 'unauthorized' }, 401);

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
    return json({
      error: 'shopee_probe_failed',
      message: probe.message,
      diagnostic: probe.diagnostic || null
    }, 502);
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
      reconnectRequired: true,
      diagnostic: retry.diagnostic || null
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
    if (url.pathname === '/api/shopee/status' && request.method === 'GET') {
      return handleShopeeStatus(request, env);
    }
    if (url.pathname === '/api/shopee/shop-info' && request.method === 'GET') {
      return handleShopInfo(request, env);
    }
    if (url.pathname === '/api/shopee/token-health' && request.method === 'GET') {
      return handleTokenHealth(request, env);
    }
    if (url.pathname === '/shopee/callback' && request.method === 'GET') {
      return handleShopeeCallback(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};