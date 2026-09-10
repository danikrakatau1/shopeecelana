(() => {
  if (window.__ARSTORE_HOMEPAGE_MOTION_V1__) return;
  window.__ARSTORE_HOMEPAGE_MOTION_V1__ = true;

  const root = document.documentElement;
  const body = document.body;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = window.matchMedia('(pointer: coarse)');

  if (!body || !document.querySelector('.hero')) return;

  root.classList.add('motion-v1-ready');
  body.dataset.homeMotion = 'v1';

  const raf2 = (callback) => requestAnimationFrame(() => requestAnimationFrame(callback));
  raf2(() => root.classList.add('motion-page-entered'));

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const setIndex = (elements) => {
    [...elements].forEach((element, index) => element.style.setProperty('--i', String(index)));
  };

  const decorateChildren = (elements) => {
    [...elements].forEach((element) => {
      [...element.children].forEach((child, index) => child.style.setProperty('--child-i', String(index)));
    });
  };

  const specs = [
    { element: document.querySelector('.marquee'), cls: 'motion-marquee', threshold: 0.12 },
    { element: document.querySelector('#collection'), cls: 'motion-essentials', threshold: 0.14 },
    { element: document.querySelector('#fit'), cls: 'motion-fit', threshold: 0.16 },
    { element: document.querySelector('#best'), cls: 'motion-best', threshold: 0.13 },
    { element: document.querySelector('.spotlight'), cls: 'motion-spotlight', threshold: 0.08 },
    { element: document.querySelector('.statement'), cls: 'motion-statement', threshold: 0.20 },
    { element: document.querySelector('#why-title')?.closest('section'), cls: 'motion-why', threshold: 0.16 },
    { element: document.querySelector('#lookbook-title')?.closest('section'), cls: 'motion-lookbook', threshold: 0.12 },
    { element: document.querySelector('.proof'), cls: 'motion-proof', threshold: 0.18 },
    { element: document.querySelector('#shopee'), cls: 'motion-shopee', threshold: 0.13 },
    { element: document.querySelector('#faq-title')?.closest('section'), cls: 'motion-faq', threshold: 0.15 },
    { element: document.querySelector('.site-footer'), cls: 'motion-footer', threshold: 0.08 }
  ].filter((item) => item.element);

  specs.forEach(({ element, cls }) => {
    element.classList.add('motion-section', cls);
  });

  setIndex(document.querySelectorAll('#fit .fit-row'));
  decorateChildren(document.querySelectorAll('#fit .fit-row'));
  setIndex(document.querySelectorAll('#best .slide'));
  setIndex(document.querySelectorAll('.motion-why .why-item'));
  setIndex(document.querySelectorAll('.motion-faq .faq-item'));
  setIndex(document.querySelectorAll('.site-footer .footer-links a'));

  if (reduced.matches) {
    specs.forEach(({ element }) => element.classList.add('is-motion-in'));
    document.querySelectorAll('.feature-point').forEach((item) => item.classList.add('is-active'));
    return;
  }

  const observers = new Map();
  specs.forEach(({ element, threshold }) => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-motion-in');
        observer.unobserve(entry.target);
      });
    }, {
      threshold,
      rootMargin: '0px 0px -5% 0px'
    });
    observer.observe(element);
    observers.set(element, observer);
  });

  /* Spotlight narrative: progress drives a tiny visual scale while the nearest
     feature point becomes the active chapter. Mobile keeps the state changes,
     but CSS removes the sticky visual transform. */
  const spotlight = document.querySelector('.motion-spotlight');
  const featurePoints = spotlight ? [...spotlight.querySelectorAll('.feature-point')] : [];
  let spotlightTicking = false;

  const updateSpotlight = () => {
    spotlightTicking = false;
    if (!spotlight) return;

    const rect = spotlight.getBoundingClientRect();
    const travel = Math.max(1, spotlight.offsetHeight - window.innerHeight);
    const progress = clamp((-rect.top) / travel, 0, 1);
    spotlight.style.setProperty('--spot-progress', progress.toFixed(4));

    if (featurePoints.length) {
      const viewportFocus = window.innerHeight * (coarse.matches ? 0.52 : 0.48);
      let nearest = 0;
      let distance = Infinity;
      featurePoints.forEach((item, index) => {
        const itemRect = item.getBoundingClientRect();
        const center = itemRect.top + Math.min(itemRect.height, window.innerHeight) * 0.34;
        const delta = Math.abs(center - viewportFocus);
        if (delta < distance) {
          distance = delta;
          nearest = index;
        }
      });
      featurePoints.forEach((item, index) => item.classList.toggle('is-active', index === nearest));
    }
  };

  const queueSpotlight = () => {
    if (spotlightTicking) return;
    spotlightTicking = true;
    requestAnimationFrame(updateSpotlight);
  };

  if (spotlight) {
    window.addEventListener('scroll', queueSpotlight, { passive: true });
    window.addEventListener('resize', queueSpotlight, { passive: true });
    queueSpotlight();
  }

  /* Scroll velocity is intentionally tiny. It only influences the marquee
     container so native scrolling and the existing hero parallax remain intact. */
  let previousY = window.scrollY;
  let previousTime = performance.now();
  let velocity = 0;
  let velocityTarget = 0;
  let velocityRaf = 0;

  const animateVelocity = () => {
    velocity += (velocityTarget - velocity) * 0.18;
    velocityTarget *= 0.78;
    root.style.setProperty('--motion-velocity', velocity.toFixed(3));
    if (Math.abs(velocity) > 0.02 || Math.abs(velocityTarget) > 0.02) {
      velocityRaf = requestAnimationFrame(animateVelocity);
    } else {
      root.style.setProperty('--motion-velocity', '0');
      velocityRaf = 0;
    }
  };

  window.addEventListener('scroll', () => {
    const now = performance.now();
    const dt = Math.max(8, now - previousTime);
    const dy = window.scrollY - previousY;
    velocityTarget = clamp((dy / dt) * 12, -10, 10);
    previousY = window.scrollY;
    previousTime = now;
    if (!velocityRaf) velocityRaf = requestAnimationFrame(animateVelocity);
  }, { passive: true });

  /* Product-card highlight follows the pointer very lightly. The CSS still owns
     the actual scale, and touch devices never run this branch. */
  if (!coarse.matches) {
    document.querySelectorAll('.product-card').forEach((card) => {
      card.addEventListener('pointermove', (event) => {
        const rect = card.getBoundingClientRect();
        const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
        card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
        card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
      }, { passive: true });
      card.addEventListener('pointerleave', () => {
        card.style.removeProperty('--mx');
        card.style.removeProperty('--my');
      });
    });
  }

  /* Mobile menu links get their own staggered entrance without replacing the
     existing menu behavior in app.js. */
  const menu = document.querySelector('.mobile-menu');
  const menuToggle = document.querySelector('.menu-toggle');
  const menuLinks = menu ? [...menu.querySelectorAll('a')] : [];
  setIndex(menuLinks);

  menuToggle?.addEventListener('click', () => {
    requestAnimationFrame(() => {
      if (menu?.classList.contains('open')) menu.classList.add('motion-menu-open');
      else menu?.classList.remove('motion-menu-open');
    });
  });

  menuLinks.forEach((link) => link.addEventListener('click', () => menu?.classList.remove('motion-menu-open')));

  /* Re-run the page entrance when restored from bfcache only when the page was
     actually discarded, otherwise preserve the user's current scroll context. */
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    root.classList.add('motion-page-entered');
    queueSpotlight();
  });
})();
