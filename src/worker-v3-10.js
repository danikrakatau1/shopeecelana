import baseWorker from './worker-v3-9.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SHOPEE_COOKIE = 'arstore_shopee';
const SHOPEE_DEFAULT_BASE = 'https://partner.shopeemobile.com';

const ADS_BALANCE_PATH = '/api/v2/ads/get_total_balance';
const ADS_TOGGLE_PATH = '/api/v2/ads/get_shop_toggle_info';
const ADS_CAMPAIGN_LIST_PATH = '/api/v2/ads/get_product_level_campaign_id_list';
const ADS_DAILY_PERFORMANCE_PATH = '/api/v2/ads/get_product_campaign_daily_performance';

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

const getFreshToken = async (request, env) => {
  const statusUrl = new URL('/api/shopee/status', request.url);
  const statusRequest = new Request(statusUrl.toString(), { method: 'GET', headers: request.headers });
  const statusResponse = await baseWorker.fetch(statusRequest, env);
  let payload = null;
  try { payload = await statusResponse.clone().json(); } catch (_) {}
  if (!statusResponse.ok || !payload?.connected) {
    return {
      ok: false,
      response: json({
        error: payload?.refreshError || payload?.error || 'shopee_not_connected',
        message: payload?.message || null
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

const numberOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const asArray = (value) => Array.isArray(value) ? value : [];

const formatShopeeDate = (date) => {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
};

const sumMetrics = (metrics = []) => metrics.reduce((acc, row) => {
  acc.impressions += numberOrZero(row?.impression);
  acc.clicks += numberOrZero(row?.clicks);
  acc.expense += numberOrZero(row?.expense);
  acc.directGmv += numberOrZero(row?.direct_gmv);
  acc.broadGmv += numberOrZero(row?.broad_gmv);
  acc.directOrders += numberOrZero(row?.direct_order);
  acc.broadOrders += numberOrZero(row?.broad_order);
  return acc;
}, { impressions: 0, clicks: 0, expense: 0, directGmv: 0, broadGmv: 0, directOrders: 0, broadOrders: 0 });

const normalizeCampaigns = (campaignList = [], fallbackCampaigns = []) => {
  const fallbackMap = new Map(fallbackCampaigns.map((campaign) => [String(campaign?.campaign_id), campaign]));
  return campaignList.map((campaign) => {
    const campaignId = String(campaign?.campaign_id || '');
    const fallback = fallbackMap.get(campaignId) || {};
    const totals = sumMetrics(asArray(campaign?.metrics_list));
    return {
      campaignId,
      adType: campaign?.ad_type || fallback?.ad_type || '—',
      placement: campaign?.campaign_placement || '—',
      name: campaign?.ad_name || `Campaign ${campaignId}`,
      impressions: totals.impressions,
      clicks: totals.clicks,
      spend: totals.expense,
      directGmv: totals.directGmv,
      broadGmv: totals.broadGmv,
      directOrders: totals.directOrders,
      broadOrders: totals.broadOrders,
      directRoas: totals.expense > 0 ? totals.directGmv / totals.expense : 0,
      broadRoas: totals.expense > 0 ? totals.broadGmv / totals.expense : 0
    };
  });
};

const handleAds = async (request, env) => {
  if (!env.SHOPEE_PARTNER_ID || !env.SHOPEE_PARTNER_KEY || !env.SESSION_SECRET) {
    return json({ error: 'shopee_not_configured' }, 503);
  }

  const fresh = await getFreshToken(request, env);
  if (!fresh.ok) return fresh.response;

  const [balanceResult, toggleResult, campaignListResult] = await Promise.all([
    shopGet(ADS_BALANCE_PATH, fresh.token, env),
    shopGet(ADS_TOGGLE_PATH, fresh.token, env),
    shopGet(ADS_CAMPAIGN_LIST_PATH, fresh.token, env, { ad_type: 'all', limit: 100, offset: 0 })
  ]);

  const probes = [balanceResult, toggleResult, campaignListResult];
  const permission = probes.some((result) => result.ok);
  const errors = [...new Set(probes.filter((result) => !result.ok).map((result) => result.message).filter(Boolean))];

  if (!permission) {
    return json({
      ok: true,
      source: 'shopee',
      shopId: String(fresh.token.shop_id),
      tokenRefreshed: fresh.refreshed,
      permission: false,
      permissionMessage: errors.join(' · ') || 'Ads API permission is not available for this application.',
      recommendation: 'Create or authorize an app with Shopee Ads Service permission for Ads API access.',
      balance: null,
      campaignCount: 0,
      campaigns: [],
      performanceAvailable: false,
      totals: { spend: 0, directGmv: 0, broadGmv: 0, directRoas: 0, broadRoas: 0, impressions: 0, clicks: 0, orders: 0 }
    }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
  }

  const balanceResponse = balanceResult.ok ? (balanceResult.data?.response || balanceResult.data || {}) : {};
  const toggleResponse = toggleResult.ok ? (toggleResult.data?.response || toggleResult.data || {}) : {};
  const campaignResponse = campaignListResult.ok ? (campaignListResult.data?.response || {}) : {};
  const campaignRefs = asArray(campaignResponse.campaign_list).slice(0, 100);
  const campaignIds = campaignRefs.map((campaign) => campaign?.campaign_id).filter(Boolean);

  let performanceResult = null;
  let campaigns = [];
  if (campaignIds.length) {
    const end = new Date();
    const start = new Date(Date.now() - (6 * 24 * 60 * 60 * 1000));
    performanceResult = await shopGet(ADS_DAILY_PERFORMANCE_PATH, fresh.token, env, {
      campaign_id_list: campaignIds.join(','),
      start_date: formatShopeeDate(start),
      end_date: formatShopeeDate(end)
    });
    if (performanceResult.ok) {
      const performanceResponse = performanceResult.data?.response || {};
      campaigns = normalizeCampaigns(asArray(performanceResponse.campaign_list), campaignRefs);
    }
  }

  if (!campaigns.length && campaignRefs.length) {
    campaigns = campaignRefs.map((campaign) => ({
      campaignId: String(campaign?.campaign_id || ''),
      adType: campaign?.ad_type || '—',
      placement: '—',
      name: `Campaign ${campaign?.campaign_id || '—'}`,
      impressions: 0,
      clicks: 0,
      spend: 0,
      directGmv: 0,
      broadGmv: 0,
      directOrders: 0,
      broadOrders: 0,
      directRoas: 0,
      broadRoas: 0
    }));
  }

  const totals = campaigns.reduce((acc, campaign) => {
    acc.spend += numberOrZero(campaign.spend);
    acc.directGmv += numberOrZero(campaign.directGmv);
    acc.broadGmv += numberOrZero(campaign.broadGmv);
    acc.impressions += numberOrZero(campaign.impressions);
    acc.clicks += numberOrZero(campaign.clicks);
    acc.orders += numberOrZero(campaign.directOrders);
    return acc;
  }, { spend: 0, directGmv: 0, broadGmv: 0, impressions: 0, clicks: 0, orders: 0 });
  totals.directRoas = totals.spend > 0 ? totals.directGmv / totals.spend : 0;
  totals.broadRoas = totals.spend > 0 ? totals.broadGmv / totals.spend : 0;

  return json({
    ok: true,
    source: 'shopee',
    shopId: String(fresh.token.shop_id),
    tokenRefreshed: fresh.refreshed,
    permission: true,
    permissionMessage: errors.length ? errors.join(' · ') : null,
    balance: balanceResult.ok ? numberOrZero(balanceResponse.total_balance) : null,
    balanceTimestamp: balanceResult.ok ? numberOrZero(balanceResponse.data_timestamp) : null,
    toggles: toggleResult.ok ? {
      autoTopUp: Boolean(toggleResponse.auto_top_up),
      campaignSurge: Boolean(toggleResponse.campaign_surge),
      dataTimestamp: numberOrZero(toggleResponse.data_timestamp)
    } : null,
    campaignCount: campaignRefs.length,
    hasNextPage: Boolean(campaignResponse.has_next_page),
    performanceAvailable: Boolean(performanceResult?.ok),
    performanceMessage: performanceResult && !performanceResult.ok ? performanceResult.message : null,
    rangeDays: 7,
    campaigns,
    totals
  }, 200, fresh.setCookie ? { 'set-cookie': fresh.setCookie } : {});
};

const injectAdsUi = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  const html = await response.text();
  if (html.includes('./ads-live-v1.js')) {
    return new Response(html, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const injected = html.replace('</body>', '  <script src="./ads-live-v1.js" defer></script>\n</body>');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');
  return new Response(injected, { status: response.status, statusText: response.statusText, headers });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/shopee/ads' && request.method === 'GET') {
      return handleAds(request, env);
    }
    const response = await baseWorker.fetch(request, env);
    if (url.pathname === '/dashboard' || url.pathname === '/dashboard/' || url.pathname.endsWith('/dashboard/index.html')) {
      return injectAdsUi(response);
    }
    return response;
  }
};
