import baseWorker from './worker-v3-4.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';
const TRACKING_INFO_PATH = '/api/v2/logistics/get_tracking_info';
const TRACKING_NUMBER_PATH = '/api/v2/logistics/get_tracking_number';

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

const base64UrlDecode = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const deriveAesKey = async (secret) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`ARSTORE_SHOPEE_TOKEN_V1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
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

const getEncryptedTokenFromSetCookie = (headers) => {
  const raw = headers.get('set-cookie') || '';
  const match = raw.match(/(?:^|,\s*)arstore_shopee=([^;]+)/i);
  return match?.[1] || null;
};

const importHmacKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

const hmacHex = async (secret, value) => {
  const key = await importHmacKey(secret);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const getShopeeBase = (env) => (env.SHOPEE_API_BASE || SHOPEE_DEFAULT_BASE).replace(/\/$/, '');

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

const parseShopeeError = (data, fallback = 'Shopee request failed') =>
  data?.message || data?.error || data?.debug_message || fallback;

const shopGet = async (path, token, env, params = {}) => {
  try {
    const endpoint = await buildShopEndpoint(path, token, env, params);
    const response = await fetch(endpoint.toString(), { headers: { accept: 'application/json' } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { return { ok: false, status: response.status, data: null, message: 'Shopee returned a non-JSON response' }; }
    return {
      ok: response.ok && !data?.error,
      status: response.status,
      data,
      message: parseShopeeError(data)
    };
  } catch (_) {
    return { ok: false, status: 502, data: null, message: 'Shopee API unreachable' };
  }
};

const getOrdersAndToken = async (request, env) => {
  const ordersUrl = new URL('/api/shopee/orders?days=14&page_size=50', request.url);
  const ordersRequest = new Request(ordersUrl.toString(), { method: 'GET', headers: request.headers });
  const ordersResponse = await baseWorker.fetch(ordersRequest, env);
  let payload = null;
  try { payload = await ordersResponse.clone().json(); } catch (_) {}
  if (!ordersResponse.ok || !payload?.ok) {
    return {
      ok: false,
      response: json({
        error: payload?.error || 'logistics_order_source_failed',
        message: payload?.message || null
      }, ordersResponse.status || 502)
    };
  }

  const refreshedEncrypted = getEncryptedTokenFromSetCookie(ordersResponse.headers);
  const requestEncrypted = parseCookies(request)[SHOPEE_COOKIE];
  const token = await decryptObject(refreshedEncrypted || requestEncrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) {
    return { ok: false, response: json({ error: 'shopee_token_unavailable' }, 401) };
  }

  return {
    ok: true,
    payload,
    token,
    setCookie: refreshedEncrypted ? ordersResponse.headers.get('set-cookie') : null,
    refreshed: Boolean(refreshedEncrypted)
  };
};

const cleanText = (value, fallback = '—') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const classifyLogistics = (orderStatus, logisticsStatus) => {
  const order = String(orderStatus || '').toUpperCase();
  const logistics = String(logisticsStatus || '').toUpperCase();
  const text = `${order} ${logistics}`;
  if (/COMPLETED|DELIVERED|DELIVERY_DONE/.test(text)) return 'delivered';
  if (/SHIPPED|IN_TRANSIT|PICKUP_DONE|PICKED_UP|TRANSPORT|DELIVERING|DELIVERY_REQUEST/.test(text)) return 'transit';
  if (/READY_TO_SHIP|PROCESSED|LOGISTICS_READY|REQUEST_CREATED|PICKUP_RETRY/.test(text)) return 'ready';
  if (/CANCELLED|IN_CANCEL/.test(text)) return 'cancelled';
  return 'other';
};

const computeSla = (shipByDate, state) => {
  const deadline = Number(shipByDate || 0);
  if (!deadline || state !== 'ready') return { risk: false, label: '—', secondsRemaining: null };
  const remaining = deadline - Math.floor(Date.now() / 1000);
  if (remaining < 0) return { risk: true, label: 'OVERDUE', secondsRemaining: remaining };
  if (remaining <= 24 * 60 * 60) return { risk: true, label: 'DUE <24H', secondsRemaining: remaining };
  return { risk: false, label: 'ON TRACK', secondsRemaining: remaining };
};

const firstTrackingNumber = (response = {}) =>
  response.tracking_number ||
  response.first_mile_tracking_number ||
  response.last_mile_tracking_number ||
  response.plp_number ||
  '';

const enrichLogisticsOrder = async (order, token, env) => {
  const params = { order_sn: order.orderSn };
  const [trackingInfoResult, trackingNumberResult] = await Promise.all([
    shopGet(TRACKING_INFO_PATH, token, env, params),
    shopGet(TRACKING_NUMBER_PATH, token, env, {
      ...params,
      response_optional_fields: 'plp_number,first_mile_tracking_number,last_mile_tracking_number'
    })
  ]);

  const trackingInfo = trackingInfoResult.ok ? (trackingInfoResult.data?.response || {}) : {};
  const trackingNumberResponse = trackingNumberResult.ok ? (trackingNumberResult.data?.response || {}) : {};
  const logisticsStatus = cleanText(
    trackingInfo.logistics_status || order.logisticsStatus,
    order.status === 'READY_TO_SHIP' ? 'LOGISTICS_READY' : '—'
  );
  const state = classifyLogistics(order.status, logisticsStatus);
  const sla = computeSla(order.shipByDate, state);

  return {
    orderSn: order.orderSn,
    buyerUsername: order.buyerUsername,
    orderStatus: order.status,
    logisticsStatus,
    state,
    courier: cleanText(order.shippingCarrier),
    trackingNumber: cleanText(firstTrackingNumber(trackingNumberResponse)),
    shipByDate: Number(order.shipByDate || 0) || null,
    createTime: Number(order.createTime || 0) || null,
    updateTime: Number(order.updateTime || 0) || null,
    itemCount: Number(order.itemCount || 0),
    units: Number(order.units || 0),
    slaRisk: sla.risk,
    slaLabel: sla.label,
    slaSecondsRemaining: sla.secondsRemaining,
    trackingInfoAvailable: trackingInfoResult.ok,
    trackingNumberAvailable: trackingNumberResult.ok && Boolean(firstTrackingNumber(trackingNumberResponse)),
    trackingInfoMessage: trackingInfoResult.ok ? null : trackingInfoResult.message,
    trackingNumberMessage: trackingNumberResult.ok ? null : trackingNumberResult.message
  };
};

const mapWithConcurrency = async (items, limit, mapper) => {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
};

const handleLogistics = async (request, env) => {
  if (!env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY || !env.SESSION_SECRET) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const source = await getOrdersAndToken(request, env);
  if (!source.ok) return source.response;

  const orders = Array.isArray(source.payload.orders) ? source.payload.orders : [];
  const shipments = await mapWithConcurrency(orders, 4, (order) => enrichLogisticsOrder(order, source.token, env));
  const counts = {
    ready: shipments.filter((shipment) => shipment.state === 'ready').length,
    transit: shipments.filter((shipment) => shipment.state === 'transit').length,
    delivered: shipments.filter((shipment) => shipment.state === 'delivered').length,
    slaRisk: shipments.filter((shipment) => shipment.slaRisk).length
  };

  return json({
    ok: true,
    source: 'shopee',
    shopId: String(source.token.shop_id),
    tokenRefreshed: source.refreshed,
    loaded: shipments.length,
    counts,
    shipments
  }, 200, source.setCookie ? { 'set-cookie': source.setCookie } : {});
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/logistics' && request.method === 'GET') {
      return handleLogistics(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};
