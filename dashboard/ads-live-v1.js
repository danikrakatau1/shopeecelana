(() => {
  if (document.querySelector('link[data-ads-live-v1]')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './ads-live-v1.css';
  css.dataset.adsLiveV1 = 'true';
  document.head.appendChild(css);

  const panel = document.querySelector('[data-panel="ads"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const money = (value) => {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', maximumFractionDigits: 0
    }).format(number);
  };

  const compact = (value) => new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));
  const decimal = (value, digits = 2) => Number(value || 0).toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const signal = (campaign) => {
    const spend = Number(campaign?.spend || 0);
    const roas = Number(campaign?.directRoas || 0);
    if (spend <= 0) return { label: 'NO SPEND', cls: 'neutral' };
    if (roas >= 4) return { label: 'HEALTHY', cls: 'good' };
    if (roas >= 2) return { label: 'WATCH', cls: 'warn' };
    return { label: 'LOW ROAS', cls: 'bad' };
  };

  const campaignCard = (campaign) => {
    const status = signal(campaign);
    return `
      <article class="ads-campaign-card">
        <div class="ads-campaign-head">
          <div>
            <small>CAMPAIGN ${escapeHtml(campaign.campaignId)}</small>
            <strong>${escapeHtml(campaign.name || `Campaign ${campaign.campaignId}`)}</strong>
            <span>${escapeHtml(String(campaign.adType || '—').toUpperCase())} · ${escapeHtml(String(campaign.placement || '—').toUpperCase())}</span>
          </div>
          <span class="ads-signal ${status.cls}">${status.label}</span>
        </div>
        <div class="ads-campaign-metrics">
          <div><small>Spend</small><strong>${money(campaign.spend)}</strong></div>
          <div><small>Direct GMV</small><strong>${money(campaign.directGmv)}</strong></div>
          <div><small>Direct ROAS</small><strong>${decimal(campaign.directRoas)}×</strong></div>
          <div><small>Impressions</small><strong>${compact(campaign.impressions)}</strong></div>
          <div><small>Clicks</small><strong>${compact(campaign.clicks)}</strong></div>
          <div><small>Direct orders</small><strong>${escapeHtml(campaign.directOrders || 0)}</strong></div>
        </div>
      </article>`;
  };

  const permissionState = (data) => `
    <div class="ads-permission-state">
      <span class="ads-permission-icon">!</span>
      <div>
        <small>ADS API PERMISSION</small>
        <h3>Ads Service access required.</h3>
        <p>${escapeHtml(data.permissionMessage || 'Current Shopee application does not expose the Ads API.')}</p>
        <p class="ads-permission-note">Current Seller In House System connection remains intact. Add or authorize an Ads Service app before campaign metrics can be read.</p>
      </div>
    </div>`;

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">06 / Performance</span><h1>Shopee Ads.</h1></div>
      <p>Live Ads API probe untuk balance, campaign, spend, GMV, ROAS, impression, click, dan conversion signal.</p>
    </div>

    <div class="live-strip ads-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE ADS DATA</strong><small id="adsShopId">Waiting for connection</small></div>
      <button id="syncAds" class="ghost-button" type="button">Sync now ↻</button>
    </div>

    <div class="metrics-grid four ads-metrics">
      <article class="metric-card"><small>Ads balance</small><strong id="adsBalance">—</strong></article>
      <article class="metric-card"><small>7D spend</small><strong id="adsSpend">—</strong></article>
      <article class="metric-card"><small>7D direct GMV</small><strong id="adsGmv">—</strong></article>
      <article class="metric-card"><small>Direct ROAS</small><strong id="adsRoas">—</strong></article>
    </div>

    <article class="panel ads-live-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Ads API V2</span>
          <h2>Campaign Performance</h2>
          <span id="adsStatusText" class="muted">Ready to probe Ads API.</span>
          <div class="ads-readonly">READ-ONLY · no campaign edits, budget changes, or bid changes are sent to Shopee</div>
        </div>
        <span id="adsPermissionBadge" class="connection-state pending">CHECKING</span>
      </div>
      <div id="adsMeta" class="ads-meta"></div>
      <div id="adsLiveList" class="ads-list"><div class="ads-empty">Loading Shopee Ads…</div></div>
    </article>`;

  const syncButton = document.getElementById('syncAds');

  async function loadAds(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('adsStatusText');
    const list = document.getElementById('adsLiveList');
    const badge = document.getElementById('adsPermissionBadge');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Probing Shopee Ads API permission and campaign data…';
    if (badge) { badge.textContent = 'CHECKING'; badge.className = 'connection-state pending'; }

    try {
      const response = await fetch('/api/shopee/ads', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'ads_sync_failed');

      document.getElementById('adsShopId').textContent = `Shop ID ${data.shopId || '—'}`;
      const totals = data.totals || {};

      if (!data.permission) {
        document.getElementById('adsBalance').textContent = 'LOCKED';
        document.getElementById('adsSpend').textContent = '—';
        document.getElementById('adsGmv').textContent = '—';
        document.getElementById('adsRoas').textContent = '—';
        if (badge) { badge.textContent = 'PERMISSION REQUIRED'; badge.className = 'connection-state pending ads-permission-badge'; }
        if (statusText) statusText.textContent = 'Current app is connected, but Ads API access is not granted.';
        if (list) list.innerHTML = permissionState(data);
        document.getElementById('adsMeta').innerHTML = '<span>Seller API connection remains healthy</span><span>Ads Service app may be required</span>';
        loaded = true;
        return;
      }

      document.getElementById('adsBalance').textContent = data.balance === null ? '—' : money(data.balance);
      document.getElementById('adsSpend').textContent = money(totals.spend || 0);
      document.getElementById('adsGmv').textContent = money(totals.directGmv || 0);
      document.getElementById('adsRoas').textContent = `${decimal(totals.directRoas || 0)}×`;
      if (badge) { badge.textContent = 'ADS API READY'; badge.className = 'connection-state connected'; }
      if (statusText) {
        statusText.textContent = `${data.campaignCount || 0} campaign(s) found · ${data.performanceAvailable ? '7-day performance loaded' : 'performance not available yet'}.`;
      }

      const meta = document.getElementById('adsMeta');
      if (meta) {
        meta.innerHTML = `
          <span>Impressions <strong>${compact(totals.impressions || 0)}</strong></span>
          <span>Clicks <strong>${compact(totals.clicks || 0)}</strong></span>
          <span>Direct orders <strong>${escapeHtml(totals.orders || 0)}</strong></span>
          <span>Auto top-up <strong>${data.toggles ? (data.toggles.autoTopUp ? 'ON' : 'OFF') : '—'}</strong></span>`;
      }

      const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      if (list) {
        if (campaigns.length) list.innerHTML = campaigns.map(campaignCard).join('');
        else if (data.performanceMessage) list.innerHTML = `<div class="ads-empty"><strong>Ads API ready, performance unavailable.</strong><span>${escapeHtml(data.performanceMessage)}</span></div>`;
        else list.innerHTML = '<div class="ads-empty"><strong>No Shopee Ads campaigns yet.</strong><span>Ads API permission is valid, but this sandbox shop has no product campaigns to report.</span></div>';
      }
      loaded = true;
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (badge) { badge.textContent = 'ERROR'; badge.className = 'connection-state pending'; }
      if (list) list.innerHTML = `<div class="ads-empty"><strong>Ads sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadAds(true));
  document.querySelector('[data-view="ads"]')?.addEventListener('click', () => setTimeout(() => loadAds(), 0));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#ads') loadAds();
  });
  if (location.hash === '#ads') loadAds();
})();
