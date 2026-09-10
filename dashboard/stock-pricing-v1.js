(() => {
  if (document.querySelector('link[data-stock-pricing-v1]')) return;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = './stock-pricing-v1.css';
  css.dataset.stockPricingV1 = 'true';
  document.head.appendChild(css);

  const panel = document.querySelector('[data-panel="stock"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;
  let cachedRows = [];

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>\'\"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const formatIDR = (value) => {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return '—';
    return new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', maximumFractionDigits: 0
    }).format(number);
  };

  const classifyStock = (stock) => {
    const value = Number(stock || 0);
    if (value <= 0) return 'oos';
    if (value <= 10) return 'low';
    return 'healthy';
  };

  const flattenProducts = (products = []) => {
    const rows = [];
    products.forEach((product) => {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      if (variants.length) {
        variants.forEach((variant) => rows.push({
          itemId: product.itemId,
          productName: product.name,
          productSku: product.sku,
          variantName: variant.name || 'Variant',
          variantSku: variant.sku || '—',
          price: Number(variant.price || 0),
          stock: Number(variant.stock || 0),
          status: variant.status || product.status || 'NORMAL',
          modelId: variant.modelId || '—'
        }));
      } else {
        rows.push({
          itemId: product.itemId,
          productName: product.name,
          productSku: product.sku,
          variantName: 'No variant',
          variantSku: product.sku || '—',
          price: Number(product.price || 0),
          stock: Number(product.stock || 0),
          status: product.status || 'NORMAL',
          modelId: '—'
        });
      }
    });
    return rows;
  };

  const stockBadge = (stock) => {
    const state = classifyStock(stock);
    const label = state === 'oos' ? 'OUT OF STOCK' : state === 'low' ? 'LOW STOCK' : 'HEALTHY';
    return `<span class="stock-badge ${state}">${label}</span>`;
  };

  const rowTemplate = (row, index) => {
    const state = classifyStock(row.stock);
    return `<div class="stock-row" data-stock-state="${state}">
      <div class="stock-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="stock-main">
        <strong>${escapeHtml(row.productName)}</strong>
        <small>${escapeHtml(row.variantName)} · SKU ${escapeHtml(row.variantSku)} · Item ${escapeHtml(row.itemId)}</small>
      </div>
      <div class="stock-cell"><small>Price</small><strong>${formatIDR(row.price)}</strong></div>
      <div class="stock-cell"><small>Stock</small><strong class="stock-${state}">${escapeHtml(row.stock)}</strong></div>
      <div class="stock-cell"><small>Model status</small><strong>${escapeHtml(row.status)}</strong></div>
      <div class="stock-cell">${stockBadge(row.stock)}</div>
    </div>`;
  };

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">04 / Commerce</span><h1>Stock & Pricing.</h1></div>
      <p>Monitoring live harga dan stok per SKU/variant dari Shopee Product API. Mode ini read-only; tidak mengubah data toko.</p>
    </div>

    <div class="live-strip stock-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE STOCK DATA</strong><small id="stockShopId">Waiting for connection</small></div>
      <div class="stock-actions">
        <select id="stockFilter" class="stock-filter" aria-label="Filter stock">
          <option value="all">All stock</option>
          <option value="oos">Out of stock</option>
          <option value="low">Low stock</option>
          <option value="healthy">Healthy</option>
        </select>
        <button id="syncStock" class="ghost-button" type="button">Sync now ↻</button>
      </div>
    </div>

    <div class="metrics-grid four">
      <article class="metric-card"><small>Total SKU / variants</small><strong id="stockSkuCount">—</strong></article>
      <article class="metric-card"><small>Total available stock</small><strong id="stockTotalUnits">—</strong></article>
      <article class="metric-card"><small>Low stock</small><strong id="stockLowCount">—</strong></article>
      <article class="metric-card"><small>Out of stock</small><strong id="stockOosCount">—</strong></article>
    </div>

    <article class="panel stock-live-panel">
      <div class="panel-head">
        <div>
          <span class="eyebrow">Live inventory monitor</span>
          <h2>SKU Stock & Price</h2>
          <span id="stockStatusText" class="muted">Ready to sync.</span>
          <div class="stock-readonly">READ-ONLY MONITOR · no stock/price writes are sent to Shopee</div>
        </div>
        <span class="connection-state connected">PRODUCT API V2</span>
      </div>
      <div class="stock-price-summary">
        <div><small>Lowest price</small><strong id="stockPriceMin">—</strong></div>
        <div><small>Highest price</small><strong id="stockPriceMax">—</strong></div>
        <div><small>Average price</small><strong id="stockPriceAvg">—</strong><span id="stockSyncTime" class="stock-sync-time">Not synced yet</span></div>
      </div>
      <div id="stockLiveList" class="stock-list"><div class="stock-empty">Loading Shopee stock & pricing…</div></div>
    </article>`;

  const syncButton = document.getElementById('syncStock');
  const filter = document.getElementById('stockFilter');

  const renderRows = () => {
    const list = document.getElementById('stockLiveList');
    if (!list) return;
    const selected = filter?.value || 'all';
    const rows = selected === 'all' ? cachedRows : cachedRows.filter((row) => classifyStock(row.stock) === selected);
    list.innerHTML = rows.length
      ? rows.map(rowTemplate).join('')
      : `<div class="stock-empty"><strong>No SKU in this filter.</strong><span>Try another stock status or press Sync now.</span></div>`;
  };

  async function loadStock(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('stockStatusText');
    const list = document.getElementById('stockLiveList');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Reading Shopee Product + Model API…';
    if (list && !loaded) list.innerHTML = '<div class="stock-empty">Loading Shopee stock & pricing…</div>';

    try {
      const response = await fetch('/api/shopee/products?page_size=50&offset=0&item_status=NORMAL', {
        credentials: 'same-origin', cache: 'no-store'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'stock_sync_failed');

      cachedRows = flattenProducts(Array.isArray(data.products) ? data.products : []);
      const totalUnits = cachedRows.reduce((sum, row) => sum + Math.max(0, Number(row.stock || 0)), 0);
      const lowCount = cachedRows.filter((row) => Number(row.stock) > 0 && Number(row.stock) <= 10).length;
      const oosCount = cachedRows.filter((row) => Number(row.stock) <= 0).length;
      const prices = cachedRows.map((row) => Number(row.price || 0)).filter((price) => price > 0);
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const avg = prices.length ? prices.reduce((sum, price) => sum + price, 0) / prices.length : 0;

      document.getElementById('stockSkuCount').textContent = String(cachedRows.length);
      document.getElementById('stockTotalUnits').textContent = String(totalUnits);
      document.getElementById('stockLowCount').textContent = String(lowCount);
      document.getElementById('stockOosCount').textContent = String(oosCount);
      document.getElementById('stockPriceMin').textContent = formatIDR(min);
      document.getElementById('stockPriceMax').textContent = formatIDR(max);
      document.getElementById('stockPriceAvg').textContent = formatIDR(avg);
      document.getElementById('stockShopId').textContent = `Shop ID ${data.shopId || '—'}`;
      document.getElementById('stockSyncTime').textContent = `Last sync ${new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
      if (statusText) statusText.textContent = `${cachedRows.length} SKU/variant(s) loaded · ${oosCount} out of stock · ${lowCount} low stock.`;
      renderRows();
      loaded = true;
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="stock-empty"><strong>Stock sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadStock(true));
  filter?.addEventListener('change', renderRows);
  document.querySelector('[data-view="stock"]')?.addEventListener('click', () => setTimeout(() => loadStock(), 0));
  window.addEventListener('hashchange', () => {
    if (location.hash === '#stock') loadStock();
  });
  if (location.hash === '#stock') loadStock();
})();
