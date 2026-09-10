(() => {
  if (window.__ARSTORE_OVERVIEW_POLISH_V1__) return;
  window.__ARSTORE_OVERVIEW_POLISH_V1__ = true;

  if (!document.querySelector('link[data-overview-polish-v1]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = './overview-polish-v1.css';
    css.dataset.overviewPolishV1 = 'true';
    document.head.appendChild(css);
  }

  const panel = document.querySelector('[data-panel="overview"]');
  const navButton = document.querySelector('[data-view="overview"]');
  if (!panel || !navButton) return;

  let inFlight = false;
  let lastRun = 0;
  let queued = false;
  const THROTTLE_MS = 15000;

  const n = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const exactMoney = (value) => new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0
  }).format(n(value));

  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

  const buildLastSevenDays = (orders) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - (6 - index));
      return { date, amount: 0 };
    });
    const map = new Map(days.map((entry) => [dayKey(entry.date), entry]));

    (Array.isArray(orders) ? orders : []).forEach((order) => {
      const seconds = n(order?.createTime);
      if (!seconds) return;
      const bucket = map.get(dayKey(new Date(seconds * 1000)));
      if (bucket) bucket.amount += n(order?.totalAmount);
    });
    return days;
  };

  const applyExactAmounts = (days) => {
    const total = days.reduce((sum, entry) => sum + entry.amount, 0);
    const buyerPaidCard = [...panel.querySelectorAll('.overview-metrics .metric-card')]
      .find((card) => /7D\s+BUYER\s+PAID/i.test(card.querySelector('small')?.textContent || ''));

    if (buyerPaidCard) {
      buyerPaidCard.dataset.exactIdr = 'true';
      const value = buyerPaidCard.querySelector('strong');
      if (value) {
        value.textContent = exactMoney(total);
        value.title = `Exact 7-day buyer-paid total: ${exactMoney(total)}`;
      }
    }

    const bars = [...panel.querySelectorAll('.overview-bar-column')];
    bars.slice(0, 7).forEach((bar, index) => {
      const value = bar.querySelector('.overview-bar-value');
      const entry = days[index];
      if (!value || !entry) return;
      value.dataset.exactIdr = 'true';
      value.textContent = exactMoney(entry.amount);
      value.title = exactMoney(entry.amount);
    });
  };

  async function refreshExactCurrency(force = false) {
    if (inFlight) return;
    if (!panel.classList.contains('active') || !panel.querySelector('.overview-live-strip')) return;
    const now = Date.now();
    if (!force && now - lastRun < THROTTLE_MS) return;
    lastRun = now;
    inFlight = true;

    try {
      const response = await fetch('/api/shopee/orders?days=14&page_size=50', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok || !data?.ok) return;
      applyExactAmounts(buildLastSevenDays(data.orders));
    } catch (_) {
      // The live Overview keeps its existing values when this presentation-only
      // enhancement cannot refresh. No operational state is changed here.
    } finally {
      inFlight = false;
    }
  }

  const queueRefresh = (force = false, delay = 120) => {
    if (queued && !force) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      refreshExactCurrency(force);
    }, delay);
  };

  const observer = new MutationObserver(() => {
    if (panel.classList.contains('active') && panel.querySelector('.overview-live-strip')) queueRefresh(false, 80);
  });
  observer.observe(panel, { childList: true, subtree: true });

  document.addEventListener('click', (event) => {
    if (event.target.closest('#syncOverview')) queueRefresh(true, 900);
  });
  navButton.addEventListener('click', () => queueRefresh(false, 600));

  setTimeout(() => queueRefresh(true, 1300), 0);
})();
