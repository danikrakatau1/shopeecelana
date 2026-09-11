const header = document.querySelector('.site-header');
const menuToggle = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('.mobile-menu');
const menuLinks = mobileMenu ? mobileMenu.querySelectorAll('a') : [];
const cursor = document.querySelector('.cursor');

// Seller dashboard entry point. Injected here so the landing HTML stays untouched.
const desktopNav = document.querySelector('.main-nav');
if (desktopNav && !desktopNav.querySelector('[data-dashboard-link]')) {
  const dashboardLink = document.createElement('a');
  dashboardLink.href = './dashboard/';
  dashboardLink.dataset.dashboardLink = 'true';
  dashboardLink.textContent = 'Dashboard';
  desktopNav.appendChild(dashboardLink);
}

const mobileNav = mobileMenu?.querySelector('nav');
if (mobileNav && !mobileNav.querySelector('[data-dashboard-link]')) {
  const dashboardLink = document.createElement('a');
  dashboardLink.href = './dashboard/';
  dashboardLink.dataset.dashboardLink = 'true';
  dashboardLink.textContent = '06 / Dashboard';
  mobileNav.appendChild(dashboardLink);
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const createBackgroundVideo = ({ hostSelector, src, wrapClass, preload = 'metadata' }) => {
  const host = document.querySelector(hostSelector);
  if (!host) return null;

  const wrap = document.createElement('div');
  wrap.className = wrapClass;
  wrap.setAttribute('aria-hidden', 'true');

  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = preload;
  video.disablePictureInPicture = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('disablepictureinpicture', '');
  video.setAttribute('tabindex', '-1');

  video.addEventListener('error', () => wrap.remove(), { once: true });
  wrap.appendChild(video);
  host.insertBefore(wrap, host.firstChild);

  return { host, wrap, video };
};

const heroVideo = createBackgroundVideo({
  hostSelector: '.hero',
  src: './assets/video/arstore%201.mp4',
  wrapClass: 'hero-video-wrap',
  preload: 'auto'
});

const shopeeVideo = createBackgroundVideo({
  hostSelector: '.shopee-bridge',
  src: './assets/video/arstore%202.mp4',
  wrapClass: 'shopee-video-wrap',
  preload: 'metadata'
});

/* Video 02 / SHOP AR STORE — full-bleed framing.
   Override the earlier contain treatment so the moving footage becomes the section itself,
   not a video rectangle pasted on top of the taupe background. */
if (shopeeVideo) {
  shopeeVideo.host.style.minHeight = '62svh';
  shopeeVideo.wrap.style.inset = '0';
  shopeeVideo.wrap.style.display = 'block';
  shopeeVideo.video.style.width = '100%';
  shopeeVideo.video.style.height = '100%';
  shopeeVideo.video.style.objectFit = 'cover';
  shopeeVideo.video.style.objectPosition = '50% 42%';
  shopeeVideo.video.style.transform = 'none';
  shopeeVideo.video.style.opacity = '.50';
}

const managedVideos = [heroVideo, shopeeVideo].filter(Boolean);
if (managedVideos.length && !prefersReducedMotion.matches) {
  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const item = managedVideos.find((candidate) => candidate.host === entry.target);
      if (!item) return;

      if (entry.isIntersecting) {
        item.video.play().catch(() => {});
      } else {
        item.video.pause();
      }
    });
  }, { rootMargin: '20% 0px 20% 0px', threshold: 0.01 });

  managedVideos.forEach((item) => videoObserver.observe(item.host));
}

const setHeaderState = () => {
  header?.classList.toggle('scrolled', window.scrollY > 24);
};

setHeaderState();
window.addEventListener('scroll', setHeaderState, { passive: true });

const closeMenu = () => {
  mobileMenu?.classList.remove('open');
  menuToggle?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('menu-open');
};

menuToggle?.addEventListener('click', () => {
  const willOpen = !mobileMenu.classList.contains('open');
  mobileMenu.classList.toggle('open', willOpen);
  menuToggle.setAttribute('aria-expanded', String(willOpen));
  document.body.classList.toggle('menu-open', willOpen);
});

mobileMenu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});

const reveals = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('in');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });

reveals.forEach((element) => revealObserver.observe(element));

const faqItems = document.querySelectorAll('.faq-item');
faqItems.forEach((item) => {
  const button = item.querySelector('.faq-button');
  button?.addEventListener('click', () => {
    const open = item.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
});

const heroArt = document.querySelector('.hero-art');
const heroDisplay = document.querySelector('.hero-display');
let ticking = false;

const renderParallax = () => {
  const y = window.scrollY;
  if (heroArt && y < window.innerHeight * 1.3) {
    heroArt.style.transform = `translate(-50%, calc(-50% + ${Math.min(y * 0.08, 48)}px)) scale(${1 + Math.min(y / 12000, 0.05)})`;
  }
  if (heroDisplay && y < window.innerHeight * 1.3) {
    heroDisplay.style.transform = `translateY(${Math.min(y * 0.045, 36)}px)`;
  }
  ticking = false;
};

window.addEventListener('scroll', () => {
  if (!ticking && !prefersReducedMotion.matches) {
    window.requestAnimationFrame(renderParallax);
    ticking = true;
  }
}, { passive: true });

if (cursor && window.matchMedia('(pointer:fine)').matches) {
  let mouseX = 0;
  let mouseY = 0;
  let cursorX = 0;
  let cursorY = 0;

  window.addEventListener('mousemove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
  }, { passive: true });

  const animateCursor = () => {
    cursorX += (mouseX - cursorX) * 0.18;
    cursorY += (mouseY - cursorY) * 0.18;
    cursor.style.left = `${cursorX}px`;
    cursor.style.top = `${cursorY}px`;
    requestAnimationFrame(animateCursor);
  };
  animateCursor();

  document.querySelectorAll('[data-cursor]').forEach((target) => {
    target.addEventListener('mouseenter', () => {
      cursor.textContent = target.dataset.cursor || 'VIEW';
      cursor.classList.add('show');
    });
    target.addEventListener('mouseleave', () => cursor.classList.remove('show'));
  });
}

document.querySelectorAll('[data-magnetic]').forEach((button) => {
  if (!window.matchMedia('(pointer:fine)').matches) return;
  button.addEventListener('mousemove', (event) => {
    const rect = button.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    button.style.transform = `translate(${x * 0.08}px, ${y * 0.08}px)`;
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = '';
  });
});

const year = document.querySelector('[data-year]');
if (year) year.textContent = new Date().getFullYear();
