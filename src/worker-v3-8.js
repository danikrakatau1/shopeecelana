import baseWorker from './worker-v3-7.js';

const injectFinanceUi = async (response) => {
  if (!response.ok) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const html = await response.text();
  if (html.includes('./finance-v1.js')) {
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  const injected = html.replace(
    '</body>',
    '  <script src="./finance-v1.js" defer></script>\n</body>'
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store, max-age=0');
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await baseWorker.fetch(request, env);
    if (url.pathname === '/dashboard' || url.pathname === '/dashboard/' || url.pathname.endsWith('/dashboard/index.html')) {
      return injectFinanceUi(response);
    }
    return response;
  }
};
