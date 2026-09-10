const navItems = [...document.querySelectorAll('.nav-item')];
const panels = [...document.querySelectorAll('.view')];
const viewTitle = document.getElementById('viewTitle');
const sidebar = document.getElementById('sidebar');
const menuButton = document.getElementById('menuButton');
const mobileOverlay = document.getElementById('mobileOverlay');

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

const setView = (view, { pushHash = true } = {}) => {
  if (!labels[view]) view = 'overview';

  navItems.forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === view));
  if (viewTitle) viewTitle.textContent = labels[view];

  document.title = `AR STORE® — ${labels[view]}`;
  if (pushHash) history.replaceState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  closeSidebar();
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

setView(location.hash.replace('#', '') || 'overview', { pushHash: false });
