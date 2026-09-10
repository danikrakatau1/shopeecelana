const header = document.querySelector('.site-header');
const menuToggle = document.querySelector('.menu-toggle');
const mobileMenu = document.querySelector('.mobile-menu');
const menuLinks = mobileMenu ? mobileMenu.querySelectorAll('a') : [];
const cursor = document.querySelector('.cursor');

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

menuLinks.forEach((link) => link.addEventListener('click', closeMenu));
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
  if (!ticking && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
