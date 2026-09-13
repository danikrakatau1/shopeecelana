(() => {
  'use strict';

  const applyReviewerMode = async () => {
    let session = null;
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!response.ok) return;
      session = await response.json();
    } catch (_) {
      return;
    }

    if (session?.user?.role !== 'reviewer' || !session?.readOnly) return;

    document.documentElement.dataset.reviewerMode = 'true';
    if (document.body) document.body.dataset.reviewerMode = 'true';

    if (document.querySelector('[data-reviewer-readonly-pill]')) return;

    const pill = document.createElement('aside');
    pill.className = 'reviewer-readonly-pill';
    pill.dataset.reviewerReadonlyPill = 'true';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.innerHTML = '<strong>Shopee Review Mode</strong><span>Read-only access. Seller-changing actions are blocked server-side.</span>';
    document.body.appendChild(pill);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyReviewerMode, { once: true });
  } else {
    applyReviewerMode();
  }
})();
