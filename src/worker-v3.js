const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SESSION_COOKIE = 'arstore_session';
const SHOPEE_COOKIE = 'arstore_shopee';
const OAUTH_COOKIE = 'arstore_oauth';
const SESSION_TTL = 60 * 60 * 12;
const SHOPEE_COOKIE_TTL = 60 * 60 * 24 * 30;
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';
const TOKEN_REFRESH_WINDOW = 15 * 60;

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...jsonHeaders, ...extraHeaders } });

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
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const importHmacKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const hmacBytes = async (secret, value) => {
  const key = await importHmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
};

const hmacHex = async (secret, value) => {
  const bytes = await hmacBytes(secret, value);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const safeEqual = (a = '', b = '') => {
  const aBytes = encoder.encode(String(a));
  const bBytes = encoder.encode(String(b));
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i += 1) diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  return diff === 0;
};

const createSessionToken = async (secret, subject = 'owner') => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: subject, iat: now, exp: now + SESSION_TTL, nonce: crypto.randomUUID() };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacBytes(secret, body));
  return `${body}.${signature}`;
};

const verifySessionToken = async (token, secret) => {
  if (!token || !secret || !token.includes('.')) return null;
  const [body, signature] = token.split('.', 2);
  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64UrlDecode(body)));
    const now = Math.floor(Date.now() / 1000);
    return payload?.exp > now && payload.sub === 'owner' ? payload : null;
  } catch (_) {
    return null;
  }
};

const getSession = async (request, env) => {
  if (!env.SESSION_SECRET) return null;
  return verifySessionToken(parseCookies(request)[SESSION_COOKIE], env.SESSION_SECRET);
};

const sessionCookie = (token) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`;
const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const shopeeCookie = (token) => `${SHOPEE_COOKIE}=${token}; Path=/api/shopee; HttpOnly; Secure; SameSite=Lax; Max-Age=${SHOPEE_COOKIE_TTL}`;
const clearShopeeCookie = () => `${SHOPEE_COOKIE}=; Path=/api/shopee; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const clearOauthCookie = () => `${OAUTH_COOKIE}=; Path=/shopee/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

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

const getShopeeToken = async (request, env) => {
  if (!env.SESSION_SECRET) return null;
  return decryptObject(parseCookies(request)[SHOPEE_COOKIE], env.SESSION_SECRET);
};

const requireSession = async (request, env) => {
  const session = await getSession(request, env);
  return session ? { ok: true, session } : { ok: false, response: json({ error: 'unauthorized' }, 401) };
};

const getShopeeBase = (env) => (env.SHOPEE_API_BASE || SHOPEE_DEFAULT_BASE).replace(/\/$/, '');
const shopeeCredentialsReady = (env) => Boolean(env.SHOPEE_PARTNER_ID && env.SHOPEE_PARTNER_KEY);

const maskPartnerId = (value) => {
  const text = String(value || '');
  if (!text) return 'Not configured';
  if (text.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(text.length - 4, 8))}${text.slice(-4)}`;
};

const addPrivateHeaders = (response) => {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-frame-options', 'DENY');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const servePrivateAsset = async (request, env) => addPrivateHeaders(await env.ASSETS.fetch(request));

const redirectToLogin = (request) => {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const login = new URL('/seller-login/', url.origin);
  login.searchParams.set('next', next.startsWith('/dashboard') ? next : '/dashboard/');
  return Response.redirect(login.toString(), 302);
};

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

const buildShopEndpoint = async (path, token, env, params = {}) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${env.SHOPEE_PARTNER_ID}${path}${timestamp}${token.access_token}${token.shop_id}`;
  const sign = await hmacHex(env.SHOPEE_PARTNER_KEY, baseString);
  const endpoint = new URL(`${getShopeeBase(env)}${path}`);
  endpoint.searchParams.set('partner_id', env.SHOPEE_PARTNER_ID);
  endpoint.searchParams.set('timestamp', String(timestamp));
  endpoint.searchParams.set('access_token', token.access_token);
  endpoint.searchParams.set('shop_id', String(token.shop_id));
  endpoint.searchParams.set('sign', sign);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') endpoint.searchParams.set(key, String(value));
  });
  return endpoint;
};

const refreshShopeeToken = async (token, env) => {
  if (!token?.refresh_token || !token?.shop_id) return { ok: false, error: 'refresh_token_missing' };
  const path = '/api/v2/auth/access_token/get';
  const endpoint = await buildPublicEndpoint(path, env);
  try {
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
      return { ok: false, error: 'refresh_failed', message: parseShopeeError(data) };
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
    return { ok: false, error: 'refresh_unreachable' };
  }
};

const ensureFreshShopeeToken = async (request, env, minValidity = TOKEN_REFRESH_WINDOW) => {
  const token = await getShopeeToken(request, env);
  if (!token?.access_token || !token?.shop_id) return { ok: false, error: 'shopee_not_connected' };
  const now = Math.floor(Date.now() / 1000);
  const remaining = token.expires_at ? token.expires_at - now : Number.MAX_SAFE_INTEGER;
  if (remaining > minValidity) return { ok: true, token, refreshed: false, setCookie: null };
  const refreshed = await refreshShopeeToken(token, env);
  if (!refreshed.ok) return refreshed;
  const encrypted = await encryptObject(refreshed.token, env.SESSION_SECRET);
  return { ok: true, token: refreshed.token, refreshed: true, setCookie: shopeeCookie(encrypted) };
};

const shopGet = async (path, token, env, params = {}) => {
  const endpoint = await buildShopEndpoint(path, token, env, params);
  try {
    const response = await fetch(endpoint.toString(), { headers: { accept: 'application/json' } });
    const data = await response.json();
    return { ok: response.ok && !data?.error, status: response.status, data, message: parseShopeeError(data) };
  } catch (_) {
    return { ok: false, status: 502, data: null, message: 'Shopee API unreachable' };
  }
};

const handleLogin = async (request, env) => {
  const missing = [];
  if (!env.SELLER_PASSWORD) missing.push('SELLER_PASSWORD');
  if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (missing.length) return json({ error: 'setup_required', missing }, 503);
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid_request' }, 400); }
  const expectedUsername = String(env.SELLER_USERNAME || 'owner').trim().toLowerCase();
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!safeEqual(username, expectedUsername) || !safeEqual(password, env.SELLER_PASSWORD)) return json({ error: 'invalid_credentials' }, 401);
  const token = await createSessionToken(env.SESSION_SECRET, 'owner');
  return json({ ok: true, user: { role: 'owner', username: expectedUsername }, expiresIn: SESSION_TTL }, 200, { 'set-cookie': sessionCookie(token) });
};

const handleSession = async (request, env) => {
  const session = await getSession(request, env);
  if (!session) return json({ authenticated: false }, 401);
  return json({ authenticated: true, user: { role: 'owner', username: env.SELLER_USERNAME || 'owner' }, expiresAt: session.exp });
};

const handleLogout = () => json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });

const handleShopeeStatus = async (request, env) => {
  const auth = await requireSession(request, env);
  if (!auth.ok) return auth.response;
  const configured = shopeeCredentialsReady(env);
  if (!configured || !env.SESSION_SECRET) {
    return json({ configured, connected: false, partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID), shopId: null, tokenExpiresAt: null, callbackUrl: env.SHOPEE_REDIRECT_URL || `${new URL(request.url).origin}/shopee/callback`, storage: 'not connected' });
  }
  const fresh = await ensureFreshShopeeToken(request, env);
  if (!fresh.ok) {
    const token = await getShopeeToken(request, env);
    return json({ configured, connected: Boolean(token?.access_token && token?.shop_id), partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID), shopId: token?.shop_id ? String(token.shop_id) : null, tokenExpiresAt: token?.expires_at || null, callbackUrl: env.SHOPEE_REDIRECT_URL || `${new URL(request.url).origin}/shopee/callback`, storage: token ? 'encrypted HttpOnly cookie' : 'not connected', refreshError: fresh.error || null });
  }
  return json({ configured: true, connected: true, partnerId: maskPartnerId(env.SHOPEE_PARTNER_ID), shopId: String(fresh.token.shop_id), tokenExpiresAt: fresh.token.expires_at || null, tokenRefreshed: fresh.refreshed, callbackUrl: env.SHOPEE_REDIRECT_URL || `${new URL(request.url).origin}/shopee/callback`, storage: 'encrypted HttpOnly cookie' }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const handleShopeeConnect = async (request, env) => {
  const auth = await requireSession(request, env);
  if (!auth.ok) return auth.response;
  if (!shopeeCredentialsReady(env)) return json({ error: 'shopee_not_configured', missing: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'] }, 503);
  const requestUrl = new URL(request.url);
  const path = '/api/v2/shop/auth_partner';
  const authUrl = await buildPublicEndpoint(path, env);
  authUrl.searchParams.set('redirect', env.SHOPEE_REDIRECT_URL || `${requestUrl.origin}/shopee/callback`);
  const headers = new Headers({ location: authUrl.toString(), 'cache-control': 'no-store' });
  headers.append('set-cookie', `${OAUTH_COOKIE}=${crypto.randomUUID()}; Path=/shopee/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return new Response(null, { status: 302, headers });
};

const callbackFailure = (origin, reason) => {
  const url = new URL('/dashboard/', origin);
  url.searchParams.set('shopee', 'error');
  url.searchParams.set('reason', reason);
  url.hash = 'connection';
  return Response.redirect(url.toString(), 302);
};

const handleShopeeCallback = async (request, env) => {
  const requestUrl = new URL(request.url);
  const session = await getSession(request, env);
  if (!session) return redirectToLogin(new Request(`${requestUrl.origin}/dashboard/#connection`, request));
  if (!shopeeCredentialsReady(env) || !env.SESSION_SECRET) return callbackFailure(requestUrl.origin, 'configuration');
  if (!parseCookies(request)[OAUTH_COOKIE]) return callbackFailure(requestUrl.origin, 'oauth_session');
  const code = requestUrl.searchParams.get('code');
  const shopId = requestUrl.searchParams.get('shop_id');
  if (!code || !shopId) return callbackFailure(requestUrl.origin, 'missing_code');
  const endpoint = await buildPublicEndpoint('/api/v2/auth/token/get', env);
  let tokenResponse;
  try {
    const response = await fetch(endpoint.toString(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ code, shop_id: Number(shopId), partner_id: Number(env.SHOPEE_PARTNER_ID) }) });
    tokenResponse = await response.json();
  } catch (_) { return callbackFailure(requestUrl.origin, 'token_exchange'); }
  if (!tokenResponse?.access_token || tokenResponse?.error) return callbackFailure(requestUrl.origin, 'token_rejected');
  const now = Math.floor(Date.now() / 1000);
  const payload = { access_token: tokenResponse.access_token, refresh_token: tokenResponse.refresh_token || null, expire_in: Number(tokenResponse.expire_in || 0), expires_at: Number(tokenResponse.expire_in || 0) ? now + Number(tokenResponse.expire_in) : null, shop_id: String(shopId), connected_at: now };
  const encrypted = await encryptObject(payload, env.SESSION_SECRET);
  const destination = new URL('/dashboard/', requestUrl.origin);
  destination.searchParams.set('shopee', 'connected');
  destination.hash = 'connection';
  const headers = new Headers({ location: destination.toString(), 'cache-control': 'no-store' });
  headers.append('set-cookie', shopeeCookie(encrypted));
  headers.append('set-cookie', clearOauthCookie());
  return new Response(null, { status: 302, headers });
};

const handleShopeeDisconnect = async (request, env) => {
  const auth = await requireSession(request, env);
  if (!auth.ok) return auth.response;
  return json({ ok: true }, 200, { 'set-cookie': clearShopeeCookie() });
};

const handleShopInfo = async (request, env) => {
  const auth = await requireSession(request, env);
  if (!auth.ok) return auth.response;
  if (!shopeeCredentialsReady(env) || !env.SESSION_SECRET) return json({ error: 'shopee_not_configured' }, 503);
  const fresh = await ensureFreshShopeeToken(request, env);
  if (!fresh.ok) return json({ error: fresh.error || 'shopee_token_refresh_failed', message: fresh.message || null }, 401);
  const result = await shopGet('/api/v2/shop/get_shop_info', fresh.token, env);
  if (!result.ok) return json({ error: 'shopee_api_error', message: result.message }, 502, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
  return json({ ok: true, shop: result.data?.response || result.data, tokenRefreshed: fresh.refreshed }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const normalizePrice = (item) => {
  const list = item?.price_info || item?.price_info_list || [];
  const first = Array.isArray(list) ? list[0] : list;
  return Number(first?.current_price ?? first?.original_price ?? item?.price ?? 0) || 0;
};

const normalizeStock = (item) => {
  const v2 = item?.stock_info_v2 || {};
  const candidates = [v2?.summary_info?.total_available_stock, v2?.current_stock, item?.stock, item?.normal_stock];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  const stockList = item?.stock_info || [];
  return Array.isArray(stockList) ? stockList.reduce((sum, entry) => sum + (Number(entry?.current_stock ?? entry?.normal_stock ?? 0) || 0), 0) : 0;
};

const handleProducts = async (request, env, url) => {
  const auth = await requireSession(request, env);
  if (!auth.ok) return auth.response;
  if (!shopeeCredentialsReady(env) || !env.SESSION_SECRET) return json({ error: 'shopee_not_configured' }, 503);
  const fresh = await ensureFreshShopeeToken(request, env);
  if (!fresh.ok) return json({ error: fresh.error || 'shopee_token_refresh_failed', message: fresh.message || null }, 401);
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('page_size') || 50) || 50));
  const itemStatus = url.searchParams.get('item_status') || 'NORMAL';
  const listResult = await shopGet('/api/v2/product/get_item_list', fresh.token, env, { offset, page_size: pageSize, item_status: itemStatus });
  if (!listResult.ok) return json({ error: 'shopee_product_list_error', message: listResult.message }, 502, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
  const listResponse = listResult.data?.response || {};
  const listItems = Array.isArray(listResponse.item) ? listResponse.item : Array.isArray(listResponse.item_list) ? listResponse.item_list : [];
  const itemIds = listItems.map((item) => item?.item_id).filter(Boolean);
  let details = [];
  if (itemIds.length) {
    const baseResult = await shopGet('/api/v2/product/get_item_base_info', fresh.token, env, { item_id_list: itemIds.join(',') });
    if (!baseResult.ok) return json({ error: 'shopee_product_info_error', message: baseResult.message }, 502, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
    const baseResponse = baseResult.data?.response || {};
    details = Array.isArray(baseResponse.item_list) ? baseResponse.item_list : Array.isArray(baseResponse.item) ? baseResponse.item : [];
  }
  const byId = new Map(details.map((item) => [String(item?.item_id), item]));
  const products = listItems.map((summary) => {
    const detail = byId.get(String(summary?.item_id)) || summary;
    return { itemId: String(detail?.item_id || summary?.item_id || ''), name: detail?.item_name || detail?.name || `Shopee Item ${summary?.item_id || ''}`, sku: detail?.item_sku || detail?.seller_sku || '—', status: detail?.item_status || summary?.item_status || itemStatus, price: normalizePrice(detail), stock: normalizeStock(detail), hasModel: Boolean(detail?.has_model), updateTime: Number(summary?.update_time || detail?.update_time || 0) || null };
  });
  return json({ ok: true, source: 'shopee', shopId: String(fresh.token.shop_id), tokenRefreshed: fresh.refreshed, totalCount: Number(listResponse.total_count ?? products.length) || products.length, hasNextPage: Boolean(listResponse.has_next_page), nextOffset: Number(listResponse.next_offset ?? listResponse.next ?? offset + products.length) || null, products }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const handleApi = async (request, env, url) => {
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
  if (url.pathname === '/api/auth/session' && request.method === 'GET') return handleSession(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return handleLogout();
  if (url.pathname === '/api/shopee/status' && request.method === 'GET') return handleShopeeStatus(request, env);
  if (url.pathname === '/api/shopee/connect' && request.method === 'GET') return handleShopeeConnect(request, env);
  if (url.pathname === '/api/shopee/disconnect' && request.method === 'POST') return handleShopeeDisconnect(request, env);
  if (url.pathname === '/api/shopee/shop-info' && request.method === 'GET') return handleShopInfo(request, env);
  if (url.pathname === '/api/shopee/products' && request.method === 'GET') return handleProducts(request, env, url);
  return json({ error: 'not_found' }, 404);
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    if (url.pathname === '/shopee/callback') return handleShopeeCallback(request, env);
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      if (!env.SELLER_PASSWORD || !env.SESSION_SECRET) return new Response('Seller authentication is not configured yet.', { status: 503, headers: { ...jsonHeaders, 'content-type': 'text/plain; charset=utf-8' } });
      const session = await getSession(request, env);
      if (!session) return redirectToLogin(request);
      return servePrivateAsset(request, env);
    }
    if (url.pathname === '/seller-login' || url.pathname.startsWith('/seller-login/')) return servePrivateAsset(request, env);
    return env.ASSETS.fetch(request);
  }
};