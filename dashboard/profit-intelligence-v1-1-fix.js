(() => {
  if (window.__ARSTORE_PROFIT_V11_FIX__) return;
  window.__ARSTORE_PROFIT_V11_FIX__ = true;

  const style = document.createElement('style');
  style.textContent = '.profit-highlight.no-spend strong{color:var(--ink,#111)!important}.profit-highlight.no-spend span{color:var(--muted,#777)!important}';
  document.head.appendChild(style);

  const updateNoSpendState = () => {
    document.querySelectorAll('.profit-campaign-card').forEach((card) => {
      const signal = card.querySelector('.profit-signal')?.textContent?.trim()?.toUpperCase() || '';
      const hppInput = card.querySelector('[data-profit-hpp]');
      const hpp = Number(String(hppInput?.value || '').replace(/[^0-9.-]/g, '')) || 0;
      const highlight = card.querySelector('.profit-highlight');
      const note = highlight?.querySelector('span');
      if (!highlight || !note) return;

      highlight.classList.toggle('no-spend', signal === 'NO SPEND' && hpp > 0);
      if (signal === 'NO SPEND' && hpp > 0) note.textContent = 'No spend yet';
      else if (signal === 'NEED HPP' || hpp <= 0) note.textContent = 'HPP required';
    });
  };

  const observer = new MutationObserver(() => requestAnimationFrame(updateNoSpendState));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('change', () => requestAnimationFrame(updateNoSpendState));
  document.addEventListener('input', () => requestAnimationFrame(updateNoSpendState));
  updateNoSpendState();
})();
