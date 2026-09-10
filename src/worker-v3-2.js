import baseWorker from './worker-v3.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';
const MODEL_PATH = '/api/v2/product/get_model_list';
const VARIANT_LOW_STOCK_THRESHOLD = 10;

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
    try { data = JSON.parse(text); } catch (_) { return { ok: false, message: 'Shopee returned a non-JSON response' }; }
    return { ok: response.ok && !data?.error, data, message: parseShopeeError(data) };
  } catch (_) {
    return { ok: false, message: 'Shopee API unreachable' };
  }
};

const getEncryptedTokenFromSetCookie = (headers) => {
  const raw = headers.get('set-cookie') || '';
  const match = raw.match(/(?:^|,\s*)arstore_shopee=([^;]+)/i);
  return match?.[1] || null;
};

const getTokenForEnrichment = async (request, baseResponse, env) => {
  const refreshedEncrypted = getEncryptedTokenFromSetCookie(baseResponse.headers);
  const requestEncrypted = parseCookies(request)[SHOPEE_COOKIE];
  return decryptObject(refreshedEncrypted || requestEncrypted, env.SESSION_SECRET);
};

const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const normalizePrice = (model) => {
  const raw = model?.price_info ?? model?.price_info_list ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    const value = entry?.current_price ?? entry?.original_price ?? entry?.price;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return numberOrZero(model?.price);
};

const normalizeStock = (model) => {
  const v2 = model?.stock_info_v2 || {};
  const directCandidates = [
    v2?.summary_info?.total_available_stock,
    v2?.summary_info?.total_reserved_stock,
    v2?.current_stock,
    model?.normal_stock,
    model?.stock
  ];
  for (const value of directCandidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  const raw = model?.stock_info ?? v2?.seller_stock ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.reduce((sum, entry) => {
    const value = entry?.current_stock ?? entry?.normal_stock ?? entry?.stock ?? entry?.available_stock ?? 0;
    return sum + numberOrZero(value);
  }, 0);
};

const getTierOptions = (tierVariation, model) => {
  const indexes = Array.isArray(model?.tier_index) ? model.tier_index : [];
  if (!indexes.length || !Array.isArray(tierVariation)) return [];
  return indexes.map((optionIndex, tierIndex) => {
    const tier = tierVariation[tierIndex] || {};
    const rawOptions = tier.option_list ?? tier.options ?? [];
    const options = Array.isArray(rawOptions) ? rawOptions : [];
    const option = options[Number(optionIndex)] || {};
    return {
      tier: tier.name || tier.tier_name || `Variant ${tierIndex + 1}`,
      value: option.option || option.option_name || option.name || String(optionIndex)
    };
  });
};

const normalizeVariant = (model, tierVariation, index) => {
  const options = getTierOptions(tierVariation, model);
  const optionLabel = options.map((option) => option.value).filter(Boolean).join(' / ');
  return {
    modelId: String(model?.model_id ?? model?.id ?? index),
    name: model?.model_name || model?.name || optionLabel || `Variant ${index + 1}`,
    sku: model?.model_sku || model?.seller_sku || model?.sku || '—',
    price: normalizePrice(model),
    stock: normalizeStock(model),
    status: model?.model_status || model?.status || 'NORMAL',
    tierIndex: Array.isArray(model?.tier_index) ? model.tier_index : [],
    options
  };
};

const summarizeVariants = (product, variants) => {
  if (!variants.length) {
    return {
      ...product,
      variants: [],
      variantCount: 0,
      variantSync: false,
      priceMin: numberOrZero(product.price),
      priceMax: numberOrZero(product.price),
      lowStockVariantCount: 0
    };
  }

  const positivePrices = variants.map((variant) => numberOrZero(variant.price)).filter((price) => price > 0);
  const priceMin = positivePrices.length ? Math.min(...positivePrices) : numberOrZero(product.price);
  const priceMax = positivePrices.length ? Math.max(...positivePrices) : numberOrZero(product.price);
  const totalStock = variants.reduce((sum, variant) => sum + numberOrZero(variant.stock), 0);
  const lowStockVariantCount = variants.filter((variant) => numberOrZero(variant.stock) <= VARIANT_LOW_STOCK_THRESHOLD).length;

  return {
    ...product,
    price: priceMin,
    priceMin,
    priceMax,
    stock: totalStock,
    variants,
    variantCount: variants.length,
    variantSync: true,
    lowStockVariantCount
  };
};

const enrichOneProduct = async (product, token, env) => {
  if (!product?.hasModel || !product?.itemId) return summarizeVariants(product, []);

  const result = await shopGet(MODEL_PATH, token, env, { item_id: product.itemId });
  if (!result.ok) {
    return {
      ...summarizeVariants(product, []),
      variantError: result.message || 'Model list request failed'
    };
  }

  const response = result.data?.response || {};
  const rawModels = response.model ?? response.model_list ?? [];
  const models = Array.isArray(rawModels) ? rawModels : [];
  const tierVariation = Array.isArray(response.tier_variation) ? response.tier_variation : [];
  const variants = models.map((model, index) => normalizeVariant(model, tierVariation, index));
  return summarizeVariants(product, variants);
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

const enrichProductResponse = async (request, env) => {
  const baseResponse = await baseWorker.fetch(request.clone(), env);
  if (!baseResponse.ok) return baseResponse;

  let payload;
  try {
    payload = await baseResponse.clone().json();
  } catch (_) {
    return baseResponse;
  }

  if (!payload?.ok || !Array.isArray(payload.products) || !payload.products.some((product) => product?.hasModel)) {
    return baseResponse;
  }

  const token = await getTokenForEnrichment(request, baseResponse, env);
  if (!token?.access_token || !token?.shop_id || !env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY) {
    return baseResponse;
  }

  const products = await mapWithConcurrency(payload.products, 5, (product) => enrichOneProduct(product, token, env));
  const variantCount = products.reduce((sum, product) => sum + numberOrZero(product.variantCount), 0);
  const lowStockVariantCount = products.reduce((sum, product) => sum + numberOrZero(product.lowStockVariantCount), 0);
  const lowStockProductCount = products.filter((product) =>
    product.variantCount > 0
      ? product.lowStockVariantCount > 0
      : numberOrZero(product.stock) <= VARIANT_LOW_STOCK_THRESHOLD
  ).length;

  const headers = new Headers(baseResponse.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store, max-age=0');

  return new Response(JSON.stringify({
    ...payload,
    products,
    variantEnrichment: true,
    variantCount,
    lowStockVariantCount,
    lowStockProductCount
  }), {
    status: baseResponse.status,
    headers
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/products' && request.method === 'GET') {
      return enrichProductResponse(request, env);
    }
    return baseWorker.fetch(request, env);
  }
};
