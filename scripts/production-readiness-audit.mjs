import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });

const wrangler = read('wrangler.jsonc');
const index = read('dashboard/index.html');
const base = read('src/worker-v3.js');
const tokenHealth = read('src/worker-v3-12.js');
const worker = read('src/worker-v3-20.js');
const network = read('dashboard/network-guard-v1.js');
const homeMotionJs = read('homepage-motion-v1.js');
const homeMotionCss = read('homepage-motion-v1.css');

check('Wrangler points to worker-v3-20', wrangler.includes('"main": "./src/worker-v3-20.js"'));
check('Homepage root runs worker first', wrangler.includes('"/"') && wrangler.includes('"/index.html"'));
check('Production worker consolidates from v3-12', worker.includes("import baseWorker from './worker-v3-12.js'"));
check('Login rate limiter present', worker.includes('LOGIN_MAX_FAILURES') && worker.includes('too_many_login_attempts'));
check('Cross-origin mutation guard present', worker.includes('cross_origin_request_blocked') && worker.includes('sameOriginMutationAllowed'));
check('Login JSON/body-size validation present', worker.includes('payload_too_large') && worker.includes('content_type_required'));
check('Private no-store headers present', worker.includes("cache-control', 'no-store, max-age=0"));
check('Private clickjacking protection present', worker.includes("x-frame-options', 'DENY"));
check('HSTS present', worker.includes('strict-transport-security'));
check('Dashboard live-only response marker present', worker.includes('live-only-readiness-v1'));

const forbiddenSeeds = [
  'DEMO DATA',
  'Rp 4.850.000',
  '#AR1048',
  'Essential Chino',
  'Utility Cargo',
  'Daily Straight',
  'Save demo settings',
  'Demo operational view',
  'Demo classification'
];
for (const seed of forbiddenSeeds) check(`No legacy seed: ${seed}`, !index.includes(seed));

const expectedPanels = ['overview', 'products', 'orders', 'stock', 'logistics', 'ads', 'finance', 'connection', 'settings'];
for (const panel of expectedPanels) {
  check(`Live shell exists: ${panel}`, index.includes(`data-panel="${panel}"`) && index.includes('data-live-shell="server"'));
}

check('Seller session cookie is HttpOnly/Secure/SameSite', /arstore_session[\s\S]*HttpOnly; Secure; SameSite=Lax/.test(base));
check('Shopee token cookie is HttpOnly/Secure/SameSite', /arstore_shopee[\s\S]*HttpOnly; Secure; SameSite=Lax/.test(base));
check('Dashboard CSP blocks framing', base.includes("frame-ancestors 'none'"));
check('Token health route exists', tokenHealth.includes("'/api/shopee/token-health'"));
check('Token refresh reconnect state exists', tokenHealth.includes('shopee_reconnect_required') && tokenHealth.includes('reconnectRequired: true'));

check('Network guard has request timeout', network.includes('TIMEOUT_MS = 12000'));
check('Network guard retries transient statuses', network.includes('429') && network.includes('502') && network.includes('503') && network.includes('504'));
check('Network guard retries only guarded GET', network.includes("requestMethod(input, init) === 'GET'"));
check('Network snapshot cache available', network.includes('__ARSTORE_API_SNAPSHOT__'));

const injectedAssets = [
  'production-hardening-v1.css',
  'overview-polish-v1.css',
  'mobile-390-v1.css',
  'settings-live-v1.css',
  'readiness-hardening-v1.css',
  'network-guard-v1.js',
  'profit-intelligence-v1-1-fix.js',
  'overview-live-v1.js',
  'production-hardening-v1.js',
  'overview-polish-v1-2.js',
  'settings-live-v1.js'
];
for (const asset of injectedAssets) check(`Production injection contains ${asset}`, worker.includes(asset));

// Homepage Global Premium Motion V1: syntax, wiring, section signatures, mobile
// restraint, and accessibility are all checked without needing browser secrets.
let motionParses = true;
try { new Function(homeMotionJs); } catch (_) { motionParses = false; }
check('Homepage motion JavaScript parses', motionParses);
check('Homepage motion CSS injected at root', worker.includes('homepage-motion-v1.css') && worker.includes('isHomepagePath'));
check('Homepage motion JS injected at root', worker.includes('homepage-motion-v1.js') && worker.includes('global-premium-motion-v1'));
check('Homepage motion uses IntersectionObserver', homeMotionJs.includes('IntersectionObserver'));
check('Homepage motion uses requestAnimationFrame', homeMotionJs.includes('requestAnimationFrame'));
check('Homepage motion respects reduced motion', homeMotionJs.includes('prefers-reduced-motion') && homeMotionCss.includes('@media(prefers-reduced-motion:reduce)'));
check('Homepage motion has mobile restraint', homeMotionCss.includes('@media(max-width:640px)'));
check('Homepage motion has hero entrance', homeMotionCss.includes('motion-page-entered') && homeMotionCss.includes('.hero-display'));
check('Homepage motion has Essentials signature', homeMotionCss.includes('motion-essentials'));
check('Homepage motion has Fit signature', homeMotionCss.includes('motion-fit'));
check('Homepage motion has Most Wanted signature', homeMotionCss.includes('motion-best'));
check('Homepage motion has Spotlight narrative', homeMotionJs.includes('--spot-progress') && homeMotionCss.includes('motion-spotlight'));
check('Homepage motion has Lookbook signatures', homeMotionCss.includes('motion-lookbook'));
check('Homepage motion has Shopee cinematic sequence', homeMotionCss.includes('motion-shopee'));
check('Homepage motion has FAQ sequence', homeMotionCss.includes('motion-faq'));
check('Homepage motion has footer finale', homeMotionCss.includes('motion-footer'));

const failed = checks.filter((item) => !item.pass);
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
console.log(`\nProduction Readiness Audit: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) {
  console.error(`Failed checks: ${failed.map((item) => item.name).join(', ')}`);
  process.exit(1);
}
