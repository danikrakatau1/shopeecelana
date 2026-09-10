import baseWorker from './worker-v3-6.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';
const ESCROW_DETAIL_PATH = '/api/v2/payment/get_escrow_detail';

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

const parseShopeeError = (data, fallback = 'Shopee request failed') =>
  data?.message || data?.error || data?.debug_message || fallback;

const shopPost = async (path, token, env, body = {}) => {
  try {
    const endpoint = await buildShopEndpoint(path, token, env);
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
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
        error: payload?.error || 'finance_order_source_failed',
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

const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const firstPositive = (...values) => {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
};

const normalizeFinanceOrder = (order, result) => {
  if (!result.ok) {
    return {
      orderSn: order.orderSn,
      buyerUsername: order.buyerUsername,
      orderStatus: order.status,
      paymentMethod: order.paymentMethod,
      currency: order.currency || 'IDR',
      orderTotal: numberOrZero(order.totalAmount),
      escrowAvailable: false,
      escrowMessage: result.message || 'Escrow detail unavailable',
      expectedPayout: 0,
      sellingValue: numberOrZero(order.totalAmount),
      buyerTotal: numberOrZero(order.totalAmount),
      shopeeFees: 0,
      withholdingTax: 0,
      shippingCost: 0,
      commissionFee: 0,
      serviceFee: 0,
      transactionFee: 0,
      processingFee: 0,
      affiliateFee: 0,
      adsEscrowFee: 0
    };
  }

  const response = result.data?.response || {};
  const detail = response.escrow_detail || response;
  const income = detail?.order_income || {};
  const buyerPayment = detail?.buyer_payment_info || {};

  const commissionFee = numberOrZero(income.commission_fee);
  const serviceFee = numberOrZero(income.service_fee);
  const transactionFee = numberOrZero(income.seller_transaction_fee);
  const processingFee = numberOrZero(income.seller_order_processing_fee);
  const affiliateFee = numberOrZero(income.order_ams_commission_fee);
  const adsEscrowFee = numberOrZero(income.ads_escrow_top_up_fee_or_technical_support_fee);
  const withholdingTax = numberOrZero(income.withholding_tax);
  const shippingCost = firstPositive(
    income.actual_shipping_fee,
    income.final_return_to_seller_shipping_fee,
    income.reverse_shipping_fee
  );
  const shopeeFees = commissionFee + serviceFee + transactionFee + processingFee + affiliateFee + adsEscrowFee;
  const expectedPayout = firstPositive(income.escrow_amount_after_adjustment, income.escrow_amount);
  const sellingValue = firstPositive(income.order_selling_price, income.order_original_price, order.totalAmount);
  const buyerTotal = firstPositive(buyerPayment.buyer_total_amount, order.totalAmount);

  return {
    orderSn: order.orderSn,
    buyerUsername: detail?.buyer_user_name || order.buyerUsername,
    orderStatus: order.status,
    paymentMethod: buyerPayment.buyer_payment_method || order.paymentMethod,
    currency: order.currency || 'IDR',
    orderTotal: numberOrZero(order.totalAmount),
    escrowAvailable: true,
    escrowMessage: null,
    expectedPayout,
    sellingValue,
    buyerTotal,
    shopeeFees,
    withholdingTax,
    shippingCost,
    commissionFee,
    serviceFee,
    transactionFee,
    processingFee,
    affiliateFee,
    adsEscrowFee,
    escrowReleaseTime: numberOrZero(detail?.escrow_release_time)
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

const handleFinance = async (request, env) => {
  if (!env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY || !env.SESSION_SECRET) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const source = await getOrdersAndToken(request, env);
  if (!source.ok) return source.response;

  const orders = Array.isArray(source.payload.orders) ? source.payload.orders : [];
  const financeOrders = await mapWithConcurrency(orders, 4, async (order) => {
    const result = await shopPost(ESCROW_DETAIL_PATH, source.token, env, { order_sn: order.orderSn });
    return normalizeFinanceOrder(order, result);
  });

  const totals = financeOrders.reduce((acc, item) => {
    acc.orderValue += numberOrZero(item.orderTotal);
    acc.expectedPayout += numberOrZero(item.expectedPayout);
    acc.shopeeFees += numberOrZero(item.shopeeFees);
    acc.withholdingTax += numberOrZero(item.withholdingTax);
    acc.shippingCost += numberOrZero(item.shippingCost);
    if (item.escrowAvailable) acc.escrowReady += 1;
    return acc;
  }, {
    orderValue: 0,
    expectedPayout: 0,
    shopeeFees: 0,
    withholdingTax: 0,
    shippingCost: 0,
    escrowReady: 0
  });

  return json({
    ok: true,
    source: 'shopee',
    shopId: String(source.token.shop_id),
    tokenRefreshed: source.refreshed,
    loaded: financeOrders.length,
    totals,
    orders: financeOrders,
    note: 'Read-only finance data. COGS and ad spend are not included.'
  }, 200, source.setCookie ? { 'set-cookie': source.setCookie } : {});
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/finance' && request.method === 'GET') {
      return handleFinance(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};
