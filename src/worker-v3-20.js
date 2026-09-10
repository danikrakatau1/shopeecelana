import baseWorker from './worker-v3-12.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();

const PANEL_LABELS = {
  overview: 'Overview',
  products: 'Products',
  orders: 'Orders',
  stock: 'Stock & Pricing',
  logistics: 'Logistics',
  ads: 'Shopee Ads',
  finance: 'Finance',
  connection: 'Shopee Connection',
  settings: 'Settings'
};

const LIVE_PANEL_RE = /<section class="view([^"]*)" data-panel="(overview|products|orders|stock|logistics|ads|finance|connection|settings)"[^>]*>[\s\S]*?<\/section>/g;
const PRIVATE_PATH_RE = /^(?:\/dashboard(?:\/|$)|\/seller-login(?:\/|$)|\/api\/|\/shopee\/callback$)/;
const SAFE_MUTATION_FETCH_SITES = new Set(['same-origin', 'none']);

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    ...extraHeaders
  }
});

const isDashboardPath = (pathname) =>
  pathname === '/dashboard' || pathname === '/dashboard/' || pathname.endsWith('/dashboard/index.html');

const isStateChanging = (request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());

const sameOriginMutationAllowed = (request, url) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !SAFE_MUTATION_FETCH_SITES.has(fetchSite)) return false;
  return true;
};

const clientKey = (request) => {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return String(ip).slice(0, 128);
};

const pruneLoginFailures = (now = Date.now()) => {
  if (loginFailures.size < 256) return;
  for (const [key, value] of loginFailures) {
    if (!value || value.resetAt <= now) loginFailures.delete(key);
  }
};

const loginLimitState = (request) => {
  const now = Date.now();
  pruneLoginFailures(now);
  const key = clientKey(request);
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= now) return { key, blocked: false, remainingSeconds: 0 };
  return {
    key,
    blocked: current.count >= LOGIN_MAX_FAILURES,
    remainingSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
};

const recordLoginFailure = (key) => {
  const now = Date.now();
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
  loginFailures.set(key, current);
};

const clearLoginFailures = (key) => loginFailures.delete(key);

const validateRequest = (request, url) => {
  if (url.pathname.startsWith('/api/') && isStateChanging(request) && !sameOriginMutationAllowed(request, url)) {
    return json({ error: 'cross_origin_request_blocked' }, 403);
  }

  // OAuth initiation is a GET but changes authorization state. Cross-site links
  // cannot silently start a seller authorization flow.
  if (url.pathname === '/api/shopee/connect') {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if ((origin && origin !== url.origin) || (fetchSite && !SAFE_MUTATION_FETCH_SITES.has(fetchSite))) {
      return json({ error: 'cross_origin_request_blocked' }, 403);
    }
  }

  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > 8192) return json({ error: 'payload_too_large' }, 413);
    const type = request.headers.get('content-type') || '';
    if (!type.toLowerCase().includes('application/json')) return json({ error: 'content_type_required' }, 415);
    const limit = loginLimitState(request);
    if (limit.blocked) {
      return json({ error: 'too_many_login_attempts', retryAfter: limit.remainingSeconds }, 429, {
        'retry-after': String(limit.remainingSeconds)
      });
    }
  }

  return null;
};

const ensureAsset = (html, marker, markup, location = 'head') => {
  if (html.includes(marker)) return html;
  return html.replace(location === 'head' ? '</head>' : '</body>', `${markup}\n${location === 'head' ? '</head>' : '</body>'}`);
};

const prepareDashboard = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();

  // Defense in depth: the browser never receives static commerce numbers. Each
  // live module hydrates the preserved panel node after the document loads.
  html = html.replace(LIVE_PANEL_RE, (_match, classSuffix, panelName) => {
    const label = PANEL_LABELS[panelName] || panelName;
    return `<section class="view${classSuffix}" data-panel="${panelName}" data-live-shell="server">
        <div class="panel live-panel-shell" role="status" aria-live="polite">
          <div class="live-panel-shell-inner">
            <span class="live-panel-shell-dot" aria-hidden="true"></span>
            <strong>Loading ${label}</strong>
            <small>Preparing live seller data. Waiting for the connected API source.</small>
          </div>
        </div>
      </section>`;
  });
  html = html.replace(/>DEMO DATA</g, '>SHOPEE API<');
  html = html.replace(/<small>Belum terhubung<\/small>/g, '<small>Checking connection…</small>');
  html = html.replace(/\s*<button class="icon-button" type="button" aria-label="Notifikasi">○<\/button>/g, '');

  const headAssets = [
    ['./final-live-shell-v1.css', '  <link rel="stylesheet" href="./final-live-shell-v1.css" data-final-live-shell-v1="true" />'],
    ['./production-hardening-v1.css', '  <link rel="stylesheet" href="./production-hardening-v1.css" data-production-hardening-v1="true" />'],
    ['./overview-polish-v1.css', '  <link rel="stylesheet" href="./overview-polish-v1.css" data-overview-polish-v1="true" />'],
    ['./mobile-390-v1.css', '  <link rel="stylesheet" href="./mobile-390-v1.css" data-mobile-390-v1="true" />'],
    ['./settings-live-v1.css', '  <link rel="stylesheet" href="./settings-live-v1.css" data-settings-live-v1="true" />'],
    ['./readiness-hardening-v1.css', '  <link rel="stylesheet" href="./readiness-hardening-v1.css" data-readiness-hardening-v1="true" />'],
    ['./network-guard-v1.js', '  <script src="./network-guard-v1.js" defer data-network-guard-v1="true"></script>']
  ];
  headAssets.forEach(([marker, markup]) => { html = ensureAsset(html, marker, markup, 'head'); });

  // worker-v3-12 already includes Profit Intelligence V1 through v3-11. The
  // remaining presentation modules are injected once here instead of passing
  // the HTML through seven additional wrapper workers.
  const bodyScripts = [
    ['./profit-intelligence-v1-1-fix.js', '  <script src="./profit-intelligence-v1-1-fix.js" defer></script>'],
    ['./overview-live-v1.js', '  <script src="./overview-live-v1.js" defer></script>'],
    ['./production-hardening-v1.js', '  <script src="./production-hardening-v1.js" defer></script>'],
    ['./overview-polish-v1-2.js', '  <script src="./overview-polish-v1-2.js" defer></script>'],
    ['./settings-live-v1.js', '  <script src="./settings-live-v1.js" defer></script>']
  ];
  bodyScripts.forEach(([marker, markup]) => { html = ensureAsset(html, marker, markup, 'body'); });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-arstore-dashboard', 'live-only-readiness-v1');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const hardenResponse = (response, url) => {
  const headers = new Headers(response.headers);
  const isPrivate = PRIVATE_PATH_RE.test(url.pathname);
  if (isPrivate) {
    headers.set('cache-control', 'no-store, max-age=0');
    headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
    headers.set('vary', headers.get('vary') ? `${headers.get('vary')}, Cookie` : 'Cookie');
  }
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-permitted-cross-domain-policies', 'none');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  headers.set('x-arstore-hardening', 'production-readiness-v1');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rejected = validateRequest(request, url);
    if (rejected) return hardenResponse(rejected, url);

    const isLogin = url.pathname === '/api/auth/login' && request.method === 'POST';
    const loginState = isLogin ? loginLimitState(request) : null;

    let response = await baseWorker.fetch(request, env);

    if (isLogin && loginState) {
      if (response.status === 401 || response.status === 400) recordLoginFailure(loginState.key);
      else if (response.ok) clearLoginFailures(loginState.key);
    }

    if (isDashboardPath(url.pathname)) response = await prepareDashboard(response);
    return hardenResponse(response, url);
  }
};
