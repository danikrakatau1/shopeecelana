import baseWorker from './worker-v3-14.js';

const hardenDashboard = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  html = html.replace(/>DEMO DATA</g, '>SHOPEE API<');

  if (!html.includes('./production-hardening-v1.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="./production-hardening-v1.css" data-production-hardening-v1="true" />\n</head>'
    );
  }

  if (!html.includes('./production-hardening-v1.js')) {
    html = html.replace(
      '</body>',
      '  <script src="./production-hardening-v1.js" defer></script>\n</body>'
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('x-permitted-cross-domain-policies', 'none');

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
      return hardenDashboard(response);
    }

    return response;
  }
};
