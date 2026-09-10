['./auth-connection.css', './seller-v3.css'].forEach((href) => {
  if ([...document.styleSheets].some((sheet) => sheet.href?.endsWith(href.replace('./', '/dashboard/')))) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
});

const navItems = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.view')];
const viewTitle = document.getElementById('viewTitle');
const sidebar = document.getElementById('sidebar');
const menuButton = document.getElementById('menuButton');
const mobileOverlay = document.getElementById('mobileOverlay');
const topbarActions = document.querySelector('.topbar-actions');
const connectionMini = document.querySelector('.connection-mini');

let shopeeStatusLoaded = false;
let productsLoaded = false;
let productsLoading = false;

const labels = {
  overview: 'Overview', products: 'Products', orders: 'Orders', stock: 'Stock & Pricing',
  logistics: 'Logistics', ads: 'Shopee Ads', finance: 'Finance', connection: 'Shopee Connection', settings: 'Settings'
};

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

const closeSidebar = () => {
  sidebar?.classList.remove('open');
  mobileOverlay?.classList.remove('show');
  menuButton?.setAttribute('aria-expanded', 'false');
};

const showToast = (message) => {
  document.querySelector('.auth-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'auth-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 5200);
};

const setConnectionMessage = (message = '', type = 'info') => {
  const box = document.getElementById('connectionMessage');
  if (!box) return;
  box.textContent = message;
  box.className = message ? `connection-message show ${type}` : 'connection-message';
};

const updateMiniStatus = (connected, configured = true) => {
  if (!connectionMini) return;
  const dot = connectionMini.querySelector('.status-dot');
  const copy = connectionMini.querySelector('small');
  if (dot) dot.className = `status-dot ${connected ? 'good' : configured ? 'warning' : 'bad'}`;
  if (copy) copy.textContent = connected ? 'Connected' : configured ? 'Ready to connect' : 'Needs configuration';
};

const formatTokenStatus = (expiresAt) => {
  if (!expiresAt) return 'Connected';
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 'Refreshing…';
  const minutes = Math.max(1, Math.floor(remaining / 60));
  return minutes >= 60 ? `Valid ~${Math.floor(minutes / 60)}h` : `Valid ~${minutes}m`;
};

const formatIDR = (value) => {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '—';
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(number);
};

const formatProductPrice = (product) => {
  const min = Number(product?.priceMin ?? product?.price ?? 0);
  const max = Number(product?.priceMax ?? product?.price ?? 0);
  if (!Number.isFinite(min) || min <= 0) return '—';
  if (!Number.isFinite(max) || max <= 0 || min === max) return formatIDR(min);
  return `${formatIDR(min)} – ${formatIDR(max)}`;
};

const renderConnectionCenter = () => {
  const panel = document.querySelector('[data-panel="connection"]');
  if (!panel) return;
  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">08 / System</span><h1>Shopee<br>Connection.</h1></div>
      <p>Hubungkan Seller Dashboard ke Shopee Open Platform melalui Cloudflare Worker. Partner Key tidak pernah dikirim ke browser.</p>
    </div>
    <article class="panel connection-card connection-live">
      <div class="connection-status-head">
        <div class="connection-status-copy"><span id="connectionDot" class="status-dot warning"></span><div><h2 id="connectionHeadline">Checking connection…</h2><p id="connectionDescription">Memeriksa konfigurasi Worker dan status otorisasi toko.</p></div></div>
        <span id="connectionState" class="connection-state pending">CHECKING</span>
      </div>
      <div class="connection-meta">
        <div><small>Partner ID</small><strong id="partnerIdValue">Checking…</strong></div>
        <div><small>Shop ID</small><strong id="shopIdValue">—</strong></div>
        <div><small>Token</small><strong id="tokenValue">—</strong></div>
        <div><small>Callback</small><strong id="callbackValue">—</strong></div>
      </div>
      <div id="connectionMessage" class="connection-message" role="status" aria-live="polite"></div>
      <div class="connection-actions">
        <button id="connectShopee" class="solid-button" type="button" disabled>Connect Shopee</button>
        <button id="testShopee" class="ghost-button" type="button" disabled>Test Shop Info</button>
        <button id="disconnectShopee" class="ghost-button danger" type="button" disabled>Disconnect</button>
      </div>
      <div id="shopInfoResult" class="test-result" aria-live="polite"></div>
    </article>
    <article class="panel connection-note">
      <div><span class="eyebrow">Secure connection flow</span><h3>Browser never sees the Partner Key.</h3><p>Signature dan refresh token dijalankan di Cloudflare Worker. Access token diperbarui otomatis sebelum kedaluwarsa.</p></div>
      <div class="connection-steps">
        <div><span>01</span><div><strong>Seller Login</strong><small>Owner session diverifikasi sebelum dashboard diberikan.</small></div></div>
        <div><span>02</span><div><strong>Authorize Shopee</strong><small>Worker membuat signed authorization URL.</small></div></div>
        <div><span>03</span><div><strong>Auto Refresh</strong><small>Access token diperbarui otomatis dengan refresh token.</small></div></div>
        <div><span>04</span><div><strong>Real Data</strong><small>Produk dan API seller dibaca server-side.</small></div></div>
      </div>
    </article>`;

  document.getElementById('connectShopee')?.addEventListener('click', () => { location.href = '/api/shopee/connect'; });
  document.getElementById('testShopee')?.addEventListener('click', testShopInfo);
  document.getElementById('disconnectShopee')?.addEventListener('click', async () => {
    if (!window.confirm('Putuskan koneksi Shopee dari dashboard ini?')) return;
    setConnectionMessage('Memutus koneksi…', 'info');
    try {
      const response = await fetch('/api/shopee/disconnect', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('disconnect_failed');
      productsLoaded = false;
      shopeeStatusLoaded = false;
      setConnectionMessage('Koneksi Shopee diputus.', 'success');
      await loadShopeeStatus(true);
    } catch (_) { setConnectionMessage('Gagal memutus koneksi. Coba lagi.', 'error'); }
  });
};

const renderProductsCenter = () => {
  const panel = document.querySelector('[data-panel="products"]');
  if (!panel) return;
  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">02 / Commerce</span><h1>Products.</h1></div>
      <p>Data produk, variant, harga, dan stok dibaca langsung dari Shopee Open Platform.</p>
    </div>
    <div class="live-strip"><div><span class="live-dot"></span><strong>SHOPEE LIVE DATA</strong><small id="productShopId">Waiting for connection</small></div><button id="syncProducts" class="ghost-button" type="button">Sync now ↻</button></div>
    <div class="metrics-grid four product-metrics">
      <article class="metric-card"><small>Total products</small><strong id="productTotal">—</strong></article>
      <article class="metric-card"><small>Variants loaded</small><strong id="productLoaded">—</strong></article>
      <article class="metric-card"><small>Low-stock variants</small><strong id="productLowStock">—</strong></article>
      <article class="metric-card"><small>Token</small><strong id="productTokenState" class="product-token-state">AUTO</strong><div class="delta positive">Auto refresh enabled</div></article>
    </div>
    <article class="panel product-live-panel">
      <div class="panel-head"><div><span class="eyebrow">Shopee catalog</span><h2>Product + Variant Sync</h2><span id="productStatus" class="muted">Ready to sync.</span></div><span id="productSource" class="connection-state connected">API V2</span></div>
      <div id="productLiveList" class="product-live-list"><div class="product-empty">Loading Shopee products…</div></div>
    </article>`;
  document.getElementById('syncProducts')?.addEventListener('click', () => loadProducts(true));
};

const applyShopeeStatus = (status) => {
  const connected = Boolean(status.connected);
  const configured = Boolean(status.configured);
  updateMiniStatus(connected, configured);
  const dot = document.getElementById('connectionDot');
  const headline = document.getElementById('connectionHeadline');
  const description = document.getElementById('connectionDescription');
  const state = document.getElementById('connectionState');
  const connectButton = document.getElementById('connectShopee');
  const testButton = document.getElementById('testShopee');
  const disconnectButton = document.getElementById('disconnectShopee');
  if (dot) dot.className = `status-dot ${connected ? 'good' : configured ? 'warning' : 'bad'}`;
  if (headline) headline.textContent = connected ? 'Shopee connected.' : configured ? 'Ready to authorize.' : 'Partner credentials required.';
  if (description) description.textContent = connected ? 'Authorization aktif. Token akan diperbarui otomatis sebelum kedaluwarsa.' : configured ? 'Partner credentials tersedia. Authorize toko untuk membuat token.' : 'Tambahkan credential Shopee sebagai Cloudflare secrets.';
  if (state) { state.textContent = connected ? 'CONNECTED' : configured ? 'READY' : 'SETUP REQUIRED'; state.className = `connection-state ${connected ? 'connected' : 'pending'}`; }
  const partnerId = document.getElementById('partnerIdValue');
  const shopId = document.getElementById('shopIdValue');
  const token = document.getElementById('tokenValue');
  const callback = document.getElementById('callbackValue');
  if (partnerId) partnerId.textContent = status.partnerId || 'Not configured';
  if (shopId) shopId.textContent = status.shopId || 'Not authorized';
  if (token) token.textContent = connected ? formatTokenStatus(status.tokenExpiresAt) : 'Not available';
  if (callback) callback.textContent = status.callbackUrl || '—';
  if (connectButton) { connectButton.disabled = !configured; connectButton.textContent = connected ? 'Reconnect Shopee' : 'Connect Shopee'; }
  if (testButton) testButton.disabled = !connected;
  if (disconnectButton) disconnectButton.disabled = !connected;
  if (status.tokenRefreshed) showToast('Shopee access token refreshed automatically.');
};

async function loadShopeeStatus(force = false) {
  if (shopeeStatusLoaded && !force) return;
  try {
    const response = await fetch('/api/shopee/status', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { location.replace(`/seller-login/?next=${encodeURIComponent('/dashboard/#connection')}`); return; }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'status_failed');
    applyShopeeStatus(data);
    shopeeStatusLoaded = true;
  } catch (_) {
    setConnectionMessage('Status Shopee belum dapat dibaca.', 'error');
    updateMiniStatus(false, false);
  }
}

async function testShopInfo() {
  const button = document.getElementById('testShopee');
  const result = document.getElementById('shopInfoResult');
  if (button) button.disabled = true;
  setConnectionMessage('Menghubungi Shopee Shop API…', 'info');
  if (result) result.className = 'test-result';
  try {
    const response = await fetch('/api/shopee/shop-info', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'shop_info_failed');
    const shop = data.shop || {};
    if (result) {
      result.innerHTML = `<div><small>Shop</small><strong>${escapeHtml(shop.shop_name || shop.name || 'Connected shop')}</strong></div><div><small>Region</small><strong>${escapeHtml(shop.region || shop.country || 'Shopee')}</strong></div><div><small>API status</small><strong>${escapeHtml(shop.status || shop.shop_status || 'Active')}</strong></div>`;
      result.className = 'test-result show';
    }
    if (data.tokenRefreshed) { shopeeStatusLoaded = false; await loadShopeeStatus(true); }
    setConnectionMessage('Shop Info berhasil dibaca dari Shopee.', 'success');
  } catch (_) { setConnectionMessage('Test Shop Info gagal. Cek authorization atau refresh token.', 'error'); }
  finally { if (button) button.disabled = false; }
}

const variantRow = (variant, index) => {
  const status = String(variant?.status || 'NORMAL').toUpperCase();
  const low = Number(variant?.stock) <= 10;
  const optionText = Array.isArray(variant?.options) && variant.options.length
    ? variant.options.map((option) => `${option.tier}: ${option.value}`).join(' · ')
    : variant?.name || `Variant ${index + 1}`;
  return `<div class="variant-live-row">
    <div class="variant-index">V${String(index + 1).padStart(2, '0')}</div>
    <div class="variant-main"><strong>${escapeHtml(variant?.name || `Variant ${index + 1}`)}</strong><small>${escapeHtml(optionText)} · SKU ${escapeHtml(variant?.sku || '—')}</small></div>
    <div><small>Price</small><strong>${formatIDR(variant?.price)}</strong></div>
    <div><small>Stock</small><strong class="${low ? 'stock-low' : ''}">${escapeHtml(variant?.stock ?? 0)}</strong></div>
    <div><span class="tag ${status === 'NORMAL' ? 'success' : 'warning'}">${escapeHtml(status)}</span></div>
  </div>`;
};

const productRow = (product, index) => {
  const status = String(product.status || 'NORMAL').toUpperCase();
  const low = product.variantCount > 0 ? Number(product.lowStockVariantCount) > 0 : Number(product.stock) <= 10;
  const statusClass = status === 'NORMAL' ? 'success' : 'warning';
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const variantLabel = product.hasModel ? ` · ${product.variantCount || variants.length} variants` : '';
  const variantError = product.variantError
    ? `<div class="variant-warning">Variant detail belum terbaca: ${escapeHtml(product.variantError)}</div>`
    : '';
  return `<div class="product-live-item">
    <div class="product-live-row">
      <div class="product-thumb live">${String(index + 1).padStart(2, '0')}</div>
      <div class="product-main"><strong>${escapeHtml(product.name)}</strong><small>Item ${escapeHtml(product.itemId)} · SKU ${escapeHtml(product.sku)}${variantLabel}</small></div>
      <div><small>Price</small><strong>${formatProductPrice(product)}</strong></div>
      <div><small>Total stock</small><strong class="${low ? 'stock-low' : ''}">${escapeHtml(product.stock)}</strong></div>
      <div><span class="tag ${statusClass}">${escapeHtml(status)}</span></div>
    </div>
    ${variants.length ? `<div class="variant-live-list"><div class="variant-head"><span>MODEL VARIANTS</span><strong>${variants.length} synced</strong></div>${variants.map(variantRow).join('')}</div>` : variantError}
  </div>`;
};

async function loadProducts(force = false) {
  if ((productsLoaded && !force) || productsLoading) return;
  productsLoading = true;
  const syncButton = document.getElementById('syncProducts');
  const status = document.getElementById('productStatus');
  const list = document.getElementById('productLiveList');
  if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
  if (status) status.textContent = 'Reading Shopee Product + Model APIs…';
  if (list && !productsLoaded) list.innerHTML = '<div class="product-empty">Loading Shopee products and variants…</div>';
  try {
    const response = await fetch('/api/shopee/products?page_size=50&offset=0&item_status=NORMAL', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (response.status === 401 && data.error === 'shopee_not_connected') {
      if (list) list.innerHTML = '<div class="product-empty"><strong>Shopee belum terhubung.</strong><span>Buka Shopee Connection lalu authorize toko.</span></div>';
      if (status) status.textContent = 'Connection required.';
      return;
    }
    if (!response.ok) throw new Error(data.message || data.error || 'product_sync_failed');
    const products = Array.isArray(data.products) ? data.products : [];
    const variantsLoaded = Number(data.variantCount ?? products.reduce((sum, product) => sum + Number(product.variantCount || 0), 0));
    const lowStock = Number(data.lowStockVariantCount ?? products.filter((product) => Number(product.stock) <= 10).length);
    document.getElementById('productTotal').textContent = String(data.totalCount ?? products.length);
    document.getElementById('productLoaded').textContent = String(data.variantEnrichment ? variantsLoaded : products.length);
    document.getElementById('productLowStock').textContent = String(lowStock);
    document.getElementById('productShopId').textContent = `Shop ID ${data.shopId}`;
    document.getElementById('productTokenState').textContent = data.tokenRefreshed ? 'REFRESHED' : 'AUTO';
    const variantCopy = data.variantEnrichment ? ` · ${variantsLoaded} variant(s) synced` : '';
    if (status) status.textContent = `${products.length} product(s) loaded from Shopee${variantCopy}${data.hasNextPage ? ' · more available' : ''}.`;
    const source = document.getElementById('productSource');
    if (source) source.textContent = data.variantEnrichment ? 'API V2 + MODELS' : 'API V2';
    if (list) list.innerHTML = products.length ? products.map(productRow).join('') : '<div class="product-empty"><strong>No NORMAL products in sandbox.</strong><span>Create or seed a test product in Shopee Sandbox, then press Sync now.</span></div>';
    if (data.tokenRefreshed) { showToast('Token refreshed automatically during product sync.'); shopeeStatusLoaded = false; }
    productsLoaded = true;
  } catch (error) {
    if (status) status.textContent = `Sync failed: ${error.message}`;
    if (list) list.innerHTML = `<div class="product-empty"><strong>Product sync failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
  } finally {
    productsLoading = false;
    if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
  }
}

const setView = (view, { pushHash = true } = {}) => {
  if (!labels[view]) view = 'overview';
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === view));
  if (viewTitle) viewTitle.textContent = labels[view];
  document.title = `AR STORE® — ${labels[view]}`;
  if (pushHash) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  closeSidebar();
  if (view === 'connection') loadShopeeStatus();
  if (view === 'products') loadProducts();
};

navItems.forEach((item) => item.addEventListener('click', () => setView(item.dataset.view)));
document.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.jump)));
menuButton?.addEventListener('click', () => {
  const open = !sidebar?.classList.contains('open');
  sidebar?.classList.toggle('open', open);
  mobileOverlay?.classList.toggle('show', open);
  menuButton.setAttribute('aria-expanded', String(open));
});
mobileOverlay?.addEventListener('click', closeSidebar);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSidebar(); });
window.addEventListener('hashchange', () => setView(location.hash.replace('#', '') || 'overview', { pushHash: false }));

const setupLogout = () => {
  if (!topbarActions || document.getElementById('logoutSeller')) return;
  const button = document.createElement('button');
  button.id = 'logoutSeller';
  button.className = 'logout-button';
  button.type = 'button';
  button.textContent = 'Logout';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
    finally { location.replace('/seller-login/'); }
  });
  topbarActions.appendChild(button);
};

const bootstrapSellerSession = async () => {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { location.replace(`/seller-login/?next=${encodeURIComponent(`${location.pathname}${location.hash}`)}`); return; }
    if (response.ok) setupLogout();
  } catch (_) {}
};

const handleShopeeReturn = () => {
  const params = new URLSearchParams(location.search);
  const result = params.get('shopee');
  if (!result) return;
  if (result === 'connected') showToast('Shopee authorization berhasil. Auto refresh dan Product API siap diuji.');
  if (result === 'error') showToast(`Shopee authorization gagal (${params.get('reason') || 'unknown'}).`);
  params.delete('shopee');
  params.delete('reason');
  history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash || '#connection'}`);
};

renderConnectionCenter();
renderProductsCenter();
handleShopeeReturn();
bootstrapSellerSession();
setView(location.hash.replace('#', '') || 'overview', { pushHash: false });
