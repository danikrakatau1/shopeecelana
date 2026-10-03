// src/muse-bridge.js
//
// Private read-only data bridge for Muse automation (e.g. the daily 23:00 WIB
// WhatsApp recap cron). Called from worker-v3-12.js via handleBridgeQuery().
//
// Auth:  request header `x-bridge-secret` is compared (constant-time) against
//        the MUSE_BRIDGE_SECRET worker secret. Wrong/missing secret -> 401,
//        with no information leaked about which part failed.
// Token: the Shopee token is read from the SHOPEE_KV binding (key
//        `token:primary`), written there by handleShopeeCallback and by
//        refreshShopeeToken in worker-v3-12.js. The bridge decrypts it with
//        SESSION_SECRET (same AES-GCM scheme as the dashboard cookie).
//
// READ-ONLY: this module never calls a Shopee write endpoint and never
// returns raw token values in any response.

const TOKEN_REFRESH_WINDOW = 15 * 60; // seconds
const MAX_BRIDGE_ORDERS = 100;
const ESCROW_CONCURRENCY = 4;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const BRIDGE_KV_KEY = 'token:primary';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0'
    }
  });

const numberOrZero = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const firstPositive = (...values) => {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

// Constant-time comparison so the secret cannot be probed byte-by-byte.
// (Length is compared first; the secret is a fixed-length random string.)
const constantTimeEqual = (a, b) => {
  const ea = new TextEncoder().encode(String(a || ''));
  const eb = new TextEncoder().encode(String(b || ''));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
};

const parseShopeeError = (data, fallback = 'Shopee request failed') =>
  data?.message || data?.error || data?.debug_message || fallback;

const shopGet = async (path, token, env, h, params = {}) => {
  try {
    const endpoint = await h.buildShopEndpoint(path, token, env, params);
    const response = await h.shopeeFetch(env, endpoint.toString(), {
      headers: { accept: 'application/json' }
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}
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

const shopPost = async (path, token, env, h, body = {}) => {
  try {
    const endpoint = await h.buildShopEndpoint(path, token, env);
    const response = await h.shopeeFetch(env, endpoint.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}
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

// Load the Shopee token from KV and refresh it if it is close to expiry.
// Returns { ok, token } — never exposes the raw token to the caller response.
const getBridgeToken = async (env, h) => {
  if (!env.SHOPEE_KV || !env.SESSION_SECRET) {
    return { ok: false, error: 'bridge_not_configured' };
  }
  let encrypted = null;
  try {
    encrypted = await env.SHOPEE_KV.get(BRIDGE_KV_KEY);
  } catch (_) {
    return { ok: false, error: 'bridge_kv_unreadable' };
  }
  const token = await h.decryptObject(encrypted, env.SESSION_SECRET);
  if (!token?.access_token || !token?.shop_id) {
    return { ok: false, error: 'bridge_no_token' };
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = token.expires_at ? token.expires_at - now : Number.MAX_SAFE_INTEGER;
  if (remaining > TOKEN_REFRESH_WINDOW) return { ok: true, token };
  const refreshed = await h.refreshShopeeToken(token, env);
  if (!refreshed.ok) return { ok: false, error: 'bridge_refresh_failed', message: refreshed.message };
  await h.persistTokenToKV(refreshed.token, env);
  return { ok: true, token: refreshed.token };
};

// Start of "today" in Asia/Jakarta (WIB, UTC+7, no DST), as unix seconds.
const wibDayBounds = () => {
  const nowMs = Date.now();
  const dayStartMs = Math.floor((nowMs + WIB_OFFSET_MS) / 86400000) * 86400000 - WIB_OFFSET_MS;
  return { timeFrom: Math.floor(dayStartMs / 1000), timeTo: Math.floor(nowMs / 1000) };
};

const fetchTodayOrderSns = async (token, env, h) => {
  const { timeFrom, timeTo } = wibDayBounds();
  const orderSns = [];
  let cursor = '';
  for (let page = 0; page < 4 && orderSns.length < MAX_BRIDGE_ORDERS; page++) {
    const params = {
      time_range_field: 'create_time',
      time_from: timeFrom,
      time_to: timeTo,
      page_size: 50,
      response_optional_fields: 'order_status'
    };
    if (cursor) params.cursor = cursor;
    const result = await shopGet('/api/v2/order/get_order_list', token, env, h, params);
    if (!result.ok) return { ok: false, message: result.message };
    const response = result.data?.response || {};
    for (const order of asArray(response.order_list)) {
      if (order?.order_sn) orderSns.push(String(order.order_sn));
    }
    cursor = response.next_cursor || '';
    if (!response.more || !cursor) break;
  }
  return { ok: true, orderSns: orderSns.slice(0, MAX_BRIDGE_ORDERS) };
};

const fetchOrderDetails = async (token, env, h, orderSns) => {
  const details = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const chunk = orderSns.slice(i, i + 50);
    const result = await shopGet('/api/v2/order/get_order_detail', token, env, h, {
      order_sn_list: chunk.join(','),
      response_optional_fields: 'total_amount,currency,order_status,create_time'
    });
    if (!result.ok) return { ok: false, message: result.message };
    for (const order of asArray(result.data?.response?.order_list)) details.push(order);
  }
  return { ok: true, details };
};

const opShopInfo = async (token, env, h) => {
  const result = await shopGet('/api/v2/shop/get_shop_info', token, env, h);
  if (!result.ok) return json({ error: 'shopee_api_error', message: result.message }, 502);
  const shop = result.data?.response || result.data || {};
  return json({
    ok: true,
    shop: {
      shop_id: String(token.shop_id),
      shop_name: shop.shop_name || null,
      region: shop.region || 'ID',
      status: shop.shop_status || shop.status || null
    }
  });
};

const opOrdersToday = async (token, env, h) => {
  const list = await fetchTodayOrderSns(token, env, h);
  if (!list.ok) return json({ error: 'shopee_order_list_error', message: list.message }, 502);
  let omzet = 0;
  let counted = 0;
  if (list.orderSns.length) {
    const detail = await fetchOrderDetails(token, env, h, list.orderSns);
    if (!detail.ok) return json({ error: 'shopee_order_detail_error', message: detail.message }, 502);
    for (const order of detail.details) {
      counted += 1;
      omzet += numberOrZero(order?.total_amount);
    }
  }
  return json({
    ok: true,
    date: new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10),
    timezone: 'Asia/Jakarta',
    order_count: counted,
    omzet_total: omzet,
    currency: 'IDR'
  });
};

const escrowSummary = (result) => {
  if (!result.ok) return { available: false, payout: 0, fees: 0, tax: 0 };
  const response = result.data?.response || {};
  const detail = response.escrow_detail || response;
  const income = detail?.order_income || {};
  const commissionFee = numberOrZero(income.commission_fee);
  const serviceFee = numberOrZero(income.service_fee);
  const transactionFee = numberOrZero(income.seller_transaction_fee);
  const processingFee = numberOrZero(income.seller_order_processing_fee);
  const affiliateFee = numberOrZero(income.order_ams_commission_fee);
  const adsEscrowFee = numberOrZero(income.ads_escrow_top_up_fee_or_technical_support_fee);
  return {
    available: true,
    payout: firstPositive(income.escrow_amount_after_adjustment, income.escrow_amount),
    fees: commissionFee + serviceFee + transactionFee + processingFee + affiliateFee + adsEscrowFee,
    tax: numberOrZero(income.withholding_tax)
  };
};

const opFinanceToday = async (token, env, h) => {
  const list = await fetchTodayOrderSns(token, env, h);
  if (!list.ok) return json({ error: 'shopee_order_list_error', message: list.message }, 502);

  const orderSns = list.orderSns;
  const summaries = new Array(orderSns.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(ESCROW_CONCURRENCY, orderSns.length) }, async () => {
    while (cursor < orderSns.length) {
      const index = cursor;
      cursor += 1;
      const result = await shopPost('/api/v2/payment/get_escrow_detail', token, env, h, {
        order_sn: orderSns[index]
      });
      summaries[index] = escrowSummary(result);
    }
  });
  await Promise.all(workers);

  const totals = summaries.reduce(
    (acc, item) => {
      if (!item) return acc;
      if (item.available) acc.escrow_ready += 1;
      acc.payout_total += item.payout;
      acc.fee_total += item.fees;
      acc.tax_total += item.tax;
      return acc;
    },
    { payout_total: 0, fee_total: 0, tax_total: 0, escrow_ready: 0 }
  );

  return json({
    ok: true,
    date: new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10),
    timezone: 'Asia/Jakarta',
    order_count: orderSns.length,
    escrow_ready: totals.escrow_ready,
    payout_total: totals.payout_total,
    fee_total: totals.fee_total,
    tax_total: totals.tax_total,
    currency: 'IDR',
    note: 'Escrow is usually only available after orders complete; same-day payout is an estimate.'
  });
};

const opAdsToday = async (token, env, h) => {
  const toggle = await shopGet('/api/v2/ads/get_shop_toggle_info', token, env, h);
  const enabled = toggle.ok && Boolean(toggle.data?.response?.ads_enabled ?? toggle.data?.response);
  // Shopee Ads is currently switched off for this shop; report that plainly.
  if (!toggle.ok || !enabled) {
    return json({
      ok: true,
      ads_enabled: false,
      spend_today: 0,
      currency: 'IDR',
      note: toggle.ok ? 'Shopee Ads is switched off.' : 'Ads status unavailable; reported as off.'
    });
  }
  // Ads on: best-effort daily spend via campaign daily performance.
  let spend = 0;
  try {
    const campaigns = await shopGet('/api/v2/ads/get_product_level_campaign_id_list', token, env, h, {
      page_number: 1,
      page_size: 50
    });
    const ids = asArray(campaigns.data?.response?.campaign_id_list).slice(0, 50);
    if (campaigns.ok && ids.length) {
      const { timeFrom, timeTo } = wibDayBounds();
      const perf = await shopGet('/api/v2/ads/get_product_campaign_daily_performance', token, env, h, {
        campaign_id_list: ids.join(','),
        start_date: new Date(timeFrom * 1000).toISOString().slice(0, 10),
        end_date: new Date(timeTo * 1000).toISOString().slice(0, 10)
      });
      if (perf.ok) {
        for (const row of asArray(perf.data?.response?.performance_list)) {
          spend += numberOrZero(row?.cost ?? row?.expense);
        }
      }
    }
  } catch (_) {}
  return json({
    ok: true,
    ads_enabled: true,
    spend_today: spend,
    currency: 'IDR'
  });
};

export const handleBridgeQuery = async (request, env, h) => {
  if (!env.MUSE_BRIDGE_SECRET) {
    return json({ error: 'bridge_not_configured' }, 503);
  }
  const presented = request.headers.get('x-bridge-secret') || '';
  if (!constantTimeEqual(presented, env.MUSE_BRIDGE_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (_) {}
  const op = String(body?.op || '').trim();
  const OPS = {
    shop_info: opShopInfo,
    orders_today: opOrdersToday,
    finance_today: opFinanceToday,
    ads_today: opAdsToday
  };
  if (!OPS[op]) {
    return json({ error: 'unknown_op', allowed: Object.keys(OPS) }, 400);
  }

  const tokenResult = await getBridgeToken(env, h);
  if (!tokenResult.ok) {
    const status = tokenResult.error === 'bridge_no_token' ? 401 : 502;
    return json(
      {
        error: tokenResult.error,
        message:
          tokenResult.error === 'bridge_no_token'
            ? 'No Shopee token in KV. Reconnect Shopee once via the dashboard so the token is stored.'
            : tokenResult.message || null
      },
      status
    );
  }

  return OPS[op](tokenResult.token, env, h);
};
