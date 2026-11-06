import { siteConfig } from '../layout.js';
import { api, money, esc, fmtDate, qs, $, $$, showFieldErrors } from '../api.js';
import { charmSVG } from '../charms.js';
import { toast, toastError, loaderHTML } from '../ui.js';

const host = $('[data-account]');
const next = (() => { const n = qs('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : null; })();
const STATUS_CHIP = { delivered: 'green', cancelled: 'red', pending_payment: 'amber', delivery_failed: 'red', rto_initiated: 'red' };
let states = [];

async function init() {
  host.innerHTML = loaderHTML();
  const cfg = await siteConfig;
  states = cfg.states || [];
  if (!cfg.user) return renderAuth();
  try { renderAccount(await api('/account')); } catch { renderAuth(); }
}

/* ───────── login / sign up ───────── */
function renderAuth(mode = 'login') {
  $('[data-heading]').textContent = mode === 'login' ? 'Welcome back' : 'Join the boutique';
  host.innerHTML = `<div class="auth-card panel stitched">
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${mode === 'login'}" data-mode="login">Log in</button>
      <button type="button" role="tab" aria-selected="${mode === 'signup'}" data-mode="signup">Create account</button>
    </div>
    <form data-auth novalidate>
      ${mode === 'signup' ? `<div class="field"><label for="u-name">Your name</label><input id="u-name" name="name" autocomplete="name" required></div>` : ''}
      <div class="field"><label for="u-email">Email</label><input id="u-email" name="email" type="email" autocomplete="email" required></div>
      ${mode === 'signup' ? `<div class="field"><label for="u-phone">Mobile <span class="muted">(optional)</span></label><input id="u-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national"></div>` : ''}
      <div class="field"><label for="u-pass">Password</label><input id="u-pass" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required>${mode === 'signup' ? '<span class="hint">At least 8 characters</span>' : ''}</div>
      <button class="btn btn-block" type="submit">${mode === 'login' ? 'Log in' : 'Create my account'}</button>
    </form>
    <p class="muted" style="font-size:.86rem;text-align:center;margin:16px 0 0">No account needed to shop — you can always <a href="/shop.html">check out as a guest</a>.</p>
  </div>`;
  $$('[data-mode]', host).forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  const form = $('[data-auth]', host);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.classList.add('is-loading');
    const body = Object.fromEntries(new FormData(form));
    try {
      const r = await api(mode === 'login' ? '/auth/login' : '/auth/signup', { method: 'POST', body });
      location.href = next || (r.user.role === 'admin' && !next ? '/admin/' : '/account.html');
    } catch (err) {
      showFieldErrors(form, err.details);
      toastError(err);
    } finally { btn.classList.remove('is-loading'); }
  });
}

/* ───────── signed in ───────── */
function renderAccount(data, tab = 'orders') {
  const { user } = data;
  $('[data-heading]').innerHTML = `Hello, <span class="script">${esc(user.name.split(' ')[0])}</span>`;
  host.innerHTML = `<div class="account-layout">
    <nav class="account-nav" role="tablist" aria-label="Account sections">
      <button type="button" role="tab" data-tab="orders" aria-selected="${tab === 'orders'}">My orders</button>
      <button type="button" role="tab" data-tab="addresses" aria-selected="${tab === 'addresses'}">Addresses</button>
      <button type="button" role="tab" data-tab="profile" aria-selected="${tab === 'profile'}">Profile</button>
      ${user.role === 'admin' ? '<a class="btn btn-matcha btn-sm" href="/admin/">Shop admin</a>' : ''}
      <button type="button" class="link-btn" data-logout style="margin-top:8px">Log out</button>
    </nav>
    <section class="panel stitched" data-pane></section>
  </div>`;
  $$('[data-tab]', host).forEach((b) => b.addEventListener('click', () => renderAccount(data, b.dataset.tab)));
  $('[data-logout]', host).addEventListener('click', async () => { await api('/auth/logout', { method: 'POST', body: {} }); location.href = '/'; });
  const pane = $('[data-pane]', host);
  ({ orders: ordersPane, addresses: addressesPane, profile: profilePane })[tab](pane, data);
}

function ordersPane(pane, data) {
  if (!data.orders.length) {
    pane.innerHTML = `<div class="empty-state">${charmSVG('cupcake', { size: 90 })}<h2>No orders yet</h2><p class="muted">Your first little treasure is waiting.</p><a class="btn" href="/shop.html">Explore the Collection</a></div>`;
    return;
  }
  pane.innerHTML = `<h2>My orders</h2><ul class="order-rows">${data.orders.map((o) => `<li class="order-row">
    ${o.image ? `<img src="${esc(o.image)}" alt="">` : '<span></span>'}
    <div><b>${esc(o.order_number)}</b><div class="muted" style="font-size:.86rem">${fmtDate(o.created_at)} · ${o.items} item${o.items === 1 ? '' : 's'} · ${money(o.total)}</div>
      <span class="chip ${STATUS_CHIP[o.status] || ''}">${esc(o.status.replace(/_/g, ' '))}</span> <span class="chip ${o.payment_status === 'paid' ? 'green' : 'grey'}">${esc(o.payment_status.replace(/_/g, ' '))}</span></div>
    <a class="btn btn-ghost btn-sm" href="/track.html?order=${encodeURIComponent(o.order_number)}">Track</a></li>`).join('')}</ul>`;
}

const stateOptions = (sel) => `<option value="">Select state</option>${states.map((s) => `<option${s === sel ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;

function addressesPane(pane, data) {
  pane.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h2>Saved addresses</h2><button class="btn btn-sm" type="button" data-new>+ Add address</button></div>
    <div class="addr-cards">${data.addresses.map((a) => `<div class="addr-card">
      <b>${esc(a.name)}</b>${a.label ? ` · ${esc(a.label)}` : ''} ${a.is_default ? '<span class="chip green">Default</span>' : ''}<br>
      ${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}<br>${esc(a.city)}, ${esc(a.state)} – ${esc(a.pincode)}<br><span class="muted">☎ ${esc(a.phone)}</span>
      <div class="acts"><button class="link-btn" type="button" data-edit="${a.id}">Edit</button><button class="link-btn" type="button" data-del="${a.id}">Remove</button></div></div>`).join('') || '<p class="muted">No saved addresses yet — they\'re saved automatically when you check out, too.</p>'}</div>
    <form data-addr-form hidden novalidate style="margin-top:22px"></form>`;
  const form = $('[data-addr-form]', pane);
  const openForm = (a = {}) => {
    form.hidden = false;
    form.innerHTML = `<h3>${a.id ? 'Edit address' : 'New address'}</h3>
      <div class="grid-2"><div class="field"><label>Name</label><input name="name" value="${esc(a.name || data.user.name)}"></div>
      <div class="field"><label>Mobile</label><input name="phone" inputmode="numeric" value="${esc(a.phone || data.user.phone || '')}"></div></div>
      <div class="field"><label>House / flat, street</label><input name="line1" value="${esc(a.line1 || '')}"></div>
      <div class="field"><label>Area, landmark</label><input name="line2" value="${esc(a.line2 || '')}"></div>
      <div class="grid-3"><div class="field"><label>PIN code</label><input name="pincode" inputmode="numeric" maxlength="6" value="${esc(a.pincode || '')}"></div>
      <div class="field"><label>City</label><input name="city" value="${esc(a.city || '')}"></div>
      <div class="field"><label>State</label><select name="state">${stateOptions(a.state)}</select></div></div>
      <div class="grid-2"><div class="field"><label>Label (Home, Work…)</label><input name="label" value="${esc(a.label || '')}"></div>
      <label class="check" style="margin-top:22px"><input type="checkbox" name="isDefault" ${a.is_default ? 'checked' : ''}> Make this my default</label></div>
      <div style="display:flex;gap:10px"><button class="btn" type="submit">Save address</button><button class="btn btn-ghost" type="button" data-cancel>Cancel</button></div>`;
    $('[data-cancel]', form).onclick = () => { form.hidden = true; };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      body.isDefault = !!body.isDefault;
      try {
        await api(a.id ? `/account/addresses/${a.id}` : '/account/addresses', { method: a.id ? 'PUT' : 'POST', body });
        toast({ title: 'Address saved', icon: 'heart' });
        renderAccount(await api('/account'), 'addresses');
      } catch (err) { showFieldErrors(form, err.details); toastError(err); }
    };
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('[data-new]', pane).onclick = () => openForm();
  $$('[data-edit]', pane).forEach((b) => { b.onclick = () => openForm(data.addresses.find((a) => a.id === Number(b.dataset.edit))); });
  $$('[data-del]', pane).forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this address?')) return;
      await api(`/account/addresses/${b.dataset.del}`, { method: 'DELETE' });
      renderAccount(await api('/account'), 'addresses');
    };
  });
}

function profilePane(pane, data) {
  pane.innerHTML = `<h2>Profile</h2><form data-profile novalidate style="max-width:480px">
    <div class="field"><label>Name</label><input name="name" value="${esc(data.user.name)}"></div>
    <div class="field"><label>Email</label><input value="${esc(data.user.email)}" disabled></div>
    <div class="field"><label>Mobile</label><input name="phone" inputmode="numeric" value="${esc(data.user.phone || '')}"></div>
    <hr class="hr-dots">
    <h3>Change password <span class="muted" style="font-size:.85rem;font-family:var(--f-body)">(optional)</span></h3>
    <div class="field"><label>Current password</label><input name="currentPassword" type="password" autocomplete="current-password"></div>
    <div class="field"><label>New password</label><input name="newPassword" type="password" autocomplete="new-password" minlength="8"></div>
    <button class="btn" type="submit">Save changes</button></form>`;
  const form = $('[data-profile]', pane);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      await api('/account', { method: 'PATCH', body });
      toast({ title: 'Saved!', text: 'Your profile is up to date', icon: 'star' });
      renderAccount(await api('/account'), 'profile');
    } catch (err) { showFieldErrors(form, err.details); toastError(err); }
  };
}

init();
