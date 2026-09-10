(() => {
  if (window.__ARSTORE_NETWORK_GUARD_V1__) return;
  window.__ARSTORE_NETWORK_GUARD_V1__ = true;

  const nativeFetch = window.fetch.bind(window);
  const API_PREFIX = '/api/shopee/';
  const TIMEOUT_MS = 12000;
  const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
  const snapshotStore = new Map();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const asUrl = (input) => {
    try {
      if (input instanceof Request) return new URL(input.url, location.href);
      return new URL(String(input), location.href);
    } catch (_) {
      return null;
    }
  };
  const requestMethod = (input, init) => String(init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
  const isGuardedGet = (input, init) => {
    const url = asUrl(input);
    return Boolean(url && url.origin === location.origin && url.pathname.startsWith(API_PREFIX) && requestMethod(input, init) === 'GET');
  };

  const emit = (name, detail = {}) => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  };

  const storeSnapshot = async (url, response) => {
    if (!response?.ok) return;
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) return;
    try {
      const data = await response.clone().json();
      snapshotStore.set(url.toString(), { data, at: Date.now(), status: response.status });
      if (snapshotStore.size > 30) {
        const oldest = [...snapshotStore.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, snapshotStore.size - 30);
        oldest.forEach(([key]) => snapshotStore.delete(key));
      }
    } catch (_) {}
  };

  window.__ARSTORE_API_SNAPSHOT__ = {
    get(input) {
      const url = asUrl(input);
      if (!url) return null;
      return snapshotStore.get(url.toString()) || null;
    },
    find(pathPrefix) {
      const matches = [...snapshotStore.entries()]
        .filter(([key]) => {
          try { return new URL(key).pathname.startsWith(pathPrefix); } catch (_) { return false; }
        })
        .sort((a, b) => b[1].at - a[1].at);
      return matches[0]?.[1] || null;
    }
  };

  const makeAbortSignal = (sourceSignal) => {
    const controller = new AbortController();
    let sourceAbort = null;
    if (sourceSignal) {
      sourceAbort = () => controller.abort(sourceSignal.reason || new DOMException('Aborted', 'AbortError'));
      if (sourceSignal.aborted) sourceAbort();
      else sourceSignal.addEventListener('abort', sourceAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new DOMException('AR STORE API timeout', 'TimeoutError')), TIMEOUT_MS);
    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timer);
        if (sourceSignal && sourceAbort) sourceSignal.removeEventListener('abort', sourceAbort);
      }
    };
  };

  const retryDelay = (response, attempt) => {
    const retryAfter = Number(response?.headers?.get('retry-after') || 0);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(2000, retryAfter * 1000);
    return 300 + (attempt * 350);
  };

  const guardedFetch = async (input, init = {}) => {
    if (!isGuardedGet(input, init)) return nativeFetch(input, init);

    const url = asUrl(input);
    const sourceSignal = init?.signal || (input instanceof Request ? input.signal : null);
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const abort = makeAbortSignal(sourceSignal);
      try {
        const response = await nativeFetch(input, { ...init, signal: abort.signal });
        abort.cleanup();
        void storeSnapshot(url, response);

        if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
          emit('arstore:api-retry', { url: url.pathname, status: response.status, attempt: 1 });
          await sleep(retryDelay(response, attempt));
          continue;
        }

        if (!response.ok) {
          emit('arstore:api-failure', { url: url.pathname, status: response.status, kind: response.status === 429 ? 'rate-limit' : 'http' });
        } else {
          emit('arstore:api-recovered', { url: url.pathname, status: response.status });
        }
        return response;
      } catch (error) {
        abort.cleanup();
        lastError = error;
        const kind = !navigator.onLine ? 'offline' : (error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'timeout' : 'network');
        if (attempt === 0 && navigator.onLine && !sourceSignal?.aborted) {
          emit('arstore:api-retry', { url: url.pathname, status: 0, attempt: 1, kind });
          await sleep(350);
          continue;
        }
        emit('arstore:api-failure', { url: url.pathname, status: 0, kind });
        throw error;
      }
    }

    throw lastError || new Error('Shopee API request failed');
  };

  window.fetch = guardedFetch;

  const ensureBanner = () => {
    if (document.getElementById('networkGuardBanner')) return document.getElementById('networkGuardBanner');
    const banner = document.createElement('div');
    banner.id = 'networkGuardBanner';
    banner.className = 'network-guard-banner';
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = '<span class="network-guard-dot"></span><div><strong id="networkGuardTitle">API connection issue</strong><small id="networkGuardText">Shopee data may be temporarily unavailable.</small></div>';
    const topbar = document.querySelector('.topbar');
    if (topbar?.parentNode) topbar.parentNode.insertBefore(banner, topbar.nextSibling);
    else document.body.prepend(banner);
    return banner;
  };

  const showBanner = (title, text, state = 'warning') => {
    const banner = ensureBanner();
    banner.dataset.state = state;
    banner.querySelector('#networkGuardTitle').textContent = title;
    banner.querySelector('#networkGuardText').textContent = text;
    banner.hidden = false;
  };
  const hideBanner = () => {
    const banner = document.getElementById('networkGuardBanner');
    if (banner) banner.hidden = true;
  };

  window.addEventListener('arstore:api-failure', (event) => {
    const detail = event.detail || {};
    if (detail.kind === 'offline') showBanner('OFFLINE', 'Internet connection is unavailable. Existing dashboard data is preserved.', 'error');
    else if (detail.kind === 'timeout') showBanner('API TIMEOUT', 'Shopee API did not respond in time. A safe retry was attempted.', 'warning');
    else if (detail.kind === 'rate-limit') showBanner('SHOPEE RATE LIMITED', 'Request was throttled by Shopee. Retry after a short delay.', 'warning');
    else if (detail.status >= 500 || detail.status === 0) showBanner('API TEMPORARILY UNAVAILABLE', 'Shopee data could not be refreshed. Try Sync again shortly.', 'warning');
  });
  window.addEventListener('arstore:api-recovered', () => setTimeout(hideBanner, 800));
  window.addEventListener('offline', () => showBanner('OFFLINE', 'Internet connection is unavailable. Existing dashboard data is preserved.', 'error'));
  window.addEventListener('online', () => setTimeout(hideBanner, 800));
})();