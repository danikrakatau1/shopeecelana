(() => {
  if (document.querySelector('link[data-finance-v1]')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './finance-v1.css';
  css.dataset.financeV1 = 'true';
  document.head.appendChild(css);

  const panel = document.querySelector('[data-panel="finance"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const formatMoney = (value, currency = 'IDR') => {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '—';
    try {
      return new Intl.NumberFormat('id-ID', {
        style: 'currency', currency: currency || 'IDR', maximumFractionDigits: 0
      }).format(number);
    } catch (_) {
      return `${currency || 'IDR'} ${number.toLocaleString('id-ID')}`;
    }
  };

  const orderCard = (order) => {
    const available = Boolean(order.escrowAvailable);
    return `
      <article class="finance-order-card">
        <div class="finance-order-head">
          <div><small>ORDER SN</small><strong>${escapeHtml(order.orderSn)}</strong></div>
          <span class="finance-badge ${available ? 'ready' : 'pending'}">${available ? 'ESCROW READY' : 'ESCROW PENDING'}</span>
        </div>
        <div class="finance-breakdown">
          <div><small>Buyer</small><strong>${escapeHtml(order.buyerUsername || '—')}</strong></div>
          <div><small>Order value</small><strong>${formatMoney(order.orderTotal, order.currency)}</strong></div>
          <div><small>Expected payout</small><strong>${available ? formatMoney(order.expectedPayout, order.currency) : '—'}</strong></div>
          <div><small>Shopee fees</small><strong>${available ? formatMoney(order.shopeeFees, order.currency) : '—'}</strong></div>
          <div><small>Withholding tax</small><strong>${available ? formatMoney(order.withholdingTax, order.currency) : '—'}</strong></div>
        </div>
        ${available ? `
          <div class="finance-fees">
            <div><small>Commission</small><strong>${formatMoney(order.commissionFee, order.currency)}</strong></div>
            <div><small>Service fee</small><strong>${formatMoney(order.serviceFee, order.currency)}</strong></div>
            <div><small>Transaction fee</small><strong>${formatMoney(order.transactionFee, order.currency)}</strong></div>
            <div><small>Processing fee</small><strong>${formatMoney(order.processingFee, order.currency)}</strong></div>
            <div><small>Affiliate fee</small><strong>${formatMoney(order.affiliateFee, order.currency)}</strong></div>
            <div><small>Ads/technical fee</small><strong>${formatMoney(order.adsEscrowFee, order.currency)}</strong></div>
          </div>` : `<div class="finance-pending">${escapeHtml(order.escrowMessage || 'Escrow detail belum tersedia untuk status order ini.')}</div>`}
      </article>`;
  };

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">07 / Performance</span><h1>Finance.</h1></div>
      <p>Order value, expected payout, biaya Shopee, dan withholding tax dibaca dari Order + Payment/Escrow API. Tidak ada angka profit dummy.</p>
    </div>

    <div class="live-strip finance-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE FINANCE DATA</strong><small id="financeShopId">Waiting for connection</small></div>
      <button id="syncFinance" class="ghost-button" type="button">Sync now ↻</button>
    </div>

    <div class="finance-summary-grid">
      <article class="finance-summary-card"><small>Gross order value</small><strong id="financeGross">—</strong><span>Orders loaded from last 14 days</span></article>
      <article class="finance-summary-card"><small>Expected payout</small><strong id="financePayout">—</strong><span id="financeCoverage">Escrow coverage —</span></article>
      <article class="finance-summary-card"><small>Shopee fees</small><strong id="financeFees">—</strong><span>Commission + service + transaction + related fees</span></article>
      <article class="finance-summary-card"><small>Withholding tax</small><strong id="financeTax">—</strong><span>Where returned by Payment API</span></article>
    </div>

    <article class="panel finance-live-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Payment reconciliation</span>
          <h2>Live Escrow Breakdown</h2>
          <span id="financeStatusText" class="muted">Ready to sync.</span>
          <div class="finance-readonly">READ-ONLY · COGS and ad spend are not included in this view</div>
        </div>
        <span class="connection-state connected">PAYMENT API V2</span>
      </div>
      <div id="financeLiveList" class="finance-list"><div class="finance-empty">Loading Shopee finance…</div></div>
    </article>`;

  const syncButton = document.getElementById('syncFinance');

  async function loadFinance(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('financeStatusText');
    const list = document.getElementById('financeLiveList');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Reading Shopee Order + Payment/Escrow APIs…';
    if (list && !loaded) list.innerHTML = '<div class="finance-empty">Loading Shopee finance…</div>';

    try {
      const response = await fetch('/api/shopee/finance', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'finance_sync_failed');

      const orders = Array.isArray(data.orders) ? data.orders : [];
      const totals = data.totals || {};
      document.getElementById('financeGross').textContent = formatMoney(totals.orderValue || 0);
      document.getElementById('financePayout').textContent = formatMoney(totals.expectedPayout || 0);
      document.getElementById('financeFees').textContent = formatMoney(totals.shopeeFees || 0);
      document.getElementById('financeTax').textContent = formatMoney(totals.withholdingTax || 0);
      document.getElementById('financeShopId').textContent = `Shop ID ${data.shopId || '—'}`;
      document.getElementById('financeCoverage').textContent = `Escrow coverage ${totals.escrowReady || 0}/${orders.length}`;

      if (statusText) statusText.textContent = `${orders.length} order(s) loaded · ${totals.escrowReady || 0} escrow detail(s) available.`;
      if (list) {
        list.innerHTML = orders.length
          ? orders.map(orderCard).join('')
          : '<div class="finance-empty"><strong>No finance records yet.</strong><span>Create a sandbox order, then press Sync now.</span></div>';
      }
      loaded = true;

      if (data.tokenRefreshed) {
        const toast = document.createElement('div');
        toast.className = 'auth-toast';
        toast.textContent = 'Shopee token refreshed automatically during Finance sync.';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="finance-empty"><strong>Finance sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadFinance(true));
  document.querySelector('[data-view="finance"]')?.addEventListener('click', () => setTimeout(() => loadFinance(), 0));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#finance') loadFinance();
  });
  if (location.hash === '#finance') loadFinance();
})();
