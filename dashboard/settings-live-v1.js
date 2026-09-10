(() => {
  if (window.__ARSTORE_SETTINGS_LIVE_V1__) return;
  window.__ARSTORE_SETTINGS_LIVE_V1__ = true;

  const panel = document.querySelector('[data-panel="settings"]');
  const navButton = document.querySelector('[data-view="settings"]');
  if (!panel || !navButton) return;

  const PREFS_KEY = 'arstore_seller_preferences_v1';
  const HPP_KEY = 'arstore_profit_hpp_v1';
  const MAP_KEY = 'arstore_profit_campaign_product_v1';

  const safeParse = (value, fallback = {}) => {
    try { return JSON.parse(value || '') || fallback; } catch (_) { return fallback; }
  };
  const readPrefs = () => ({
    storeName: 'AR STORE',
    targetMargin: 25,
    warningRoas: 2.5,
    healthyRoas: 4,
    ...safeParse(localStorage.getItem(PREFS_KEY), {})
  });
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const countEntries = (key) => Object.keys(safeParse(localStorage.getItem(key), {})).length;

  const renderShell = () => {
    const prefs = readPrefs();
    panel.innerHTML = `
      <div class="page-intro compact-intro settings-live-intro">
        <div><span class="eyebrow">09 / System</span><h1>Settings.</h1></div>
        <p>Preferensi lokal Seller Dashboard. Credential Shopee, Partner Key, access token, dan refresh token tetap dikelola server-side oleh Cloudflare Worker.</p>
      </div>

      <div class="settings-status-strip">
        <div><span class="live-dot"></span><strong>PRODUCTION SETTINGS</strong><small id="settingsConnectionText">Checking Shopee connection…</small></div>
        <span id="settingsConnectionBadge" class="connection-state pending">CHECKING</span>
      </div>

      <div class="dashboard-grid equal settings-grid">
        <article class="panel settings-card">
          <div class="panel-head"><div><span class="eyebrow">Dashboard identity</span><h2>Store</h2><span class="muted">Presentation preferences on this browser.</span></div><span class="settings-local-chip">LOCAL</span></div>
          <div class="settings-form-grid">
            <label><span>Store display name</span><input id="settingsStoreName" maxlength="40" autocomplete="off" value="${escapeHtml(prefs.storeName)}" /></label>
            <label><span>Marketplace</span><input value="Shopee Indonesia" disabled /></label>
            <label><span>Currency</span><input value="IDR · Indonesian Rupiah" disabled /></label>
          </div>
        </article>

        <article class="panel settings-card">
          <div class="panel-head"><div><span class="eyebrow">Decision reference</span><h2>Profit Rules</h2><span class="muted">Saved locally as operating targets; live Profit Intelligence remains grounded in Shopee data + HPP.</span></div><span class="settings-local-chip">LOCAL</span></div>
          <div class="settings-form-grid three">
            <label><span>Target net margin</span><div class="settings-suffix-input"><input id="settingsTargetMargin" inputmode="decimal" min="0" max="100" step="0.1" value="${escapeHtml(prefs.targetMargin)}" /><b>%</b></div></label>
            <label><span>Warning ROAS</span><div class="settings-suffix-input"><input id="settingsWarningRoas" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(prefs.warningRoas)}" /><b>×</b></div></label>
            <label><span>Healthy ROAS</span><div class="settings-suffix-input"><input id="settingsHealthyRoas" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(prefs.healthyRoas)}" /><b>×</b></div></label>
          </div>
          <div class="settings-actions"><button id="saveSettings" class="solid-button" type="button">Save settings</button><span id="settingsSaveState" role="status" aria-live="polite"></span></div>
        </article>
      </div>

      <div class="dashboard-grid equal settings-grid">
        <article class="panel settings-card">
          <div class="panel-head"><div><span class="eyebrow">Shopee authorization</span><h2>Connection</h2><span class="muted">Read-only status. Secret values are never rendered here.</span></div><button class="text-button" data-settings-jump="connection" type="button">Open connection →</button></div>
          <div class="settings-meta-grid">
            <div><small>Partner ID</small><strong id="settingsPartnerId">—</strong></div>
            <div><small>Shop ID</small><strong id="settingsShopId">—</strong></div>
            <div><small>Token state</small><strong id="settingsTokenState">—</strong></div>
            <div><small>API mode</small><strong>SERVER-SIDE</strong></div>
          </div>
        </article>

        <article class="panel settings-card">
          <div class="panel-head"><div><span class="eyebrow">Private economics</span><h2>Local Data</h2><span class="muted">HPP dan campaign mapping hanya tersimpan di browser ini.</span></div><span class="settings-local-chip">PRIVATE</span></div>
          <div class="settings-meta-grid compact">
            <div><small>HPP products</small><strong id="settingsHppCount">${countEntries(HPP_KEY)}</strong></div>
            <div><small>Campaign mappings</small><strong id="settingsMapCount">${countEntries(MAP_KEY)}</strong></div>
          </div>
          <div class="settings-danger-zone">
            <div><strong>Reset local economics</strong><small>Menghapus HPP dan campaign-product mapping dari browser ini saja. Data Shopee tidak disentuh.</small></div>
            <button id="resetEconomics" class="ghost-button danger" type="button">Reset HPP + mappings</button>
          </div>
        </article>
      </div>

      <article class="panel settings-production-note">
        <div><span class="eyebrow">Production boundary</span><h2>What stays server-side.</h2></div>
        <div class="settings-boundary-grid">
          <div><strong>Partner Key</strong><span>Cloudflare secret · never sent to browser</span></div>
          <div><strong>Access / Refresh Token</strong><span>Encrypted session flow · auto-refresh guarded</span></div>
          <div><strong>Seller Password</strong><span>Cloudflare secret · owner session only</span></div>
          <div><strong>HPP</strong><span>Browser-local · never sent to Shopee</span></div>
        </div>
      </article>`;

    bind();
    loadConnectionStatus();
  };

  const numberValue = (id, fallback = 0) => {
    const raw = String(document.getElementById(id)?.value || '').replace(',', '.');
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  const bind = () => {
    panel.querySelector('#saveSettings')?.addEventListener('click', () => {
      const storeName = String(panel.querySelector('#settingsStoreName')?.value || 'AR STORE').trim().slice(0, 40) || 'AR STORE';
      const targetMargin = Math.min(100, Math.max(0, numberValue('settingsTargetMargin', 25)));
      const warningRoas = Math.max(0, numberValue('settingsWarningRoas', 2.5));
      const healthyRoas = Math.max(0, numberValue('settingsHealthyRoas', 4));
      const state = panel.querySelector('#settingsSaveState');

      if (healthyRoas > 0 && warningRoas > healthyRoas) {
        if (state) { state.textContent = 'Warning ROAS cannot exceed Healthy ROAS.'; state.className = 'error'; }
        return;
      }

      localStorage.setItem(PREFS_KEY, JSON.stringify({ storeName, targetMargin, warningRoas, healthyRoas }));
      if (state) { state.textContent = 'Saved on this browser ✓'; state.className = 'success'; }
      setTimeout(() => { if (state) state.textContent = ''; }, 3500);
    });

    panel.querySelector('#resetEconomics')?.addEventListener('click', () => {
      const hppCount = countEntries(HPP_KEY);
      const mapCount = countEntries(MAP_KEY);
      if (!hppCount && !mapCount) return;
      if (!window.confirm('Reset HPP dan campaign mapping lokal? Data Shopee tidak akan berubah.')) return;
      localStorage.removeItem(HPP_KEY);
      localStorage.removeItem(MAP_KEY);
      const hpp = panel.querySelector('#settingsHppCount');
      const map = panel.querySelector('#settingsMapCount');
      if (hpp) hpp.textContent = '0';
      if (map) map.textContent = '0';
    });

    panel.querySelector('[data-settings-jump="connection"]')?.addEventListener('click', () => {
      document.querySelector('[data-view="connection"]')?.click();
    });
  };

  const formatToken = (expiresAt) => {
    if (!expiresAt) return 'CONNECTED';
    const left = Number(expiresAt) - Math.floor(Date.now() / 1000);
    if (left <= 0) return 'REFRESHING';
    const minutes = Math.max(1, Math.floor(left / 60));
    return minutes >= 60 ? `VALID ~${Math.floor(minutes / 60)}H` : `VALID ~${minutes}M`;
  };

  async function loadConnectionStatus() {
    const text = panel.querySelector('#settingsConnectionText');
    const badge = panel.querySelector('#settingsConnectionBadge');
    try {
      const response = await fetch('/api/shopee/status', { credentials: 'same-origin', cache: 'no-store' });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(data?.error || 'status_failed');
      const connected = Boolean(data?.connected);
      panel.querySelector('#settingsPartnerId').textContent = data?.partnerId || '—';
      panel.querySelector('#settingsShopId').textContent = data?.shopId || '—';
      panel.querySelector('#settingsTokenState').textContent = connected ? formatToken(data?.tokenExpiresAt) : 'NOT CONNECTED';
      if (text) text.textContent = connected ? `Shop ID ${data?.shopId || '—'} · Shopee authorization active` : 'Shopee authorization is not connected';
      if (badge) {
        badge.textContent = connected ? 'CONNECTED' : 'RECONNECT';
        badge.className = `connection-state ${connected ? 'connected' : 'pending'}`;
      }
    } catch (_) {
      if (text) text.textContent = 'Connection status unavailable';
      if (badge) { badge.textContent = 'CHECK'; badge.className = 'connection-state pending'; }
    }
  }

  navButton.addEventListener('click', () => setTimeout(loadConnectionStatus, 0));
  renderShell();
})();
