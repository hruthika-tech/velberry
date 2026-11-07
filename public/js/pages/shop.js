import '../layout.js';
import { api, esc, qs, $ } from '../api.js';
import { charmSVG } from '../charms.js';
import { productCard, bindQuickAdd, loaderHTML } from '../ui.js';

const fromPath = location.pathname.match(/^\/collection\/([\w-]+)/)?.[1];
const state = { category: fromPath || qs('category') || '', q: qs('q') || '', sort: '' };
const grid = $('[data-grid]');
const byId = new Map();
bindQuickAdd(grid, byId);

let categories = [];
async function init() {
  categories = await api('/categories');
  renderTabs();
  $('#q').value = state.q;
  await load();
}

function renderTabs() {
  const tabs = [{ slug: '', name: 'Everything', icon: 'heart' }, ...categories.filter((c) => c.productCount)];
  $('[data-tabs]').innerHTML = tabs.map((c) => `<a href="${c.slug ? `/collection/${c.slug}` : '/shop.html'}" data-slug="${c.slug}" aria-current="${c.slug === state.category}">${charmSVG(c.icon, { size: 26 })}${esc(c.name)}</a>`).join('');
  const cat = categories.find((c) => c.slug === state.category);
  $('[data-title]').textContent = cat ? cat.name : 'The Boutique';
  $('[data-intro]').textContent = cat?.description || 'Every little treasure we make, all in one sweet display case.';
  document.title = `${cat ? cat.name : 'The Boutique'} — CLAYSLAY`;
}

async function load() {
  grid.innerHTML = loaderHTML();
  const params = new URLSearchParams();
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  if (state.sort) params.set('sort', state.sort);
  try {
    const products = await api(`/products?${params}`);
    products.forEach((p) => byId.set(p.id, p));
    $('[data-count]').textContent = `${products.length} charm${products.length === 1 ? '' : 's'}`;
    grid.innerHTML = products.length ? products.map(productCard).join('')
      : `<div class="empty-state" style="grid-column:1/-1">${charmSVG('bunny', { size: 96 })}<h3>No charms found</h3><p class="muted">Try another word, or <a href="/shop.html">see everything</a>.</p></div>`;
  } catch (e) {
    grid.innerHTML = `<p class="notice error">${esc(e.message)}</p>`;
  }
}

// Tabs switch in place (no full reload) while keeping real, shareable URLs
$('[data-tabs]').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-slug]');
  if (!a) return;
  e.preventDefault();
  state.category = a.dataset.slug;
  history.pushState(null, '', a.getAttribute('href'));
  renderTabs();
  load();
});
addEventListener('popstate', () => {
  state.category = location.pathname.match(/^\/collection\/([\w-]+)/)?.[1] || '';
  renderTabs();
  load();
});
let t;
$('#q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });

init();
