import baseWorker from './worker-v3-12.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const REVIEWER_SESSION_TTL = 60 * 60 * 12;
const SESSION_COOKIE = 'arstore_session';
const loginFailures = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

const isHomepagePath = (pathname) => pathname === '/' || pathname === '/index.html';

const isStateChanging = (request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());

const sameOriginMutationAllowed = (request, url) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !SAFE_MUTATION_FETCH_SITES.has(fetchSite)) return false;
  return true;
};

const safeEqual = (a = '', b = '') => {
  const aBytes = encoder.encode(String(a));
  const bBytes = encoder.encode(String(b));
  const length = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < length; i += 1) diff |= (aBytes[i] || 0) ^ (bBytes[i] || 0);
  return diff === 0;
};

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

const importHmacKey = (secret) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const parseCookies = (request) => {
  const header = request.headers.get('cookie') || '';
  return Object.fromEntries(
    header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=');
      return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
    })
  );
};

const createReviewerSessionToken = async (secret, username) => {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'owner',
    role: 'reviewer',
    username,
    readOnly: true,
    iat: now,
    exp: now + REVIEWER_SESSION_TTL,
    nonce: crypto.randomUUID()
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${base64UrlEncode(signature)}`;
};

const verifySessionPayload = async (token, secret) => {
  if (!token || !secret || !token.includes('.')) return null;
  const [body, signature] = token.split('.', 2);
  try {
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64UrlDecode(body)));
    const now = Math.floor(Date.now() / 1000);
    if (payload?.sub !== 'owner' || !payload?.exp || payload.exp <= now) return null;
    return payload;
  } catch (_) {
    return null;
  }
};

const getSessionPayload = async (request, env) => {
  if (!env.SESSION_SECRET) return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  return verifySessionPayload(token, env.SESSION_SECRET);
};

const reviewerSessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${REVIEWER_SESSION_TTL}`;

const reviewerUsername = (env) => String(env.SHOPEE_REVIEWER_USERNAME || 'shopee_reviewer').trim().toLowerCase();
const ownerUsername = (env) => String(env.SELLER_USERNAME || 'owner').trim().toLowerCase();

const reviewerLoginEnabled = (env) => {
  const reviewer = reviewerUsername(env);
  return Boolean(
    env.SHOPEE_REVIEWER_PASSWORD &&
    env.SESSION_SECRET &&
    reviewer &&
    reviewer !== ownerUsername(env)
  );
};

const handleReviewerLogin = async (request, env) => {
  let body;
  try { body = await request.clone().json(); } catch (_) { return null; }

  const username = String(body?.username || '').trim().toLowerCase();
  const expectedUsername = reviewerUsername(env);
  if (!reviewerLoginEnabled(env) || !safeEqual(username, expectedUsername)) return null;

  const password = String(body?.password || '');
  if (!safeEqual(password, env.SHOPEE_REVIEWER_PASSWORD)) {
    return json({ error: 'invalid_credentials' }, 401);
  }

  const token = await createReviewerSessionToken(env.SESSION_SECRET, expectedUsername);
  return json({
    ok: true,
    user: { role: 'reviewer', username: expectedUsername, readOnly: true },
    expiresIn: REVIEWER_SESSION_TTL
  }, 200, {
    'set-cookie': reviewerSessionCookie(token),
    'x-arstore-reviewer-mode': 'read-only'
  });
};

const isReviewerBlockedAction = (request, url) => {
  if (url.pathname === '/api/auth/logout') return false;
  if (url.pathname === '/api/shopee/connect' || url.pathname === '/shopee/callback') return true;
  return url.pathname.startsWith('/api/') && isStateChanging(request);
};

const reviewerReadOnlyResponse = () => json({
  error: 'reviewer_read_only',
  message: 'Shopee reviewer access is read-only. Seller-changing actions are blocked.'
}, 403, {
  'x-arstore-reviewer-mode': 'read-only'
});

const reviewerSessionResponse = (payload, env) => json({
  authenticated: true,
  user: {
    role: 'reviewer',
    username: payload?.username || reviewerUsername(env)
  },
  expiresAt: payload?.exp || null,
  readOnly: true
}, 200, {
  'x-arstore-reviewer-mode': 'read-only'
});

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

const prepareHomepage = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  html = ensureAsset(
    html,
    'homepage-overflow-guard-v1.css',
    '  <link rel="stylesheet" href="/homepage-overflow-guard-v1.css" data-homepage-overflow-guard-v1="true" />',
    'head'
  );
  html = ensureAsset(
    html,
    'homepage-motion-v1.css',
    '  <link rel="stylesheet" href="/homepage-motion-v1.css" data-homepage-motion-v1="true" />',
    'head'
  );
  html = ensureAsset(
    html,
    'homepage-motion-v1.js',
    '  <script src="/homepage-motion-v1.js" defer data-homepage-motion-v1="true"></script>',
    'body'
  );

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('x-arstore-home-motion', 'global-premium-motion-v1');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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
    ['./reviewer-readonly-v1.css', '  <link rel="stylesheet" href="./reviewer-readonly-v1.css" data-reviewer-readonly-v1="true" />'],
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
    ['./settings-live-v1.js', '  <script src="./settings-live-v1.js" defer></script>'],
    ['./reviewer-readonly-v1.js', '  <script src="./reviewer-readonly-v1.js" defer data-reviewer-readonly-v1="true"></script>']
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
    const sessionPayload = await getSessionPayload(request, env);
    const isReviewer = sessionPayload?.role === 'reviewer' && sessionPayload?.readOnly === true;

    if (isReviewer && url.pathname === '/api/auth/session' && request.method === 'GET') {
      return hardenResponse(reviewerSessionResponse(sessionPayload, env), url);
    }

    if (isReviewer && isReviewerBlockedAction(request, url)) {
      return hardenResponse(reviewerReadOnlyResponse(), url);
    }

    let response = null;

    if (isLogin) response = await handleReviewerLogin(request, env);
    if (!response) response = await baseWorker.fetch(request, env);

    if (isLogin && loginState) {
      if (response.status === 401 || response.status === 400) recordLoginFailure(loginState.key);
      else if (response.ok) clearLoginFailures(loginState.key);
    }

    if (isDashboardPath(url.pathname)) response = await prepareDashboard(response);
    else if (isHomepagePath(url.pathname)) response = await prepareHomepage(response);

    return hardenResponse(response, url);
  }
};
