(() => {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './seller-orders-v1.css';
  document.head.appendChild(css);

  const panel = document.querySelector('[data-panel="orders"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const formatMoney = (value, currency = 'IDR') => {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '—';
    try {
      return new Intl.NumberFormat('id-ID', {
        style: 'currency', currency: currency || 'IDR', maximumFractionDigits: 0
      }).format(number);
    } catch (_) {
      return `${currency || 'IDR'} ${number.toLocaleString('id-ID')}`;
    }
  };

  const formatTime = (seconds) => {
    const value = Number(seconds || 0);
    if (!value) return '—';
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value * 1000));
  };

  const statusClass = (status) => {
    const key = String(status || '').toUpperCase();
    if (key === 'COMPLETED') return 'success';
    if (key === 'SHIPPED' || key === 'PROCESSED') return 'info';
    if (key === 'READY_TO_SHIP' || key === 'UNPAID') return 'warning';
    if (key === 'CANCELLED' || key === 'IN_CANCEL') return 'danger';
    return 'neutral';
  };

  const statusLabel = (status) => String(status || 'UNKNOWN').replaceAll('_', ' ');

  const itemRows = (items = []) => items.map((item) => `
    <div class="order-item-row">
      <div>
        <strong>${escapeHtml(item.itemName || 'Shopee item')}</strong>
        <small>${escapeHtml(item.modelName || 'No variant')} · SKU ${escapeHtml(item.modelSku || item.itemSku || '—')}</small>
      </div>
      <span>${escapeHtml(item.quantity || 0)}×</span>
      <strong>${formatMoney(item.discountedPrice || item.originalPrice || 0)}</strong>
    </div>`).join('');

  const orderCard = (order) => `
    <article class="order-live-card">
      <div class="order-live-head">
        <div>
          <small>ORDER SN</small>
          <strong>${escapeHtml(order.orderSn)}</strong>
        </div>
        <span class="tag ${statusClass(order.status)}">${escapeHtml(statusLabel(order.status))}</span>
      </div>
      <div class="order-meta-grid">
        <div><small>Buyer</small><strong>${escapeHtml(order.buyerUsername || '—')}</strong></div>
        <div><small>Created</small><strong>${escapeHtml(formatTime(order.createTime))}</strong></div>
        <div><small>Total</small><strong>${formatMoney(order.totalAmount, order.currency)}</strong></div>
        <div><small>Items</small><strong>${escapeHtml(order.itemCount)} item / ${escapeHtml(order.units)} unit</strong></div>
        <div><small>Courier</small><strong>${escapeHtml(order.shippingCarrier || '—')}</strong></div>
        <div><small>Payment</small><strong>${escapeHtml(order.paymentMethod || (order.cod ? 'COD' : '—'))}</strong></div>
      </div>
      ${order.items?.length ? `<div class="order-items">${itemRows(order.items)}</div>` : ''}
    </article>`;

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">03 / Commerce</span><h1>Orders.</h1></div>
      <p>Pesanan sandbox dibaca langsung dari Shopee Order API, termasuk status, buyer, item, pembayaran, dan logistics summary.</p>
    </div>

    <div class="live-strip order-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE ORDER DATA</strong><small id="orderShopId">Waiting for connection</small></div>
      <div class="order-actions">
        <select id="orderStatusFilter" class="order-filter" aria-label="Filter status order">
          <option value="">All status</option>
          <option value="UNPAID">Unpaid</option>
          <option value="READY_TO_SHIP">Ready to ship</option>
          <option value="PROCESSED">Processed</option>
          <option value="SHIPPED">Shipped</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <button id="syncOrders" class="ghost-button" type="button">Sync now ↻</button>
      </div>
    </div>

    <div class="metrics-grid four order-metrics">
      <article class="metric-card"><small>Loaded orders</small><strong id="ordersLoaded">—</strong></article>
      <article class="metric-card"><small>To pay</small><strong id="ordersUnpaid">—</strong></article>
      <article class="metric-card"><small>To ship</small><strong id="ordersToShip">—</strong></article>
      <article class="metric-card"><small>Completed</small><strong id="ordersCompleted">—</strong></article>
    </div>

    <article class="panel order-live-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Last 14 days</span><h2>Live Order Queue</h2><span id="orderStatusText" class="muted">Ready to sync.</span></div>
        <span class="connection-state connected">ORDER API V2</span>
      </div>
      <div id="orderLiveList" class="order-live-list">
        <div class="order-empty">Loading Shopee orders…</div>
      </div>
    </article>`;

  const syncButton = document.getElementById('syncOrders');
  const filter = document.getElementById('orderStatusFilter');

  async function loadOrders(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('orderStatusText');
    const list = document.getElementById('orderLiveList');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Reading Shopee Order API…';
    if (list && !loaded) list.innerHTML = '<div class="order-empty">Loading Shopee orders…</div>';

    try {
      const params = new URLSearchParams({ days: '14', page_size: '50' });
      if (filter?.value) params.set('order_status', filter.value);
      const response = await fetch(`/api/shopee/orders?${params}`, {
        credentials: 'same-origin', cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'order_sync_failed');

      const orders = Array.isArray(data.orders) ? data.orders : [];
      const counts = data.counts || {};
      document.getElementById('ordersLoaded').textContent = String(data.loaded ?? orders.length);
      document.getElementById('ordersUnpaid').textContent = String(counts.UNPAID || 0);
      document.getElementById('ordersToShip').textContent = String(counts.READY_TO_SHIP || 0);
      document.getElementById('ordersCompleted').textContent = String(counts.COMPLETED || 0);
      document.getElementById('orderShopId').textContent = `Shop ID ${data.shopId}`;

      if (statusText) {
        statusText.textContent = `${orders.length} order(s) loaded${data.more ? ' · more available' : ''}${data.statusFilter ? ` · ${statusLabel(data.statusFilter)}` : ''}.`;
      }
      if (list) {
        list.innerHTML = orders.length
          ? orders.map(orderCard).join('')
          : `<div class="order-empty"><strong>No orders in the last 14 days.</strong><span>Create a sandbox test order from Shopee Open Platform → Tools → Test Order, then press Sync now.</span></div>`;
      }
      loaded = true;
      if (data.tokenRefreshed) {
        const toast = document.createElement('div');
        toast.className = 'auth-toast';
        toast.textContent = 'Shopee token refreshed automatically during Order sync.';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="order-empty"><strong>Order sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadOrders(true));
  filter?.addEventListener('change', () => { loaded = false; loadOrders(true); });

  document.querySelector('[data-view="orders"]')?.addEventListener('click', () => setTimeout(() => loadOrders(), 0));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#orders') loadOrders();
  });
  if (location.hash === '#orders') loadOrders();
})();
