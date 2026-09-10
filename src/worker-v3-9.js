import baseWorker from './worker-v3-8.js';

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
    catch (_) {
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

const n = (value) => {
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

const pick = (object, ...keys) => {
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) return n(object[key]);
  }
  return 0;
};

const sumObject = (object) => Object.values(object).reduce((sum, value) => sum + n(value), 0);

const normalizeReconciliation = (order, result) => {
  const fallback = {
    orderSn: order.orderSn,
    buyerUsername: order.buyerUsername,
    orderStatus: order.status,
    paymentMethod: order.paymentMethod,
    currency: order.currency || 'IDR',
    escrowAvailable: false,
    escrowMessage: result?.message || 'Escrow detail unavailable',
    buyer: {
      total: n(order.totalAmount),
      merchandise: 0,
      shipping: 0,
      serviceFee: 0,
      transactionFee: 0,
      tax: 0,
      insurance: 0,
      packagingFee: 0,
      bulkyHandlingFee: 0,
      sellerVoucher: 0,
      shopeeVoucher: 0,
      coins: 0
    },
    settlement: {
      base: 0,
      expectedPayout: 0,
      knownCredits: 0,
      knownDeductions: 0,
      reconstructedPayout: 0,
      reconciliationGap: 0,
      reconciled: false,
      credits: {},
      deductions: {}
    }
  };

  if (!result?.ok) return fallback;

  const response = result.data?.response || {};
  const detail = response.escrow_detail || response;
  const income = detail?.order_income || {};
  const buyerPayment = detail?.buyer_payment_info || {};

  const buyer = {
    total: firstPositive(buyerPayment.buyer_total_amount, order.totalAmount),
    merchandise: firstPositive(buyerPayment.merchant_subtotal, income.order_selling_price, income.cost_of_goods_sold),
    shipping: pick(buyerPayment, 'shipping_fee'),
    serviceFee: pick(buyerPayment, 'buyer_service_fee'),
    transactionFee: pick(buyerPayment, 'initial_buyer_txn_fee'),
    tax: pick(buyerPayment, 'buyer_tax_amount'),
    insurance: pick(buyerPayment, 'insurance_premium'),
    packagingFee: pick(buyerPayment, 'buyer_paid_packaging_fee'),
    bulkyHandlingFee: pick(buyerPayment, 'bulky_handling_fee'),
    sellerVoucher: pick(buyerPayment, 'seller_voucher'),
    shopeeVoucher: pick(buyerPayment, 'shopee_voucher'),
    coins: pick(buyerPayment, 'shopee_coins_redeemed')
  };

  const base = firstPositive(
    income.original_cost_of_goods_sold,
    income.cost_of_goods_sold,
    income.order_selling_price,
    buyer.merchandise
  );

  const credits = {
    sellerReturnRefund: pick(income, 'seller_return_refund'),
    shopeeDiscount: pick(income, 'shopee_discount'),
    buyerPaidShipping: pick(income, 'buyer_paid_shipping_fee'),
    shopeeShippingRebate: pick(income, 'shopee_shipping_rebate'),
    shippingDiscount3PL: pick(income, 'shipping_fee_discount_from_3pl', 'shipping_fee_discount_from_pl'),
    sellerLostCompensation: pick(income, 'seller_lost_compensation'),
    rsfProtectionClaim: pick(income, 'rsf_seller_protection_fee_claim_amount'),
    fsfProtectionClaim: pick(income, 'fsf_seller_protection_fee_claim_amount'),
    buyerPaidPackagingFee: pick(income, 'buyer_paid_packaging_fee')
  };

  const deductions = {
    originalShopeeDiscount: pick(income, 'original_shopee_discount'),
    sellerVoucher: pick(income, 'voucher_from_seller'),
    sellerCoinCashback: pick(income, 'seller_coin_cash_back'),
    actualShippingFee: pick(income, 'actual_shipping_fee'),
    reverseShippingFee: pick(income, 'reverse_shipping_fee'),
    finalReturnShippingFee: pick(income, 'final_return_to_seller_shipping_fee'),
    commissionFee: pick(income, 'commission_fee'),
    serviceFee: pick(income, 'service_fee'),
    sellerTransactionFee: pick(income, 'seller_transaction_fee'),
    campaignFee: pick(income, 'campaign_fee'),
    processingFee: pick(income, 'seller_order_processing_fee'),
    affiliateFee: pick(income, 'order_ams_commission_fee'),
    adsTechnicalFee: pick(income, 'ads_escrow_top_up_fee_or_technical_support_fee'),
    escrowTax: pick(income, 'escrow_tax'),
    withholdingTax: pick(income, 'withholding_tax'),
    shippingFeeSst: pick(income, 'shipping_fee_sst'),
    reverseShippingFeeSst: pick(income, 'reverse_shipping_fee_sst'),
    finalEscrowProductGst: pick(income, 'final_escrow_product_gst'),
    sellerShippingProtectionPremium: pick(income, 'shipping_seller_protection_fee_premium_amount'),
    deliveryProtectionPremium: pick(income, 'delivery_seller_protection_fee_premium_amount'),
    overseasReturnServiceFee: pick(income, 'overseas_return_service_fee'),
    salesTaxOnLvg: pick(income, 'sales_tax_on_lvg'),
    vatOnImportedGoods: pick(income, 'vat_on_imported_goods'),
    withholdingVatTax: pick(income, 'withholding_vat_tax'),
    withholdingPitTax: pick(income, 'withholding_pit_tax'),
    withholdingCitTax: pick(income, 'withholding_cit_tax'),
    tradeInBonusSeller: pick(income, 'trade_in_bonus_seller', 'trade_in_bonus_by_seller'),
    fbsFee: pick(income, 'fbs_fee'),
    thImportDuty: pick(income, 'th_import_duty')
  };

  const knownCredits = sumObject(credits);
  const knownDeductions = sumObject(deductions);
  const expectedPayout = firstPositive(income.escrow_amount_after_adjustment, income.escrow_amount);
  const reconstructedPayout = base + knownCredits - knownDeductions;
  const reconciliationGap = expectedPayout - reconstructedPayout;
  const reconciled = expectedPayout > 0 && Math.abs(reconciliationGap) < 0.5;

  const buyerKnownGross = buyer.merchandise + buyer.shipping + buyer.serviceFee + buyer.transactionFee + buyer.tax + buyer.insurance + buyer.packagingFee + buyer.bulkyHandlingFee;
  const buyerKnownDiscounts = buyer.sellerVoucher + buyer.shopeeVoucher + buyer.coins;
  const buyerReconstructed = buyerKnownGross - buyerKnownDiscounts;
  const buyerGap = buyer.total - buyerReconstructed;

  return {
    orderSn: order.orderSn,
    buyerUsername: detail?.buyer_user_name || order.buyerUsername,
    orderStatus: order.status,
    paymentMethod: buyerPayment.buyer_payment_method || order.paymentMethod,
    currency: order.currency || 'IDR',
    escrowAvailable: true,
    escrowMessage: null,
    buyer: {
      ...buyer,
      reconstructed: buyerReconstructed,
      gap: buyerGap
    },
    settlement: {
      base,
      expectedPayout,
      knownCredits,
      knownDeductions,
      reconstructedPayout,
      reconciliationGap,
      reconciled,
      credits,
      deductions,
      totalAdjustmentAmount: pick(income, 'total_adjustment_amount'),
      escrowReleaseTime: n(detail?.escrow_release_time)
    }
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

const handleFinanceV11 = async (request, env) => {
  if (!env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY || !env.SESSION_SECRET) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const source = await getOrdersAndToken(request, env);
  if (!source.ok) return source.response;

  const orders = Array.isArray(source.payload.orders) ? source.payload.orders : [];
  const records = await mapWithConcurrency(orders, 4, async (order) => {
    const result = await shopPost(ESCROW_DETAIL_PATH, source.token, env, { order_sn: order.orderSn });
    return normalizeReconciliation(order, result);
  });

  const ready = records.filter((record) => record.escrowAvailable);
  const totals = ready.reduce((acc, record) => {
    acc.buyerPaid += n(record.buyer.total);
    acc.merchandise += n(record.buyer.merchandise);
    acc.buyerShipping += n(record.buyer.shipping);
    acc.expectedPayout += n(record.settlement.expectedPayout);
    acc.knownCredits += n(record.settlement.knownCredits);
    acc.knownDeductions += n(record.settlement.knownDeductions);
    acc.reconciliationGap += n(record.settlement.reconciliationGap);
    acc.withholdingTax += n(record.settlement.deductions.withholdingTax);
    acc.actualShippingFee += n(record.settlement.deductions.actualShippingFee);
    if (record.settlement.reconciled) acc.reconciled += 1;
    return acc;
  }, {
    buyerPaid: 0,
    merchandise: 0,
    buyerShipping: 0,
    expectedPayout: 0,
    knownCredits: 0,
    knownDeductions: 0,
    reconciliationGap: 0,
    withholdingTax: 0,
    actualShippingFee: 0,
    reconciled: 0
  });

  return json({
    ok: true,
    version: 'finance-v1.1',
    source: 'shopee',
    shopId: String(source.token.shop_id),
    tokenRefreshed: source.refreshed,
    loaded: records.length,
    escrowReady: ready.length,
    fullyReconciled: ready.length > 0 && ready.every((record) => record.settlement.reconciled),
    totals,
    records
  }, 200, source.setCookie ? { 'set-cookie': source.setCookie } : {});
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/finance-v1-1' && request.method === 'GET') {
      return handleFinanceV11(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};
