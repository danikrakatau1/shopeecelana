import baseWorker from './worker-v3-15.js';

const polishDashboard = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();

  if (!html.includes('./overview-polish-v1.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="./overview-polish-v1.css" data-overview-polish-v1="true" />\n</head>'
    );
  }

  if (!html.includes('./overview-polish-v1.js')) {
    html = html.replace(
      '</body>',
      '  <script src="./overview-polish-v1.js" defer></script>\n</body>'
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');

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
      return polishDashboard(response);
    }

    return response;
  }
};
