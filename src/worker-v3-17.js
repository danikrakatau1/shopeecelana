import baseWorker from './worker-v3-16.js';

const injectMobile390 = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  let html = await response.text();
  if (!html.includes('./mobile-390-v1.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="./mobile-390-v1.css" data-mobile-390-v1="true" />\n</head>'
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
      return injectMobile390(response);
    }

    return response;
  }
};
