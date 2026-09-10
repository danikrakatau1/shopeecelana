import baseWorker from './worker-v3-18.js';

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

const LIVE_PANEL_RE = /<section class="view([^"]*)" data-panel="(overview|products|orders|stock|logistics|ads|finance|connection|settings)">[\s\S]*?<\/section>/g;

const cleanDashboardHtml = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();

  // Remove all static seed/demo panel bodies from the response delivered to the
  // browser. The panel nodes remain so the existing live modules can hydrate
  // them normally. If a module is delayed, the user sees a truthful loading
  // state instead of fabricated commerce data.
  html = html.replace(LIVE_PANEL_RE, (_match, classSuffix, panelName) => {
    const label = PANEL_LABELS[panelName] || panelName;
    return `<section class="view${classSuffix}" data-panel="${panelName}" data-live-shell="server">
        <div class="panel live-panel-shell" role="status" aria-live="polite">
          <div class="live-panel-shell-inner">
            <span class="live-panel-shell-dot" aria-hidden="true"></span>
            <strong>Loading ${label}</strong>
            <small>Preparing live seller data. No demo values are shown.</small>
          </div>
        </div>
      </section>`;
  });

  // Eliminate legacy chrome that could flash before the production JS runs.
  html = html.replace(/>DEMO DATA</g, '>SHOPEE API<');
  html = html.replace(/<small>Belum terhubung<\/small>/g, '<small>Checking connection…</small>');
  html = html.replace(/\s*<button class="icon-button" type="button" aria-label="Notifikasi">○<\/button>/g, '');

  if (!html.includes('./final-live-shell-v1.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="./final-live-shell-v1.css" data-final-live-shell-v1="true" />\n</head>'
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-arstore-dashboard', 'live-only-v1');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await baseWorker.fetch(request, env);

    if (
      url.pathname === '/dashboard' ||
      url.pathname === '/dashboard/' ||
      url.pathname.endsWith('/dashboard/index.html')
    ) {
      return cleanDashboardHtml(response);
    }

    return response;
  }
};
