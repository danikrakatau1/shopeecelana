(() => {
  if (window.__ARSTORE_PRODUCTION_HARDENING_V1__) return;
  window.__ARSTORE_PRODUCTION_HARDENING_V1__ = true;

  document.body.dataset.productionHardened = 'v1';

  const badge = document.querySelector('.demo-badge');
  const notificationPlaceholder = document.querySelector('.topbar-actions .icon-button[aria-label="Notifikasi"]');
  if (badge) {
    badge.textContent = 'SHOPEE API';
    badge.classList.add('live-shopee-badge');
    badge.title = 'Dashboard memakai data Shopee API dan HPP internal';
  }
  // Notification center has not been implemented yet; do not expose a dead production control.
  if (notificationPlaceholder) notificationPlaceholder.hidden = true;

  const main = document.querySelector('.dashboard-main');
  const topbar = document.querySelector('.topbar');
  let lastHealthCheck = 0;
  let healthInFlight = false;
  const HEALTH_THROTTLE = 5 * 60 * 1000;

  const health = document.createElement('aside');
  health.className = 'production-health';
  health.id = 'productionHealth';
  health.hidden = true;
  health.setAttribute('role', 'status');
  health.setAttribute('aria-live', 'polite');
  health.innerHTML = `
    <div class="production-health-inner">
      <div class="production-health-copy">
        <span class="production-health-dot" aria-hidden="true"></span>
        <div><strong id="productionHealthTitle">Shopee connection</strong><small id="productionHealthCopy">Checking connection…</small></div>
      </div>
      <button id="productionHealthAction" type="button">Retry</button>
    </div>`;
  if (main && topbar) topbar.insertAdjacentElement('afterend', health);

  const title = health.querySelector('#productionHealthTitle');
  const copy = health.querySelector('#productionHealthCopy');
  const action = health.querySelector('#productionHealthAction');
  let actionMode = 'retry';

  const setHealth = ({ state = 'healthy', heading = '', message = '', actionLabel = '', mode = 'retry', visible = true } = {}) => {
    health.dataset.state = state;
    health.hidden = !visible;
    if (title) title.textContent = heading;
    if (copy) copy.textContent = message;
    actionMode = mode;
    if (action) {
      action.textContent = actionLabel || 'Retry';
      action.hidden = !actionLabel;
    }
  };

  const clearHealth = () => setHealth({ visible: false });

  const loginUrl = () => `/seller-login/?next=${encodeURIComponent(`/dashboard/${location.hash || '#overview'}`)}`;

  action?.addEventListener('click', () => {
    if (actionMode === 'reconnect') {
      location.href = '/api/shopee/connect';
      return;
    }
    if (actionMode === 'login') {
      location.href = loginUrl();
      return;
    }
    checkHealth(true);
  });

  const normalizeMessage = (data, fallback) => data?.message || data?.error || fallback;

  async function checkHealth(force = false) {
    if (healthInFlight) return;
    const now = Date.now();
    if (!force && now - lastHealthCheck < HEALTH_THROTTLE) return;
    lastHealthCheck = now;

    if (!navigator.onLine) {
      setHealth({
        state: 'offline',
        heading: 'OFFLINE',
        message: 'Koneksi internet terputus. Data dashboard terakhir tidak akan disinkronkan sampai koneksi kembali.',
        actionLabel: 'Retry',
        mode: 'retry'
      });
      return;
    }

    healthInFlight = true;
    try {
      const response = await fetch('/api/shopee/token-health', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      let data = null;
      try { data = await response.json(); } catch (_) {}

      if (response.ok && data?.healthy) {
        clearHealth();
        return;
      }

      if (response.status === 401 && data?.error === 'unauthorized') {
        setHealth({
          state: 'error',
          heading: 'SELLER SESSION EXPIRED',
          message: 'Login owner sudah kedaluwarsa. Login ulang untuk melanjutkan tanpa membuang data HPP lokal.',
          actionLabel: 'Login again',
          mode: 'login'
        });
        return;
      }

      if (data?.reconnectRequired || /refresh token|access[_\s-]*token|reconnect/i.test(normalizeMessage(data, ''))) {
        setHealth({
          state: 'reconnect',
          heading: 'SHOPEE RECONNECT REQUIRED',
          message: normalizeMessage(data, 'Authorization Shopee perlu diperbarui.'),
          actionLabel: 'Reconnect Shopee',
          mode: 'reconnect'
        });
        return;
      }

      setHealth({
        state: 'error',
        heading: 'SHOPEE HEALTH CHECK FAILED',
        message: normalizeMessage(data, `HTTP ${response.status}`),
        actionLabel: 'Retry',
        mode: 'retry'
      });
    } catch (_) {
      setHealth({
        state: navigator.onLine ? 'error' : 'offline',
        heading: navigator.onLine ? 'SHOPEE API UNREACHABLE' : 'OFFLINE',
        message: navigator.onLine ? 'Health check gagal dijangkau. Data yang sudah tampil tidak dihapus.' : 'Koneksi internet terputus.',
        actionLabel: 'Retry',
        mode: 'retry'
      });
    } finally {
      healthInFlight = false;
    }
  }

  const dynamicStatusSelector = [
    '#connectionMessage', '#shopInfoResult',
    '#productStatus', '#orderStatusText', '#logisticsStatusText',
    '#financeStatusText', '#adsStatusText', '#profitStatusText'
  ].join(',');

  const emptySelector = [
    '.product-empty', '.order-empty', '.logistics-empty', '.finance-empty',
    '.profit-empty', '.overview-empty', '.overview-loading', '.overview-failed'
  ].join(',');

  const syncButtonSelector = [
    '#syncOverview', '#syncProducts', '#syncOrders', '#syncStock',
    '#syncLogistics', '#syncAds', '#syncFinance', '#syncProfit'
  ].join(',');

  const improveDynamicUi = () => {
    document.querySelectorAll(dynamicStatusSelector).forEach((node) => {
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
    });
    document.querySelectorAll(emptySelector).forEach((node) => {
      node.setAttribute('role', node.textContent?.toLowerCase().includes('failed') ? 'alert' : 'status');
      node.setAttribute('aria-live', 'polite');
    });
    document.querySelectorAll(syncButtonSelector).forEach((button) => {
      const busy = /syncing|loading|reading|refreshing/i.test(button.textContent || '');
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });

    const active = document.querySelector('.view.active');
    const text = active?.textContent || '';
    if (/refresh token or shop_id|invalid access_token|shopee_reconnect_required/i.test(text)) {
      setHealth({
        state: 'reconnect',
        heading: 'SHOPEE RECONNECT REQUIRED',
        message: 'Shopee menolak token aktif. Re-authorize sandbox / seller shop dari Shopee Connection.',
        actionLabel: 'Reconnect Shopee',
        mode: 'reconnect'
      });
    }
  };

  let observerQueued = false;
  const observer = new MutationObserver(() => {
    if (observerQueued) return;
    observerQueued = true;
    requestAnimationFrame(() => {
      observerQueued = false;
      improveDynamicUi();
    });
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });

  window.addEventListener('offline', () => {
    setHealth({
      state: 'offline',
      heading: 'OFFLINE',
      message: 'Koneksi internet terputus. Data yang sudah tampil tetap dipertahankan.',
      actionLabel: 'Retry',
      mode: 'retry'
    });
  });
  window.addEventListener('online', () => checkHealth(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkHealth(false);
  });

  improveDynamicUi();
  setTimeout(() => checkHealth(true), 600);
})();
