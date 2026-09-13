import { shopeeFetch } from './shopee-egress.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_COOKIE_TTL = 60 * 60 * 24 * 30;
const TOKEN_REFRESH_WINDOW = 15 * 60;
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';

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

const parseCookies = (request) => {
  const header = request.headers.get('cookie') || '';
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
    })
  );
};

const deriveAesKey = async (keyMaterial) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`ARSTORE_SHOPEE_TOKEN_V1:${keyMaterial}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

export const encryptShopeeToken = async (value, keyMaterial) => {
  const key = await deriveAesKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return base64UrlEncode(combined);
};

export const decryptShopeeToken = async (value, keyMaterial) => {
  if (!value || !keyMaterial) return null;
  try {
    const combined = base64UrlDecode(value);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await deriveAesKey(keyMaterial);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(decoder.decode(plaintext));
  } catch (_) {
    return null;
  }
};

export const shopeeTokenCookie = (token) =>
  `${SHOPEE_COOKIE}=${token}; Path=/api/shopee; HttpOnly; Secure; SameSite=Lax; Max-Age=${SHOPEE_COOKIE_TTL}`;

const importPartnerHmacKey = (keyMaterial) =>
  crypto.subtle.importKey('raw', encoder.encode(keyMaterial), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const hmacHex = async (keyMaterial, value) => {
  const key = await importPartnerHmacKey(keyMaterial);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const getShopeeBase = (env) => String(env.SHOPEE_API_BASE || SHOPEE_DEFAULT_BASE).replace(/\/$/, '');

export const buildShopeePublicEndpoint = async (path, env) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(env.SHOPEE_PARTNER_KEY, `${env.SHOPEE_PARTNER_ID}${path}${timestamp}`);
  const endpoint = new URL(`${getShopeeBase(env)}${path}`);
  endpoint.searchParams.set('partner_id', env.SHOPEE_PARTNER_ID);
  endpoint.searchParams.set('timestamp', String(timestamp));
  endpoint.searchParams.set('sign', sign);
  return endpoint;
};

const refreshShopeeToken = async (token, env) => {
  if (!token?.refresh_token || !token?.shop_id) return { ok: false, error: 'refresh_token_missing' };
  const endpoint = await buildShopeePublicEndpoint('/api/v2/auth/access_token/get', env);
  try {
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
      return { ok: false, error: 'refresh_failed', message: data?.message || data?.error || data?.debug_message || 'Shopee token refresh failed' };
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

export const getFreshShopeeToken = async (request, env, minValidity = TOKEN_REFRESH_WINDOW) => {
  if (!env.SESSION_SECRET || !env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY) {
    return { ok: false, error: 'shopee_not_configured' };
  }

  const encrypted = parseCookies(request)[SHOPEE_COOKIE];
  const token = await decryptShopeeToken(encrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) return { ok: false, error: 'shopee_not_connected' };

  const now = Math.floor(Date.now() / 1000);
  const remaining = token.expires_at ? token.expires_at - now : Number.MAX_SAFE_INTEGER;
  if (remaining > minValidity) return { ok: true, token, refreshed: false, setCookie: null };

  const refreshed = await refreshShopeeToken(token, env);
  if (!refreshed.ok) return refreshed;
  const nextEncrypted = await encryptShopeeToken(refreshed.token, env.SESSION_SECRET);
  return {
    ok: true,
    token: refreshed.token,
    refreshed: true,
    setCookie: shopeeTokenCookie(nextEncrypted)
  };
};
