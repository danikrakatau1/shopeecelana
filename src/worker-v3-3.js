import baseWorker from './worker-v3-2.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';
const ORDER_LIST_PATH = '/api/v2/order/get_order_list';
const ORDER_DETAIL_PATH = '/api/v2/order/get_order_detail';

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
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, status: response.status, data: null, message: 'Shopee returned a non-JSON response' };
    }
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

const getFreshToken = async (request, env) => {
  const statusUrl = new URL('/api/shopee/status', request.url);
  const statusRequest = new Request(statusUrl.toString(), {
    method: 'GET',
    headers: request.headers
  });
  const statusResponse = await baseWorker.fetch(statusRequest, env);

  let statusPayload = null;
  try { statusPayload = await statusResponse.clone().json(); } catch (_) {}
  if (!statusResponse.ok || !statusPayload?.connected) {
    return {
      ok: false,
      response: json({
        error: statusPayload?.refreshError || statusPayload?.error || 'shopee_not_connected',
        message: statusPayload?.message || null
      }, statusResponse.status === 401 ? 401 : 503)
    };
  }

  const refreshedEncrypted = getEncryptedTokenFromSetCookie(statusResponse.headers);
  const requestEncrypted = parseCookies(request)[SHOPEE_COOKIE];
  const token = await decryptObject(refreshedEncrypted || requestEncrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) {
    return { ok: false, response: json({ error: 'shopee_token_unavailable' }, 401) };
  }

  return {
    ok: true,
    token,
    setCookie: refreshedEncrypted ? statusResponse.headers.get('set-cookie') : null,
    refreshed: Boolean(refreshedEncrypted)
  };
};

const asArray = (value) => Array.isArray(value) ? value : [];
const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizeOrderItem = (item, index) => ({
  itemId: String(item?.item_id ?? ''),
  modelId: String(item?.model_id ?? ''),
  itemName: item?.item_name || `Item ${index + 1}`,
  itemSku: item?.item_sku || '—',
  modelName: item?.model_name || '',
  modelSku: item?.model_sku || '—',
  quantity: numberOrZero(item?.model_quantity_purchased || item?.quantity || 0),
  originalPrice: numberOrZero(item?.model_original_price || 0),
  discountedPrice: numberOrZero(item?.model_discounted_price || item?.model_original_price || 0)
});

const normalizeOrder = (detail, summary = {}) => {
  const items = asArray(detail?.item_list).map(normalizeOrderItem);
  const packages = asArray(detail?.package_list);
  const packageStatus = packages.find((pkg) => pkg?.logistics_status)?.logistics_status || '';
  const units = items.reduce((sum, item) => sum + numberOrZero(item.quantity), 0);
  return {
    orderSn: String(detail?.order_sn || summary?.order_sn || ''),
    status: detail?.order_status || summary?.order_status || 'UNKNOWN',
    buyerUsername: detail?.buyer_username || '—',
    totalAmount: numberOrZero(detail?.total_amount),
    currency: detail?.currency || 'IDR',
    createTime: numberOrZero(detail?.create_time),
    updateTime: numberOrZero(detail?.update_time),
    payTime: numberOrZero(detail?.pay_time),
    shipByDate: numberOrZero(detail?.ship_by_date),
    shippingCarrier: detail?.shipping_carrier || detail?.checkout_shipping_carrier || '—',
    logisticsStatus: packageStatus || '—',
    paymentMethod: detail?.payment_method || '—',
    cod: Boolean(detail?.cod),
    itemCount: items.length,
    units,
    items
  };
};

const summarizeStatuses = (orders) => {
  const counts = {
    UNPAID: 0,
    READY_TO_SHIP: 0,
    PROCESSED: 0,
    SHIPPED: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    IN_CANCEL: 0,
    OTHER: 0
  };
  orders.forEach((order) => {
    const key = String(order.status || 'OTHER').toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
    else counts.OTHER += 1;
  });
  return counts;
};

const handleOrders = async (request, env, url) => {
  if (!env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY || !env.SESSION_SECRET) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const fresh = await getFreshToken(request, env);
  if (!fresh.ok) return fresh.response;

  const days = Math.min(15, Math.max(1, Number(url.searchParams.get('days') || 14) || 14));
  const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('page_size') || 50) || 50));
  const now = Math.floor(Date.now() / 1000);
  const timeTo = now;
  const timeFrom = now - (days * 24 * 60 * 60);
  const statusFilter = String(url.searchParams.get('order_status') || '').trim().toUpperCase();
  const cursor = String(url.searchParams.get('cursor') || '').trim();

  const listParams = {
    time_range_field: 'create_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: pageSize,
    response_optional_fields: 'order_status'
  };
  if (statusFilter) listParams.order_status = statusFilter;
  if (cursor) listParams.cursor = cursor;

  const listResult = await shopGet(ORDER_LIST_PATH, fresh.token, env, listParams);
  if (!listResult.ok) {
    return json({ error: 'shopee_order_list_error', message: listResult.message }, 502,
      fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
  }

  const listResponse = listResult.data?.response || {};
  const summaries = asArray(listResponse.order_list);
  const orderSns = summaries.map((order) => order?.order_sn).filter(Boolean).slice(0, 50);

  let details = [];
  if (orderSns.length) {
    const detailResult = await shopGet(ORDER_DETAIL_PATH, fresh.token, env, {
      order_sn_list: orderSns.join(','),
      response_optional_fields: 'buyer_username,item_list,pay_time,package_list,shipping_carrier,payment_method,total_amount'
    });
    if (!detailResult.ok) {
      return json({ error: 'shopee_order_detail_error', message: detailResult.message }, 502,
        fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
    }
    details = asArray(detailResult.data?.response?.order_list);
  }

  const summaryBySn = new Map(summaries.map((order) => [String(order?.order_sn || ''), order]));
  const detailBySn = new Map(details.map((order) => [String(order?.order_sn || ''), order]));
  const orders = orderSns.map((orderSn) => normalizeOrder(detailBySn.get(String(orderSn)) || {}, summaryBySn.get(String(orderSn)) || {}));
  const counts = summarizeStatuses(orders);

  return json({
    ok: true,
    source: 'shopee',
    shopId: String(fresh.token.shop_id),
    tokenRefreshed: fresh.refreshed,
    rangeDays: days,
    loaded: orders.length,
    more: Boolean(listResponse.more),
    nextCursor: listResponse.next_cursor || null,
    statusFilter: statusFilter || null,
    counts,
    orders
  }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/orders' && request.method === 'GET') {
      return handleOrders(request, env, url);
    }
    return baseWorker.fetch(request, env);
  }
};
