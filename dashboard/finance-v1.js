(() => {
  const ensureStyle = (href, marker) => {
    if (document.querySelector(`link[${marker}]`)) return;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = href;
    css.setAttribute(marker, 'true');
    document.head.appendChild(css);
  };
  ensureStyle('./finance-v1.css', 'data-finance-v1');
  ensureStyle('./finance-reconciliation-v1-1.css', 'data-finance-v11');

  const panel = document.querySelector('[data-panel="finance"]');
  if (!panel) return;

  let loaded = false;
  let loading = false;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));

  const money = (value, currency = 'IDR') => {
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

  const labelMap = {
    sellerReturnRefund: 'Seller return/refund credit',
    shopeeDiscount: 'Shopee item discount credit',
    buyerPaidShipping: 'Buyer-paid shipping',
    shopeeShippingRebate: 'Shopee shipping rebate',
    shippingDiscount3PL: '3PL shipping discount',
    sellerLostCompensation: 'Seller lost compensation',
    rsfProtectionClaim: 'RSF protection claim',
    fsfProtectionClaim: 'FSF protection claim',
    buyerPaidPackagingFee: 'Buyer-paid packaging',
    originalShopeeDiscount: 'Original Shopee discount',
    sellerVoucher: 'Seller voucher',
    sellerCoinCashback: 'Seller coin cashback',
    actualShippingFee: 'Actual shipping fee',
    reverseShippingFee: 'Reverse shipping fee',
    finalReturnShippingFee: 'Return-to-seller shipping',
    commissionFee: 'Commission fee',
    serviceFee: 'Service fee',
    sellerTransactionFee: 'Seller transaction fee',
    campaignFee: 'Campaign fee',
    processingFee: 'Order processing fee',
    affiliateFee: 'Affiliate commission',
    adsTechnicalFee: 'Ads / technical fee',
    escrowTax: 'Escrow tax',
    withholdingTax: 'Withholding tax',
    shippingFeeSst: 'Shipping fee SST',
    reverseShippingFeeSst: 'Reverse shipping fee SST',
    finalEscrowProductGst: 'Product GST',
    sellerShippingProtectionPremium: 'Shipping protection premium',
    deliveryProtectionPremium: 'Delivery protection premium',
    overseasReturnServiceFee: 'Overseas return service fee',
    salesTaxOnLvg: 'Sales tax on LVG',
    vatOnImportedGoods: 'VAT on imported goods',
    withholdingVatTax: 'Withholding VAT',
    withholdingPitTax: 'Withholding PIT',
    withholdingCitTax: 'Withholding CIT',
    tradeInBonusSeller: 'Trade-in bonus seller',
    fbsFee: 'FBS fee',
    thImportDuty: 'TH import duty'
  };

  const componentRows = (components = {}, type = 'deduction') => {
    const entries = Object.entries(components).filter(([, value]) => Number(value || 0) !== 0);
    if (!entries.length) return `<div class="finance-bridge-row finance-zero"><small>${type === 'credit' ? 'Other credits' : 'Other deductions'}</small><strong>${money(0)}</strong></div>`;
    return entries.map(([key, value]) => `
      <div class="finance-bridge-row ${type}">
        <small>${escapeHtml(labelMap[key] || key)}</small>
        <strong>${type === 'credit' ? '+' : '−'}${money(Math.abs(Number(value || 0)))}</strong>
      </div>`).join('');
  };

  const checkoutRow = (label, value, negative = false) => `
    <div><small>${escapeHtml(label)}</small><strong>${negative && Number(value || 0) ? '−' : ''}${money(Math.abs(Number(value || 0)))}</strong></div>`;

  const orderCard = (record) => {
    if (!record.escrowAvailable) {
      return `<article class="finance-v11-order">
        <div class="finance-v11-head"><div><small>ORDER SN</small><strong>${escapeHtml(record.orderSn)}</strong></div><span class="finance-match partial">ESCROW PENDING</span></div>
        <div class="finance-v11-block"><p>${escapeHtml(record.escrowMessage || 'Escrow detail belum tersedia untuk order ini.')}</p></div>
      </article>`;
    }

    const buyer = record.buyer || {};
    const settlement = record.settlement || {};
    const gap = Number(settlement.reconciliationGap || 0);
    const match = Boolean(settlement.reconciled);
    const buyerGap = Number(buyer.gap || 0);

    return `<article class="finance-v11-order">
      <div class="finance-v11-head">
        <div><small>ORDER SN</small><strong>${escapeHtml(record.orderSn)}</strong><small>${escapeHtml(record.buyerUsername || '—')} · ${escapeHtml(record.orderStatus || '—')}</small></div>
        <span class="finance-match ${match ? '' : 'partial'}">${match ? 'RECONCILED' : 'PARTIAL MATCH'}</span>
      </div>
      <div class="finance-v11-columns">
        <section class="finance-v11-block">
          <h3>Buyer Checkout</h3>
          <p>Snapshot komponen yang dibayar atau dipotong pada sisi pembeli.</p>
          <div class="finance-checkout-grid">
            ${checkoutRow('Buyer paid total', buyer.total)}
            ${checkoutRow('Merchandise subtotal', buyer.merchandise)}
            ${checkoutRow('Buyer shipping', buyer.shipping)}
            ${checkoutRow('Buyer service fee', buyer.serviceFee)}
            ${checkoutRow('Buyer transaction fee', buyer.transactionFee)}
            ${checkoutRow('Buyer tax', buyer.tax)}
            ${checkoutRow('Insurance', buyer.insurance)}
            ${checkoutRow('Packaging fee', buyer.packagingFee)}
            ${checkoutRow('Bulky handling', buyer.bulkyHandlingFee)}
            ${checkoutRow('Seller voucher', buyer.sellerVoucher, true)}
            ${checkoutRow('Shopee voucher', buyer.shopeeVoucher, true)}
            ${checkoutRow('Coins redeemed', buyer.coins, true)}
            ${checkoutRow('Reconstructed checkout', buyer.reconstructed)}
            ${checkoutRow('Checkout residual', buyerGap)}
          </div>
          <div class="finance-v11-note">Checkout residual hanya menunjukkan komponen buyer-side lain yang tidak termasuk dalam ringkasan utama; nilai settlement seller tetap direkonsiliasi memakai Escrow.</div>
        </section>
        <section class="finance-v11-block">
          <h3>Seller Settlement</h3>
          <p>Bridge dari basis pendapatan seller menuju payout Escrow resmi Shopee.</p>
          <div class="finance-bridge">
            <div class="finance-bridge-row"><small>Seller settlement base</small><strong>${money(settlement.base)}</strong></div>
            ${componentRows(settlement.credits, 'credit')}
            ${componentRows(settlement.deductions, 'deduction')}
            <div class="finance-bridge-row total"><small>Reconstructed payout</small><strong>${money(settlement.reconstructedPayout)}</strong></div>
            <div class="finance-bridge-row total"><small>Official expected payout</small><strong>${money(settlement.expectedPayout)}</strong></div>
          </div>
          <div class="finance-gap-box ${match ? '' : 'partial'}"><span>Reconciliation gap</span><strong>${money(gap)}</strong></div>
          <div class="finance-v11-note">Known credits dan deductions mengikuti field Escrow yang dikembalikan Shopee. Gap Rp0 berarti formula komponen yang tersedia cocok dengan expected payout untuk order ini.</div>
        </section>
      </div>
    </article>`;
  };

  panel.innerHTML = `
    <div class="page-intro compact-intro">
      <div><span class="eyebrow">07 / Performance</span><h1>Finance.</h1></div>
      <p>Full reconciliation antara buyer checkout dan seller settlement dari Shopee Payment / Escrow API. Tidak ada angka profit dummy.</p>
    </div>
    <div class="live-strip finance-live-strip">
      <div><span class="live-dot"></span><strong>SHOPEE FINANCE DATA</strong><small id="financeShopId">Waiting for connection</small></div>
      <button id="syncFinance" class="ghost-button" type="button">Sync now ↻</button>
    </div>
    <div class="finance-v11-summary">
      <article class="finance-summary-card"><small>Buyer paid</small><strong id="financeBuyerPaid">—</strong><span>Checkout total returned by Shopee</span></article>
      <article class="finance-summary-card"><small>Merchandise</small><strong id="financeMerchandise">—</strong><span>Buyer merchandise subtotal</span></article>
      <article class="finance-summary-card"><small>Expected payout</small><strong id="financePayout">—</strong><span id="financeCoverage">Escrow coverage —</span></article>
      <article class="finance-summary-card"><small>Reconciliation gap</small><strong id="financeGap">—</strong><span id="financeMatchState">Waiting for sync</span></article>
    </div>
    <article class="panel finance-live-panel">
      <div class="panel-head">
        <div><span class="eyebrow">Finance V1.1</span><h2>Full Reconciliation</h2><span id="financeStatusText" class="muted">Ready to sync.</span><div class="finance-readonly">READ-ONLY · settlement math uses Shopee Escrow fields; HPP/COGS internal toko belum dimasukkan</div></div>
        <span class="connection-state connected">PAYMENT API V2</span>
      </div>
      <div id="financeLiveList" class="finance-v11-list"><div class="finance-empty">Loading Shopee finance…</div></div>
    </article>`;

  const syncButton = document.getElementById('syncFinance');

  async function loadFinance(force = false) {
    if ((loaded && !force) || loading) return;
    loading = true;
    const statusText = document.getElementById('financeStatusText');
    const list = document.getElementById('financeLiveList');
    if (syncButton) { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; }
    if (statusText) statusText.textContent = 'Reconciling Shopee Payment / Escrow fields…';
    if (list && !loaded) list.innerHTML = '<div class="finance-empty">Loading full reconciliation…</div>';

    try {
      const response = await fetch('/api/shopee/finance-v1-1', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'finance_reconciliation_failed');

      const records = Array.isArray(data.records) ? data.records : [];
      const totals = data.totals || {};
      document.getElementById('financeBuyerPaid').textContent = money(totals.buyerPaid || 0);
      document.getElementById('financeMerchandise').textContent = money(totals.merchandise || 0);
      document.getElementById('financePayout').textContent = money(totals.expectedPayout || 0);
      document.getElementById('financeGap').textContent = money(totals.reconciliationGap || 0);
      document.getElementById('financeShopId').textContent = `Shop ID ${data.shopId || '—'}`;
      document.getElementById('financeCoverage').textContent = `Escrow coverage ${data.escrowReady || 0}/${records.length}`;
      document.getElementById('financeMatchState').textContent = data.fullyReconciled ? 'FULL MATCH ✓' : `${totals.reconciled || 0}/${data.escrowReady || 0} reconciled`;

      if (statusText) statusText.textContent = `${records.length} order(s) loaded · ${data.escrowReady || 0} escrow ready · ${totals.reconciled || 0} fully reconciled.`;
      if (list) list.innerHTML = records.length ? records.map(orderCard).join('') : '<div class="finance-empty"><strong>No finance records yet.</strong><span>Create a sandbox order, then press Sync now.</span></div>';
      loaded = true;

      if (data.tokenRefreshed) {
        const toast = document.createElement('div');
        toast.className = 'auth-toast';
        toast.textContent = 'Shopee token refreshed automatically during Finance reconciliation.';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
      }
    } catch (error) {
      if (statusText) statusText.textContent = `Sync failed: ${error.message}`;
      if (list) list.innerHTML = `<div class="finance-empty"><strong>Finance reconciliation failed.</strong><span>${escapeHtml(error.message)}</span></div>`;
    } finally {
      loading = false;
      if (syncButton) { syncButton.disabled = false; syncButton.textContent = 'Sync now ↻'; }
    }
  }

  syncButton?.addEventListener('click', () => loadFinance(true));
  document.querySelector('[data-view="finance"]')?.addEventListener('click', () => setTimeout(() => loadFinance(), 0));
  window.addEventListener('hashchange', () => { if (location.hash === '#finance') loadFinance(); });
  if (location.hash === '#finance') loadFinance();
})();