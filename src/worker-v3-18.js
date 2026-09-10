import baseWorker from './worker-v3-17.js';

const injectSettingsLive = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();

  if (!html.includes('./settings-live-v1.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="./settings-live-v1.css" data-settings-live-v1="true" />\n</head>'
    );
  }

  if (!html.includes('./settings-live-v1.js')) {
    html = html.replace(
      '</body>',
      '  <script src="./settings-live-v1.js" defer></script>\n</body>'
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
      return injectSettingsLive(response);
    }

    return response;
  }
};
