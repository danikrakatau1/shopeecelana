(() => {
  if (document.querySelector('link[data-profit-intelligence-v1]')) return;

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './profit-intelligence-v1.css';
  css.dataset.profitIntelligenceV1 = 'true';
  document.head.appendChild(css);

  const STORAGE_HPP = 'arstore_profit_hpp_v1';
  const STORAGE_MAP = 'arstore_profit_campaign_product_v1';
  let loaded = false;
  let loading = false;
  let sourceData = null;

  const safeParse = (raw, fallback = {}) => {
    try { return JSON.parse(raw || '') || fallback; } catch (_) { return fallback; }
  };

  const hppStore = () => safeParse(localStorage.getItem(STORAGE_HPP), {});
  const mapStore = () => safeParse(localStorage.getItem(STORAGE_MAP), {});
  const saveHppStore = (value) => localStorage.setItem(STORAGE_HPP, JSON.stringify(value));
  const saveMapStore = (value) => localStorage.setItem(STORAGE_MAP, JSON.stringify(value));

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const n = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const money = (value) => new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
  }).format(n(value));

  const decimal = (value, digits = 2) => n(value).toLocaleString('id-ID', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });

  const percent = (value) => `${decimal(n(value) * 100, 1)}%`;

  const performanceGroup = [...document.querySelectorAll('.nav-group')].find((group) =>
    group.querySelector('small')?.textContent?.trim().toLowerCase() === 'performance'
  );

  let navButton = document.querySelector('[data-view="profit"]');
  if (!navButton && performanceGroup) {
    navButton = document.createElement('button');
    navButton.className = 'nav-item';
    navButton.dataset.view = 'profit';
    navButton.innerHTML = '<span>PI</span>Profit Intelligence';
    performanceGroup.appendChild(navButton);
  }

  let panel = document.querySelector('[data-panel="profit"]');
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'view';
    panel.dataset.panel = 'profit';
    document.querySelector('.dashboard-main')?.appendChild(panel);
  }

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">Profit Intelligence V1</span><h1>Profit<br>Intelligence.</h1></div>
      <p>Gabungkan Shopee Ads, seller settlement, dan HPP internal untuk membaca profit signal per campaign. HPP disimpan lokal di browser dan tidak dikirim ke Shopee.</p>
    </div>

    <div class="live-strip profit-live-strip">
      <div><span class="live-dot"></span><strong>LIVE PROFIT SIGNAL</strong><small id="profitShopId">Waiting for connection</small></div>
      <button id="syncProfit" class="ghost-button" type="button">Sync now ↻</button>
    </div>

    <div class="metrics-grid four profit-metrics">
      <article class="metric-card"><small>7D Direct GMV</small><strong id="profitGmv">—</strong><div class="delta">Shopee Ads attribution</div></article>
      <article class="metric-card"><small>7D Ad Spend</small><strong id="profitSpend">—</strong><div class="delta">Shopee Ads expense</div></article>
      <article class="metric-card"><small>Est. Profit</small><strong id="profitTotal">—</strong><div id="profitMargin" class="delta">Needs HPP</div></article>
      <article class="metric-card"><small>Settlement Factor</small><strong id="profitSettlementFactor">—</strong><div class="delta">Derived from reconciled Shopee payout</div></article>
    </div>

    <article class="panel profit-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Campaign economics</span>
          <h2>ROAS → Real Profit Signal</h2>
          <span id="profitStatusText" class="muted">Ready to sync.</span>
          <div class="profit-formula">ESTIMATE = Direct GMV × settlement factor − Ad Spend − estimated units × HPP</div>
        </div>
        <span class="connection-state connected">READ ONLY</span>
      </div>
      <div class="profit-note">
        <strong>HPP INTERNAL</strong>
        <span>Isi HPP per produk. Nilai hanya tersimpan di browser ini. Estimated units dihitung dari Direct GMV ÷ current Shopee price; hasil profit adalah operational estimate, bukan laporan akuntansi final.</span>
      </div>
      <div id="profitCampaignList" class="profit-list"><div class="profit-empty">Loading Profit Intelligence…</div></div>
    </article>`;

  const syncButton = panel.querySelector('#syncProfit');

  const activateProfit = () => {
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === navButton));
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view === panel));
    const title = document.getElementById('viewTitle');
    if (title) title.textContent = 'Profit Intelligence';
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('mobileOverlay')?.classList.remove('show');
    document.getElementById('menuButton')?.setAttribute('aria-expanded', 'false');
    if (location.hash !== '#profit') history.replaceState(null, '', '#profit');
    setTimeout(() => loadProfit(), 0);
  };

  navButton?.addEventListener('click', activateProfit);

  document.querySelectorAll('.nav-item').forEach((item) => {
    if (item === navButton) return;
    item.addEventListener('click', () => {
      panel.classList.remove('active');
      navButton?.classList.remove('active');
      if (location.hash === '#profit') history.replaceState(null, '', `${location.pathname}${location.search}`);
    });
  });

  const fetchJson = async (url) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data?.message || data?.error || `${url} failed`);
    return data || {};
  };

  const getFinanceFactor = (finance) => {
    const records = Array.isArray(finance?.records) ? finance.records.filter((record) => record?.escrowAvailable) : [];
    const base = records.reduce((sum, record) => sum + n(record?.settlement?.base), 0);
    const payout = records.reduce((sum, record) => sum + n(record?.settlement?.expectedPayout), 0);
    if (base <= 0) return { factor: 1, base: 0, payout: 0, coverage: 0 };
    return {
      factor: Math.max(0, Math.min(1.5, payout / base)),
      base,
      payout,
      coverage: records.length
    };
  };

  const productPrice = (product) => {
    const values = [product?.priceMin, product?.price, product?.priceMax].map(n).filter((value) => value > 0);
    return values.length ? values[0] : 0;
  };

  const resolveProductId = (campaign, products, mappings) => {
    const saved = String(mappings[campaign.campaignId] || '');
    if (saved && products.some((product) => String(product.itemId) === saved)) return saved;
    if (products.length === 1) return String(products[0].itemId);
    return '';
  };

  const deriveCampaign = (campaign, products, financeFactor, hpps, mappings) => {
    const selectedProductId = resolveProductId(campaign, products, mappings);
    const product = products.find((entry) => String(entry.itemId) === selectedProductId) || null;
    const price = productPrice(product);
    const hpp = n(hpps[selectedProductId]);
    const spend = n(campaign.spend);
    const gmv = n(campaign.directGmv);
    const roas = spend > 0 ? gmv / spend : n(campaign.directRoas);
    const estimatedUnits = gmv > 0 && price > 0 ? gmv / price : 0;
    const cogs = hpp > 0 ? estimatedUnits * hpp : 0;
    const settlementRevenue = gmv * financeFactor;
    const estimatedProfit = settlementRevenue - spend - cogs;
    const margin = gmv > 0 ? estimatedProfit / gmv : 0;
    const contributionRatio = price > 0 ? financeFactor - (hpp / price) : 0;
    const breakEvenRoas = contributionRatio > 0 ? 1 / contributionRatio : 0;
    const hppReady = Boolean(selectedProductId && hpp > 0 && price > 0);

    let signal = { label: 'WAITING DATA', cls: 'neutral' };
    if (!hppReady) signal = { label: 'NEED HPP', cls: 'neutral' };
    else if (spend <= 0) signal = { label: 'NO SPEND', cls: 'neutral' };
    else if (estimatedProfit < 0) signal = { label: 'LOSS', cls: 'loss' };
    else if (breakEvenRoas > 0 && roas < breakEvenRoas * 1.2) signal = { label: 'WATCH', cls: 'warn' };
    else signal = { label: 'PROFIT', cls: 'profit' };

    return {
      ...campaign,
      product,
      selectedProductId,
      price,
      hpp,
      spend,
      gmv,
      roas,
      estimatedUnits,
      cogs,
      settlementRevenue,
      estimatedProfit,
      margin,
      breakEvenRoas,
      hppReady,
      signal
    };
  };

  const productOptions = (products, selectedId) => [
    '<option value="">Select product…</option>',
    ...products.map((product) => `<option value="${escapeHtml(product.itemId)}" ${String(product.itemId) === String(selectedId) ? 'selected' : ''}>${escapeHtml(product.name || `Item ${product.itemId}`)} · ${money(productPrice(product))}</option>`)
  ].join('');

  const campaignCard = (item, products) => {
    const productName = item.product?.name || 'Product not linked';
    return `
      <article class="profit-campaign-card" data-campaign-id="${escapeHtml(item.campaignId)}">
        <div class="profit-campaign-head">
          <div>
            <small>CAMPAIGN ${escapeHtml(item.campaignId || '—')}</small>
            <strong>${escapeHtml(item.name || `Campaign ${item.campaignId}`)}</strong>
            <span>${escapeHtml(String(item.adType || '—').toUpperCase())} · ${escapeHtml(productName)}</span>
          </div>
          <span class="profit-signal ${item.signal.cls}">${item.signal.label}</span>
        </div>

        <div class="profit-config-grid">
          <label><span>Shopee product</span><select data-profit-product>${productOptions(products, item.selectedProductId)}</select></label>
          <label><span>HPP / unit</span><div class="profit-money-input"><b>Rp</b><input data-profit-hpp inputmode="numeric" min="0" step="100" value="${item.hpp ? Math.round(item.hpp) : ''}" placeholder="contoh 45000" /></div></label>
          <div><small>Current selling price</small><strong>${item.price ? money(item.price) : '—'}</strong></div>
          <div><small>Settlement factor</small><strong>${percent(sourceData?.financeFactor || 1)}</strong></div>
        </div>

        <div class="profit-metric-grid">
          <div><small>Direct GMV</small><strong>${money(item.gmv)}</strong></div>
          <div><small>Ad spend</small><strong>${money(item.spend)}</strong></div>
          <div><small>ROAS</small><strong>${decimal(item.roas)}×</strong></div>
          <div><small>Break-even ROAS</small><strong>${item.hppReady && item.breakEvenRoas ? `${decimal(item.breakEvenRoas)}×` : '—'}</strong></div>
          <div><small>Est. units</small><strong>${item.price > 0 ? decimal(item.estimatedUnits, 2) : '—'}</strong></div>
          <div><small>Est. HPP</small><strong>${item.hppReady ? money(item.cogs) : '—'}</strong></div>
          <div><small>Net after Shopee</small><strong>${money(item.settlementRevenue)}</strong></div>
          <div class="profit-highlight ${item.estimatedProfit < 0 ? 'negative' : ''}"><small>Estimated profit</small><strong>${item.hppReady ? money(item.estimatedProfit) : '—'}</strong><span>${item.hppReady && item.gmv > 0 ? `${percent(item.margin)} margin` : 'HPP required'}</span></div>
        </div>
      </article>`;
  };

  const bindInputs = () => {
    panel.querySelectorAll('[data-campaign-id]').forEach((card) => {
      const campaignId = card.dataset.campaignId;
      const select = card.querySelector('[data-profit-product]');
      const hppInput = card.querySelector('[data-profit-hpp]');

      select?.addEventListener('change', () => {
        const maps = mapStore();
        maps[campaignId] = select.value;
        saveMapStore(maps);
        renderSource();
      });

      hppInput?.addEventListener('change', () => {
        const productId = select?.value || '';
        if (!productId) return;
        const hpps = hppStore();
        const value = Math.max(0, n(hppInput.value));
        if (value > 0) hpps[productId] = value;
        else delete hpps[productId];
        saveHppStore(hpps);
        renderSource();
      });
    });
  };

  const renderSource = () => {
    if (!sourceData) return;
    const campaigns = Array.isArray(sourceData.ads?.campaigns) ? sourceData.ads.campaigns : [];
    const products = Array.isArray(sourceData.products?.products) ? sourceData.products.products : [];
    const hpps = hppStore();
    const mappings = mapStore();
    const derived = campaigns.map((campaign) => deriveCampaign(campaign, products, sourceData.financeFactor, hpps, mappings));
    const configured = derived.filter((item) => item.hppReady);
    const totals = configured.reduce((acc, item) => {
      acc.gmv += item.gmv;
      acc.spend += item.spend;
      acc.profit += item.estimatedProfit;
      return acc;
    }, { gmv: 0, spend: 0, profit: 0 });
    const margin = totals.gmv > 0 ? totals.profit / totals.gmv : 0;

    document.getElementById('profitShopId').textContent = `Shop ID ${sourceData.ads?.shopId || sourceData.products?.shopId || '—'}`;
    document.getElementById('profitGmv').textContent = money(n(sourceData.ads?.totals?.directGmv));
    document.getElementById('profitSpend').textContent = money(n(sourceData.ads?.totals?.spend));
    document.getElementById('profitSettlementFactor').textContent = percent(sourceData.financeFactor);
    document.getElementById('profitTotal').textContent = configured.length ? money(totals.profit) : '—';
    document.getElementById('profitMargin').textContent = configured.length && totals.gmv > 0 ? `${percent(margin)} estimated margin` : `HPP coverage ${configured.length}/${derived.length}`;

    const status = document.getElementById('profitStatusText');
    if (status) {
      status.textContent = `${derived.length} campaign(s) · HPP ${configured.length}/${derived.length} · finance coverage ${sourceData.financeCoverage} reconciled order(s).`;
    }

    const list = document.getElementById('profitCampaignList');
    if (list) {
      if (!sourceData.ads?.permission) {
        list.innerHTML = '<div class="profit-empty"><strong>ADS API NOT READY.</strong><span>Profit Intelligence needs Shopee Ads permission.</span></div>';
      } else if (!derived.length) {
        list.innerHTML = '<div class="profit-empty"><strong>NO CAMPAIGN DATA YET.</strong><span>Create or sync a Shopee Ads campaign, then press Sync now.</span></div>';
      } else {
        list.innerHTML = derived.map((item) => campaignCard(item, products)).join('');
        bindInputs();
      }
    }
  };

  async function loadProfit(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    const status = document.getElementById('profitStatusText');
    const list = document.getElementById('profitCampaignList');
    if (status) status.textContent = 'Refreshing token and combining Ads + Finance + Product data…';
    if (!loaded && list) list.innerHTML = '<div class="profit-empty">Loading live economics…</div>';

    try {
      await fetchJson('/api/shopee/status');
      const [ads, finance, products] = await Promise.all([
        fetchJson('/api/shopee/ads'),
        fetchJson('/api/shopee/finance-v1-1'),
        fetchJson('/api/shopee/products')
      ]);
      const financeInfo = getFinanceFactor(finance);
      sourceData = {
        ads,
        finance,
        products,
        financeFactor: financeInfo.factor,
        financeCoverage: financeInfo.coverage
      };
      loaded = true;
      renderSource();
    } catch (error) {
      if (status) status.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="profit-empty"><strong>PROFIT SYNC FAILED.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadProfit(true));

  window.addEventListener('hashchange', () => {
    if (location.hash === '#profit') activateProfit();
  });

  if (location.hash === '#profit') setTimeout(activateProfit, 0);
})();
