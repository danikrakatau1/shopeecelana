(() => {
  if (document.querySelector('link[data-logistics-v1]')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './logistics-v1.css';
  css.dataset.logisticsV1 = 'true';
  document.head.appendChild(css);

  const panel = document.querySelector('[data-panel="logistics"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;
  let cachedShipments = [];

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const formatTime = (seconds) => {
    const value = Number(seconds || 0);
    if (!value) return '—';
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(value * 1000));
  };

  const stateLabel = (state) => ({
    ready: 'READY TO SHIP',
    transit: 'IN TRANSIT',
    delivered: 'DELIVERED',
    cancelled: 'CANCELLED',
    other: 'OTHER'
  }[state] || 'OTHER');

  const stateClass = (state) => ({
    ready: 'warning',
    transit: 'info',
    delivered: 'success',
    cancelled: 'danger',
    other: 'neutral'
  }[state] || 'neutral');

  const trackingCopy = (shipment) => {
    if (shipment.trackingNumber && shipment.trackingNumber !== '—') return shipment.trackingNumber;
    if (shipment.state === 'ready') return 'Not assigned yet';
    return 'Unavailable';
  };

  const shipmentCard = (shipment) => `
    <article class="logistics-card" data-logistics-state="${escapeHtml(shipment.state)}" data-sla-risk="${shipment.slaRisk ? '1' : '0'}">
      <div class="logistics-card-head">
        <div><small>ORDER SN</small><strong>${escapeHtml(shipment.orderSn)}</strong></div>
        <span class="tag ${stateClass(shipment.state)}">${escapeHtml(stateLabel(shipment.state))}</span>
      </div>
      <div class="logistics-meta-grid">
        <div><small>Courier</small><strong>${escapeHtml(shipment.courier || '—')}</strong></div>
        <div><small>Order status</small><strong>${escapeHtml(String(shipment.orderStatus || '—').replaceAll('_', ' '))}</strong></div>
        <div><small>Logistics status</small><strong>${escapeHtml(String(shipment.logisticsStatus || '—').replaceAll('_', ' '))}</strong></div>
        <div><small>Tracking</small><strong>${escapeHtml(trackingCopy(shipment))}</strong></div>
        <div><small>Ship by</small><strong>${escapeHtml(formatTime(shipment.shipByDate))}</strong></div>
        <div><small>SLA</small><strong class="${shipment.slaRisk ? 'logistics-risk-text' : ''}">${escapeHtml(shipment.slaLabel || '—')}</strong></div>
      </div>
      <div class="logistics-card-foot">
        <span>${escapeHtml(shipment.buyerUsername || '—')} · ${escapeHtml(shipment.itemCount || 0)} item / ${escapeHtml(shipment.units || 0)} unit</span>
        <span>${shipment.trackingInfoAvailable ? 'Tracking API ready' : 'Tracking event not available yet'}</span>
      </div>
    </article>`;

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">05 / Commerce</span><h1>Logistics.</h1></div>
      <p>Status fulfillment, courier, tracking, ship-by deadline, dan SLA dibaca langsung dari Shopee Order + Logistics API.</p>
    </div>

    <div class="live-strip logistics-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE LOGISTICS DATA</strong><small id="logisticsShopId">Waiting for connection</small></div>
      <div class="logistics-actions">
        <select id="logisticsFilter" class="logistics-filter" aria-label="Filter logistics">
          <option value="all">All shipments</option>
          <option value="ready">Ready to ship</option>
          <option value="transit">In transit</option>
          <option value="delivered">Delivered</option>
          <option value="risk">SLA risk</option>
        </select>
        <button id="syncLogistics" class="ghost-button" type="button">Sync now ↻</button>
      </div>
    </div>

    <div class="metrics-grid four logistics-metrics">
      <article class="metric-card"><small>Ready to ship</small><strong id="logisticsReady">—</strong></article>
      <article class="metric-card"><small>In transit</small><strong id="logisticsTransit">—</strong></article>
      <article class="metric-card"><small>Delivered</small><strong id="logisticsDelivered">—</strong></article>
      <article class="metric-card"><small>SLA risk</small><strong id="logisticsRisk">—</strong></article>
    </div>

    <article class="panel logistics-live-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Fulfillment monitor</span>
          <h2>Live Shipment Queue</h2>
          <span id="logisticsStatusText" class="muted">Ready to sync.</span>
          <div class="logistics-readonly">READ-ONLY MONITOR · no shipment action is sent to Shopee</div>
        </div>
        <span class="connection-state connected">LOGISTICS API V2</span>
      </div>
      <div id="logisticsLiveList" class="logistics-list"><div class="logistics-empty">Loading Shopee logistics…</div></div>
    </article>`;

  const syncButton = document.getElementById('syncLogistics');
  const filter = document.getElementById('logisticsFilter');

  const renderShipments = () => {
    const list = document.getElementById('logisticsLiveList');
    if (!list) return;
    const selected = filter?.value || 'all';
    const rows = selected === 'all'
      ? cachedShipments
      : selected === 'risk'
        ? cachedShipments.filter((shipment) => shipment.slaRisk)
        : cachedShipments.filter((shipment) => shipment.state === selected);
    list.innerHTML = rows.length
      ? rows.map(shipmentCard).join('')
      : `<div class="logistics-empty"><strong>No shipment in this filter.</strong><span>Try another status or press Sync now.</span></div>`;
  };

  async function loadLogistics(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('logisticsStatusText');
    const list = document.getElementById('logisticsLiveList');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Reading Shopee Order + Logistics APIs…';
    if (list && !loaded) list.innerHTML = '<div class="logistics-empty">Loading Shopee logistics…</div>';

    try {
      const response = await fetch('/api/shopee/logistics', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'logistics_sync_failed');

      cachedShipments = Array.isArray(data.shipments) ? data.shipments : [];
      const counts = data.counts || {};
      document.getElementById('logisticsReady').textContent = String(counts.ready || 0);
      document.getElementById('logisticsTransit').textContent = String(counts.transit || 0);
      document.getElementById('logisticsDelivered').textContent = String(counts.delivered || 0);
      document.getElementById('logisticsRisk').textContent = String(counts.slaRisk || 0);
      document.getElementById('logisticsShopId').textContent = `Shop ID ${data.shopId || '—'}`;
      if (statusText) statusText.textContent = `${cachedShipments.length} shipment(s) loaded · ${counts.ready || 0} ready · ${counts.transit || 0} in transit · ${counts.delivered || 0} delivered.`;
      renderShipments();
      loaded = true;

      if (data.tokenRefreshed) {
        const toast = document.createElement('div');
        toast.className = 'auth-toast';
        toast.textContent = 'Shopee token refreshed automatically during Logistics sync.';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="logistics-empty"><strong>Logistics sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadLogistics(true));
  filter?.addEventListener('change', renderShipments);
  document.querySelector('[data-view="logistics"]')?.addEventListener('click', () => setTimeout(() => loadLogistics(), 0));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#logistics') loadLogistics();
  });
  if (location.hash === '#logistics') loadLogistics();
})();
