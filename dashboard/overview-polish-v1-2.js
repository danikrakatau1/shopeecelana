(() => {
  if (window.__ARSTORE_OVERVIEW_POLISH_V12__) return;
  window.__ARSTORE_OVERVIEW_POLISH_V12__ = true;

  const panel = document.querySelector('[data-panel="overview"]');
  if (!panel) return;

  const n = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const exactMoney = (value) => new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
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

  const applyExactAmounts = () => {
    if (!panel.classList.contains('active') || !panel.querySelector('.overview-live-strip')) return;
    const snapshot = window.__ARSTORE_API_SNAPSHOT__?.find?.('/api/shopee/orders');
    const orders = snapshot?.data?.orders;
    if (!Array.isArray(orders)) return;

    const days = buildLastSevenDays(orders);
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

  let queued = false;
  const queueApply = (delay = 80) => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      applyExactAmounts();
    }, delay);
  };

  const observer = new MutationObserver(() => queueApply());
  observer.observe(panel, { childList: true, subtree: true });
  window.addEventListener('arstore:api-recovered', (event) => {
    if (event.detail?.url === '/api/shopee/orders') queueApply(50);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('#syncOverview')) queueApply(900);
  });
  queueApply(1200);
})();