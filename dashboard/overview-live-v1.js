(() => {
  if (window.__ARSTORE_OVERVIEW_LIVE_V1__) return;
  window.__ARSTORE_OVERVIEW_LIVE_V1__ = true;

  if (!document.querySelector('link[data-overview-live-v1]')) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = './overview-live-v1.css';
    css.dataset.overviewLiveV1 = 'true';
    document.head.appendChild(css);
  }

  const panel = document.querySelector('[data-panel="overview"]');
  const navButton = document.querySelector('[data-view="overview"]');
  if (!panel || !navButton) return;

  const HPP_STORAGE = 'arstore_profit_hpp_v1';
  const MAP_STORAGE = 'arstore_profit_campaign_product_v1';
  let loading = false;
  let loaded = false;
  let lastPayload = null;

  const n = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const money = (value) => new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
  }).format(n(value));

  const compactMoney = (value) => {
    const amount = n(value);
    if (Math.abs(amount) < 1000) return money(amount);
    return new Intl.NumberFormat('id-ID', {
      style: 'currency', currency: 'IDR', notation: 'compact', maximumFractionDigits: 1
    }).format(amount);
  };

  const decimal = (value, digits = 2) => n(value).toLocaleString('id-ID', {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });

  const percent = (value) => `${decimal(n(value) * 100, 1)}%`;

  const safeStore = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; }
  };

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 11) return 'Good morning.';
    if (hour < 15) return 'Good afternoon.';
    if (hour < 19) return 'Good evening.';
    return 'Good night.';
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

  const fetchJson = async (url) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data?.message || data?.error || `${url} failed`);
    return data || {};
  };

  const orderBuckets = (orders) => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(startToday);
      date.setDate(startToday.getDate() - (13 - index));
      return { date, amount: 0, orders: 0 };
    });

    const byKey = new Map(days.map((entry) => {
      const key = `${entry.date.getFullYear()}-${entry.date.getMonth()}-${entry.date.getDate()}`;
      return [key, entry];
    }));

    orders.forEach((order) => {
      const seconds = n(order?.createTime);
      if (!seconds) return;
      const date = new Date(seconds * 1000);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const bucket = byKey.get(key);
      if (!bucket) return;
      bucket.amount += n(order?.totalAmount);
      bucket.orders += 1;
    });

    return days;
  };

  const comparison = (current, previous) => {
    if (previous <= 0) return current > 0 ? { label: 'New activity', cls: 'positive' } : { label: 'No activity', cls: '' };
    const change = (current - previous) / previous;
    return {
      label: `${change >= 0 ? '↑' : '↓'} ${Math.abs(change * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 })}% vs prior 7D`,
      cls: change >= 0 ? 'positive' : 'negative'
    };
  };

  const financeFactor = (finance) => {
    const rows = Array.isArray(finance?.records) ? finance.records.filter((row) => row?.escrowAvailable) : [];
    const base = rows.reduce((sum, row) => sum + n(row?.settlement?.base), 0);
    const payout = rows.reduce((sum, row) => sum + n(row?.settlement?.expectedPayout), 0);
    return {
      factor: base > 0 ? Math.max(0, Math.min(1.5, payout / base)) : 1,
      coverage: rows.length,
      base,
      payout
    };
  };

  const priceOf = (product) => {
    const candidates = [product?.priceMin, product?.price, product?.priceMax].map(n).filter((value) => value > 0);
    return candidates[0] || 0;
  };

  const resolveCampaignProduct = (campaign, products, maps) => {
    const saved = String(maps[campaign?.campaignId] || '');
    if (saved) {
      const match = products.find((product) => String(product.itemId) === saved);
      if (match) return match;
    }
    return products.length === 1 ? products[0] : null;
  };

  const campaignEconomics = (campaigns, products, factor) => {
    const hpps = safeStore(HPP_STORAGE);
    const maps = safeStore(MAP_STORAGE);
    return campaigns.map((campaign) => {
      const product = resolveCampaignProduct(campaign, products, maps);
      const itemId = product ? String(product.itemId) : '';
      const price = priceOf(product);
      const hpp = n(hpps[itemId]);
      const spend = n(campaign?.spend);
      const gmv = n(campaign?.directGmv);
      const roas = spend > 0 ? gmv / spend : n(campaign?.directRoas);
      const units = gmv > 0 && price > 0 ? gmv / price : 0;
      const configured = Boolean(itemId && price > 0 && hpp > 0);
      const cogs = configured ? units * hpp : 0;
      const profit = configured ? (gmv * factor) - spend - cogs : null;
      const contributionRatio = price > 0 ? factor - (hpp / price) : 0;
      const breakEvenRoas = configured && contributionRatio > 0 ? 1 / contributionRatio : 0;

      let signal = { label: 'NEED HPP', cls: 'neutral' };
      if (configured && spend <= 0) signal = { label: 'NO SPEND', cls: 'neutral' };
      else if (configured && profit < 0) signal = { label: 'LOSS', cls: 'loss' };
      else if (configured && breakEvenRoas > 0 && roas < breakEvenRoas * 1.2) signal = { label: 'WATCH', cls: 'warn' };
      else if (configured) signal = { label: 'PROFIT', cls: 'profit' };

      return { campaign, product, price, hpp, spend, gmv, roas, units, configured, profit, breakEvenRoas, signal };
    });
  };

  const chartHtml = (buckets) => {
    const recent = buckets.slice(-7);
    const max = Math.max(1, ...recent.map((row) => row.amount));
    return recent.map((row) => {
      const height = row.amount > 0 ? Math.max(10, Math.round((row.amount / max) * 100)) : 4;
      const label = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short' }).format(row.date);
      return `<div class="overview-bar-column">
        <div class="overview-bar-value">${row.amount ? compactMoney(row.amount) : 'Rp0'}</div>
        <div class="overview-bar-track"><span class="overview-bar-fill" style="height:${height}%"></span></div>
        <small>${escapeHtml(label)}</small>
      </div>`;
    }).join('');
  };

  const recentOrdersHtml = (orders) => {
    const rows = [...orders].sort((a, b) => n(b?.createTime) - n(a?.createTime)).slice(0, 5);
    if (!rows.length) return '<div class="overview-empty">No Shopee orders in the loaded window.</div>';
    return `<div class="table-wrap"><table class="overview-order-table">
      <thead><tr><th>Order</th><th>Buyer / Item</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>${rows.map((order) => {
        const item = Array.isArray(order.items) ? order.items[0] : null;
        return `<tr>
          <td><strong>${escapeHtml(order.orderSn || '—')}</strong></td>
          <td><strong>${escapeHtml(order.buyerUsername || '—')}</strong><small>${escapeHtml(item?.itemName || 'Shopee order')}</small></td>
          <td>${money(order.totalAmount)}</td>
          <td><span class="tag ${statusClass(order.status)}">${escapeHtml(statusLabel(order.status))}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  };

  const campaignHtml = (economics) => {
    if (!economics.length) return '<div class="overview-empty">No Ads campaign found yet.</div>';
    return `<div class="overview-campaign-list">${economics.slice(0, 5).map((item) => `
      <div class="overview-campaign-row">
        <div><strong>${escapeHtml(item.campaign?.name || `Campaign ${item.campaign?.campaignId || '—'}`)}</strong><small>${item.product ? escapeHtml(item.product.name) : 'Product mapping required'} · ROAS ${decimal(item.roas)}×</small></div>
        <div class="overview-campaign-numbers"><span>${compactMoney(item.spend)} spend</span>${item.configured ? `<strong>${money(item.profit)}</strong>` : '<strong>HPP —</strong>'}</div>
        <span class="status-pill ${item.signal.cls}">${item.signal.label}</span>
      </div>`).join('')}</div>`;
  };

  const render = (payload) => {
    const { ordersData, productsData, logisticsData, adsData, financeData } = payload;
    const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
    const products = Array.isArray(productsData.products) ? productsData.products : [];
    const campaigns = Array.isArray(adsData.campaigns) ? adsData.campaigns : [];
    const buckets = orderBuckets(orders);
    const prior7 = buckets.slice(0, 7);
    const recent7 = buckets.slice(7);
    const priorRevenue = prior7.reduce((sum, row) => sum + row.amount, 0);
    const recentRevenue = recent7.reduce((sum, row) => sum + row.amount, 0);
    const priorOrders = prior7.reduce((sum, row) => sum + row.orders, 0);
    const recentOrders = recent7.reduce((sum, row) => sum + row.orders, 0);
    const revenueDelta = comparison(recentRevenue, priorRevenue);
    const ordersDelta = comparison(recentOrders, priorOrders);
    const finance = financeFactor(financeData);
    const economics = campaignEconomics(campaigns, products, finance.factor);
    const configured = economics.filter((row) => row.configured);
    const estimatedProfit = configured.reduce((sum, row) => sum + n(row.profit), 0);
    const totalGmv = n(adsData?.totals?.directGmv);
    const totalSpend = n(adsData?.totals?.spend);
    const directRoas = totalSpend > 0 ? totalGmv / totalSpend : n(adsData?.totals?.directRoas);
    const totalStock = products.reduce((sum, product) => sum + n(product.stock), 0);
    const counts = logisticsData?.counts || {};
    const financeGap = n(financeData?.totals?.reconciliationGap);
    const shopId = adsData?.shopId || productsData?.shopId || ordersData?.shopId || logisticsData?.shopId || financeData?.shopId || '—';
    const profitMargin = totalGmv > 0 && configured.length ? estimatedProfit / totalGmv : 0;

    panel.innerHTML = `
      <div class="page-intro overview-live-intro">
        <div><span class="eyebrow">01 / Live Overview</span><h1>${escapeHtml(greeting())}<br><em>Here’s the store.</em></h1></div>
        <p>Ringkasan operasional langsung dari Shopee Product, Order, Logistics, Ads, dan Payment API. HPP tetap internal di browser.</p>
      </div>

      <div class="live-strip overview-live-strip">
        <div><span class="live-dot"></span><strong>SHOPEE LIVE OVERVIEW</strong><small>Shop ID ${escapeHtml(shopId)}</small></div>
        <button id="syncOverview" class="ghost-button" type="button">Sync now ↻</button>
      </div>

      <div class="metrics-grid overview-metrics">
        <article class="metric-card hero-metric"><small>7D Buyer Paid</small><strong>${compactMoney(recentRevenue)}</strong><div class="delta ${revenueDelta.cls}">${escapeHtml(revenueDelta.label)}</div></article>
        <article class="metric-card"><small>7D Orders</small><strong>${recentOrders}</strong><div class="delta ${ordersDelta.cls}">${escapeHtml(ordersDelta.label)}</div></article>
        <article class="metric-card"><small>7D Ad Spend</small><strong>${compactMoney(totalSpend)}</strong><div class="delta">${campaigns.length} campaign(s)</div></article>
        <article class="metric-card"><small>Direct ROAS</small><strong>${decimal(directRoas)}×</strong><div class="delta ${directRoas > 0 ? 'positive' : ''}">${totalSpend > 0 ? 'Shopee Ads attribution' : 'No spend yet'}</div></article>
        <article class="metric-card"><small>Est. Profit</small><strong>${configured.length ? compactMoney(estimatedProfit) : '—'}</strong><div class="delta ${estimatedProfit < 0 ? 'negative' : estimatedProfit > 0 ? 'positive' : ''}">${configured.length ? `${percent(profitMargin)} est. margin · HPP ${configured.length}/${economics.length}` : `HPP ${configured.length}/${economics.length}`}</div></article>
      </div>

      <div class="dashboard-grid two-one overview-primary-grid">
        <article class="panel overview-chart-panel">
          <div class="panel-head"><div><span class="eyebrow">Sales performance</span><h2>7 Day Buyer Paid</h2><span class="muted">Loaded from Shopee Order API</span></div><button class="text-button" data-overview-jump="orders">Orders →</button></div>
          <div class="overview-bars">${chartHtml(buckets)}</div>
        </article>

        <article class="panel overview-health-panel">
          <div class="panel-head"><div><span class="eyebrow">Operations</span><h2>Live Snapshot</h2></div><span class="connection-state connected">API READY</span></div>
          <div class="overview-health-list">
            <div><span>Products</span><strong>${productsData.totalCount ?? products.length}</strong><small>${totalStock.toLocaleString('id-ID')} stock</small></div>
            <div><span>Ready to ship</span><strong>${n(counts.ready)}</strong><small>${n(counts.slaRisk)} SLA risk</small></div>
            <div><span>Settlement</span><strong>${percent(finance.factor)}</strong><small>${finance.coverage} escrow order(s)</small></div>
            <div><span>Reconciliation gap</span><strong class="${financeGap === 0 ? 'good' : ''}">${money(financeGap)}</strong><small>${financeData?.fullyReconciled ? 'Full match' : 'Check Finance'}</small></div>
          </div>
        </article>
      </div>

      <div class="dashboard-grid equal overview-secondary-grid">
        <article class="panel">
          <div class="panel-head"><div><span class="eyebrow">Orders</span><h2>Recent Orders</h2><span class="muted">Latest loaded orders</span></div><button class="text-button" data-overview-jump="orders">View all →</button></div>
          ${recentOrdersHtml(orders)}
        </article>

        <article class="panel">
          <div class="panel-head"><div><span class="eyebrow">Ads + HPP</span><h2>Campaign Signals</h2><span class="muted">Profit Intelligence snapshot</span></div><button class="text-button" data-overview-jump="profit">Open PI →</button></div>
          ${campaignHtml(economics)}
        </article>
      </div>

      <div class="overview-system-row">
        <span><i></i> Product API <strong>${productsData?.ok ? 'READY' : 'CHECK'}</strong></span>
        <span><i></i> Order API <strong>${ordersData?.ok ? 'READY' : 'CHECK'}</strong></span>
        <span><i></i> Logistics API <strong>${logisticsData?.ok ? 'READY' : 'CHECK'}</strong></span>
        <span><i></i> Ads API <strong>${adsData?.permission ? 'READY' : 'CHECK'}</strong></span>
        <span><i></i> Payment API <strong>${financeData?.ok ? 'READY' : 'CHECK'}</strong></span>
      </div>`;

    panel.querySelector('#syncOverview')?.addEventListener('click', () => loadOverview(true));
    panel.querySelectorAll('[data-overview-jump]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.overviewJump;
        document.querySelector(`[data-view="${target}"]`)?.click();
      });
    });

    const badge = document.querySelector('.demo-badge');
    if (badge) badge.textContent = 'SHOPEE API';
  };

  const renderFailure = (message) => {
    panel.innerHTML = `
      <div class="page-intro overview-live-intro"><div><span class="eyebrow">01 / Live Overview</span><h1>Store<br><em>Overview.</em></h1></div><p>Live Shopee operational snapshot.</p></div>
      <article class="panel overview-failed"><span class="eyebrow">Live sync</span><h2>OVERVIEW SYNC FAILED.</h2><p>${escapeHtml(message)}</p><button id="retryOverview" class="solid-button" type="button">Retry sync</button></article>`;
    panel.querySelector('#retryOverview')?.addEventListener('click', () => loadOverview(true));
  };

  async function loadOverview(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;

    if (!loaded) {
      panel.innerHTML = `
        <div class="page-intro overview-live-intro"><div><span class="eyebrow">01 / Live Overview</span><h1>${escapeHtml(greeting())}<br><em>Loading store.</em></h1></div><p>Combining Shopee Product, Order, Logistics, Ads, and Payment data…</p></div>
        <article class="panel overview-loading"><span class="live-dot"></span><strong>SYNCING SHOPEE DATA…</strong></article>`;
    } else {
      panel.querySelector('#syncOverview')?.setAttribute('disabled', '');
      const button = panel.querySelector('#syncOverview');
      if (button) button.textContent = 'Syncing…';
    }

    try {
      await fetchJson('/api/shopee/token-health');
      const [ordersData, productsData, logisticsData, adsData, financeData] = await Promise.all([
        fetchJson('/api/shopee/orders?days=14&page_size=50'),
        fetchJson('/api/shopee/products?page_size=50'),
        fetchJson('/api/shopee/logistics'),
        fetchJson('/api/shopee/ads'),
        fetchJson('/api/shopee/finance-v1-1')
      ]);
      lastPayload = { ordersData, productsData, logisticsData, adsData, financeData };
      loaded = true;
      render(lastPayload);
    } catch (error) {
      loaded = false;
      renderFailure(error.message || 'overview_sync_failed');
    } finally {
      loading = false;
    }
  }

  navButton.addEventListener('click', () => setTimeout(() => loadOverview(), 0));

  window.addEventListener('hashchange', () => {
    if (!location.hash || location.hash === '#overview') loadOverview();
  });

  // Dashboard opens on Overview by default.
  setTimeout(() => {
    if (panel.classList.contains('active')) loadOverview();
  }, 0);
})();
