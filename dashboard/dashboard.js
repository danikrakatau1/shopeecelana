const authConnectionStyles = document.createElement('link');
authConnectionStyles.rel = 'stylesheet';
authConnectionStyles.href = './auth-connection.css';
document.head.appendChild(authConnectionStyles);

const navItems = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.view')];
const viewTitle = document.getElementById('viewTitle');
const sidebar = document.getElementById('sidebar');
const menuButton = document.getElementById('menuButton');
const mobileOverlay = document.getElementById('mobileOverlay');
const topbarActions = document.querySelector('.topbar-actions');
const connectionMini = document.querySelector('.connection-mini');

let shopeeStatusLoaded = false;
let sellerSession = null;

const labels = {
  overview: 'Overview',
  products: 'Products',
  orders: 'Orders',
  stock: 'Stock & Pricing',
  logistics: 'Logistics',
  ads: 'Shopee Ads',
  finance: 'Finance',
  connection: 'Shopee Connection',
  settings: 'Settings'
};

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
        <div class="connection-status-copy">
          <span id="connectionDot" class="status-dot warning"></span>
          <div>
            <h2 id="connectionHeadline">Checking connection…</h2>
            <p id="connectionDescription">Memeriksa konfigurasi Worker dan status otorisasi toko.</p>
          </div>
        </div>
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
      <div>
        <span class="eyebrow">Secure connection flow</span>
        <h3>Browser never sees the Partner Key.</h3>
        <p>Signature Shopee dibuat di Cloudflare Worker. Session seller memakai cookie HttpOnly + Secure, sedangkan token Shopee disimpan terenkripsi untuk foundation single-owner ini.</p>
      </div>
      <div class="connection-steps">
        <div><span>01</span><div><strong>Seller Login</strong><small>Owner session diverifikasi sebelum dashboard diberikan.</small></div></div>
        <div><span>02</span><div><strong>Authorize Shopee</strong><small>Worker membuat signed authorization URL.</small></div></div>
        <div><span>03</span><div><strong>Callback + Token</strong><small>Authorization code ditukar server-side.</small></div></div>
        <div><span>04</span><div><strong>Test Shop Info</strong><small>Validasi koneksi menggunakan API toko.</small></div></div>
      </div>
    </article>`;

  document.getElementById('connectShopee')?.addEventListener('click', () => {
    location.href = '/api/shopee/connect';
  });

  document.getElementById('disconnectShopee')?.addEventListener('click', async () => {
    if (!window.confirm('Putuskan koneksi Shopee dari dashboard ini?')) return;
    setConnectionMessage('Memutus koneksi…', 'info');
    try {
      const response = await fetch('/api/shopee/disconnect', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('disconnect_failed');
      setConnectionMessage('Koneksi Shopee diputus.', 'success');
      shopeeStatusLoaded = false;
      await loadShopeeStatus(true);
    } catch (_) {
      setConnectionMessage('Gagal memutus koneksi. Coba lagi.', 'error');
    }
  });

  document.getElementById('testShopee')?.addEventListener('click', testShopInfo);
};

const formatTokenStatus = (expiresAt) => {
  if (!expiresAt) return 'Connected';
  const remaining = expiresAt - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return 'Expired';
  const minutes = Math.max(1, Math.floor(remaining / 60));
  return minutes >= 60 ? `Valid ~${Math.floor(minutes / 60)}h` : `Valid ~${minutes}m`;
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
  if (description) description.textContent = connected
    ? 'AR STORE sudah memiliki authorization token untuk toko ini. Lanjutkan dengan Test Shop Info.'
    : configured
      ? 'Partner credentials sudah tersedia di Worker. Authorize toko AR STORE untuk membuat token.'
      : 'Tambahkan SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY sebagai Cloudflare Worker secrets.';
  if (state) {
    state.textContent = connected ? 'CONNECTED' : configured ? 'READY' : 'SETUP REQUIRED';
    state.className = `connection-state ${connected ? 'connected' : 'pending'}`;
  }

  const partnerId = document.getElementById('partnerIdValue');
  const shopId = document.getElementById('shopIdValue');
  const token = document.getElementById('tokenValue');
  const callback = document.getElementById('callbackValue');
  if (partnerId) partnerId.textContent = status.partnerId || 'Not configured';
  if (shopId) shopId.textContent = status.shopId || 'Not authorized';
  if (token) token.textContent = connected ? formatTokenStatus(status.tokenExpiresAt) : 'Not available';
  if (callback) callback.textContent = status.callbackUrl || '—';

  if (connectButton) {
    connectButton.disabled = !configured;
    connectButton.textContent = connected ? 'Reconnect Shopee' : 'Connect Shopee';
  }
  if (testButton) testButton.disabled = !connected;
  if (disconnectButton) disconnectButton.disabled = !connected;
};

async function loadShopeeStatus(force = false) {
  if (shopeeStatusLoaded && !force) return;
  try {
    const response = await fetch('/api/shopee/status', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      location.replace(`/seller-login/?next=${encodeURIComponent('/dashboard/#connection')}`);
      return;
    }
    if (response.status === 404) {
      setConnectionMessage('Worker backend belum aktif pada deployment ini.', 'error');
      updateMiniStatus(false, false);
      return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'status_failed');
    applyShopeeStatus(data);
    shopeeStatusLoaded = true;
  } catch (_) {
    setConnectionMessage('Status Shopee belum dapat dibaca. Tunggu Worker selesai deploy lalu refresh.', 'error');
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
    const shopName = shop.shop_name || shop.name || 'Connected shop';
    const region = shop.region || shop.country || 'Shopee';
    const status = shop.status || shop.shop_status || 'Active';
    if (result) {
      result.innerHTML = `
        <div><small>Shop</small><strong>${escapeHtml(shopName)}</strong></div>
        <div><small>Region</small><strong>${escapeHtml(region)}</strong></div>
        <div><small>API status</small><strong>${escapeHtml(status)}</strong></div>`;
      result.className = 'test-result show';
    }
    setConnectionMessage('Shop Info berhasil dibaca dari Shopee.', 'success');
  } catch (error) {
    const text = error?.message === 'shopee_token_expired'
      ? 'Token Shopee sudah kedaluwarsa. Gunakan Reconnect Shopee.'
      : 'Test Shop Info gagal. Cek authorization dan permission aplikasi.';
    setConnectionMessage(text, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));

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
};

navItems.forEach((item) => {
  item.addEventListener('click', () => setView(item.dataset.view));
});

document.querySelectorAll('[data-jump]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.jump));
});

menuButton?.addEventListener('click', () => {
  const open = !sidebar?.classList.contains('open');
  sidebar?.classList.toggle('open', open);
  mobileOverlay?.classList.toggle('show', open);
  menuButton.setAttribute('aria-expanded', String(open));
});

mobileOverlay?.addEventListener('click', closeSidebar);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSidebar();
});

window.addEventListener('hashchange', () => {
  setView(location.hash.replace('#', '') || 'overview', { pushHash: false });
});

const setupLogout = () => {
  if (!topbarActions || document.getElementById('logoutSeller')) return;
  const button = document.createElement('button');
  button.id = 'logoutSeller';
  button.className = 'logout-button';
  button.type = 'button';
  button.textContent = 'Logout';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      location.replace('/seller-login/');
    }
  });
  topbarActions.appendChild(button);
};

const bootstrapSellerSession = async () => {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      location.replace(`/seller-login/?next=${encodeURIComponent(`${location.pathname}${location.hash}`)}`);
      return;
    }
    if (response.status === 404) return;
    if (!response.ok) return;
    sellerSession = await response.json();
    setupLogout();
  } catch (_) {
    // The Worker itself protects /dashboard. No client-side credential fallback is used.
  }
};

const handleShopeeReturn = () => {
  const params = new URLSearchParams(location.search);
  const result = params.get('shopee');
  if (!result) return;

  if (result === 'connected') showToast('Shopee authorization berhasil. Jalankan Test Shop Info untuk verifikasi.');
  if (result === 'error') showToast(`Shopee authorization gagal (${params.get('reason') || 'unknown'}).`);

  params.delete('shopee');
  params.delete('reason');
  const clean = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash || '#connection'}`;
  history.replaceState(null, '', clean);
};

renderConnectionCenter();
handleShopeeReturn();
bootstrapSellerSession();
setView(location.hash.replace('#', '') || 'overview', { pushHash: false });
