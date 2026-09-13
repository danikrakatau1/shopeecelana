import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const wrangler = read('wrangler.jsonc');
const base = read('src/worker-v3.js');
const prod = read('src/worker-v3-20.js');
const readiness = read('scripts/production-readiness-audit.mjs');
const runbook = read('GO-LIVE-RUNBOOK.md');
const reviewerUi = read('dashboard/reviewer-readonly-v1.js');
const reviewerCss = read('dashboard/reviewer-readonly-v1.css');

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check('Frozen production worker remains v3-20', /"main"\s*:\s*"\.\/src\/worker-v3-20\.js"/.test(wrangler));
check('Cloudflare keep_vars remains enabled', /"keep_vars"\s*:\s*true/.test(wrangler));
check('Cloudflare observability remains enabled', /"observability"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/.test(wrangler));
check('SELLER_PASSWORD is declared as required secret', wrangler.includes('"SELLER_PASSWORD"'));
check('SESSION_SECRET is declared as required secret', wrangler.includes('"SESSION_SECRET"'));
check('SHOPEE_PARTNER_KEY is declared as required secret', wrangler.includes('"SHOPEE_PARTNER_KEY"'));
check('Private dashboard route runs Worker first', wrangler.includes('"/dashboard/*"'));
check('Shopee/API routes run Worker first', wrangler.includes('"/api/*"') && wrangler.includes('"/shopee/*"'));

check('Shopee base can be overridden by environment', /env\.SHOPEE_API_BASE\s*\|\|\s*SHOPEE_DEFAULT_BASE/.test(base));
check('Shopee Partner ID comes from environment', base.includes('env.SHOPEE_PARTNER_ID'));
check('Shopee Partner Key comes from environment', base.includes('env.SHOPEE_PARTNER_KEY'));
check('Shopee redirect URL can be configured by environment', base.includes('env.SHOPEE_REDIRECT_URL'));
check('Default callback falls back to deployed Worker origin', base.includes("`${new URL(request.url).origin}/shopee/callback`"));
check('Shopee tokens are encrypted with SESSION_SECRET', base.includes('encryptObject') && base.includes('decryptObject') && base.includes('env.SESSION_SECRET'));
check('Shopee token cookie is HttpOnly/Secure/SameSite', /SHOPEE_COOKIE[\s\S]*HttpOnly; Secure; SameSite=Lax/.test(base));
check('Seller session cookie is HttpOnly/Secure/SameSite', /SESSION_COOKIE[\s\S]*HttpOnly; Secure; SameSite=Lax/.test(base));
check('Token refresh path exists', base.includes('/api/v2/auth/access_token/get'));
check('Production worker blocks cross-origin API mutations', prod.includes('cross_origin_request_blocked') && prod.includes('sameOriginMutationAllowed'));
check('Production worker has login rate limiting', prod.includes('LOGIN_MAX_FAILURES') && prod.includes('too_many_login_attempts'));
check('Production worker preserves no-store private responses', prod.includes("headers.set('cache-control', 'no-store, max-age=0')"));

check('Reviewer username is environment-configurable', prod.includes('env.SHOPEE_REVIEWER_USERNAME'));
check('Reviewer password is read only from environment', prod.includes('env.SHOPEE_REVIEWER_PASSWORD'));
check('Reviewer login remains optional until its secret exists', prod.includes('reviewerLoginEnabled') && prod.includes('env.SHOPEE_REVIEWER_PASSWORD'));
check('Reviewer session is signed with SESSION_SECRET', prod.includes('createReviewerSessionToken') && prod.includes("crypto.subtle.sign('HMAC'"));
check('Reviewer session signature is verified before authorization', prod.includes('verifySessionPayload') && prod.includes("crypto.subtle.verify('HMAC'"));
check('Reviewer session stays compatible with private dashboard auth', /sub:\s*'owner'[\s\S]*role:\s*'reviewer'/.test(prod));
check('Reviewer session is explicitly read-only', /role:\s*'reviewer'[\s\S]*readOnly:\s*true/.test(prod));
check('Reviewer blocks state-changing API requests', prod.includes('isReviewerBlockedAction') && prod.includes("url.pathname.startsWith('/api/') && isStateChanging(request)"));
check('Reviewer cannot start or complete Shopee OAuth', prod.includes("url.pathname === '/api/shopee/connect'") && prod.includes("url.pathname === '/shopee/callback'"));
check('Reviewer can still log out', prod.includes("url.pathname === '/api/auth/logout'") && prod.includes('return false'));
check('Reviewer session endpoint exposes reviewer role', prod.includes('reviewerSessionResponse') && prod.includes("role: 'reviewer'"));
check('Reviewer dashboard CSS is injected', prod.includes('./reviewer-readonly-v1.css'));
check('Reviewer dashboard JS is injected', prod.includes('./reviewer-readonly-v1.js'));
check('Reviewer UI confirms read-only mode from server session', reviewerUi.includes("session?.user?.role !== 'reviewer'") && reviewerUi.includes('session?.readOnly'));
check('Reviewer UI displays a read-only review badge', reviewerUi.includes('Shopee Review Mode') && reviewerCss.includes('.reviewer-readonly-pill'));

const obviousSecretPatterns = [
  /SHOPEE_PARTNER_KEY\s*=\s*['"][^'"]{8,}['"]/,
  /SESSION_SECRET\s*=\s*['"][^'"]{8,}['"]/,
  /SELLER_PASSWORD\s*=\s*['"][^'"]{4,}['"]/,
  /SHOPEE_REVIEWER_PASSWORD\s*=\s*['"][^'"]{4,}['"]/,
  /access_token\s*:\s*['"][A-Za-z0-9._-]{16,}['"]/,
  /refresh_token\s*:\s*['"][A-Za-z0-9._-]{16,}['"]/,
];
const sourceBundle = [wrangler, base, prod, readiness, runbook, reviewerUi, reviewerCss].join('\n');
check('No obvious committed secret/token literals in audited go-live files', !obviousSecretPatterns.some((pattern) => pattern.test(sourceBundle)));

check('Go-Live runbook requires manual app approval gate', /Gate 1 — Shopee application approval/.test(runbook));
check('Go-Live runbook forbids API Test Tool token ownership conflict', /Do not use Shopee API Test Tool/.test(runbook));
check('Go-Live runbook requires verified endpoint configuration', /Do not guess the production or sandbox hostname/.test(runbook));
check('Go-Live runbook preserves SESSION_SECRET during cutover', /Do not rotate `SESSION_SECRET` at the same time/.test(runbook));
check('Go-Live runbook requires real seller validation', /Gate 4 — Live seller validation/.test(runbook));
check('Go-Live runbook contains rollback procedure', /Gate 6 — Failure and rollback plan/.test(runbook));
check('Go-Live acceptance requires real settlement cross-check', /real order\/settlement cross-check matches Seller Centre/.test(runbook));

const failures = checks.filter((item) => !item.pass);
console.log(`\nGo-Live Preflight: ${checks.length - failures.length}/${checks.length} PASS`);
if (failures.length) {
  console.error('\nFailures:');
  failures.forEach((item) => console.error(`- ${item.name}${item.detail ? ` — ${item.detail}` : ''}`));
  process.exit(1);
}
