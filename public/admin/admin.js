/**
 * Velberry studio admin (hash-routed SPA). All data comes from /api/admin/* which is protected
 * server-side by the admin role — this page only renders.
 */
import { api, money, esc, fmtDate, fmtDateTime, $, $$, showFieldErrors } from '/js/api.js';
import { toast, toastError, loaderHTML } from '/js/ui.js';
import { CHARM_NAMES, charmSVG } from '/js/charms.js';
import { boardHTML, previewCurtain } from '/js/curtain.js';

const view = $('[data-view]');
const STATUS_LABELS = {
  pending_payment: 'Awaiting payment', abandoned: 'Checkout expired', paid: 'Paid — to prepare', preparing: 'Being prepared', packed: 'Packed',
  ready_to_ship: 'Ready for pickup', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', delivery_failed: 'Delivery failed',
  rto_initiated: 'Returning (RTO)', rto_delivered: 'Returned (RTO)', cancelled: 'Cancelled',
};
const STATUS_CHIP = { delivered: 'green', cancelled: 'red', delivery_failed: 'red', rto_initiated: 'red', rto_delivered: 'grey', pending_payment: 'amber', abandoned: 'grey', paid: 'amber' };
const PAY_CHIP = { paid: 'green', pending: 'amber', failed: 'red', refunded: 'grey', partially_refunded: 'grey', expired: 'grey', captured: 'green', authorized: 'amber', created: 'grey' };
const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;
const statusChip = (s) => chip(STATUS_LABELS[s] || s, STATUS_CHIP[s] || '');
const payChip = (s) => chip(String(s).replace(/_/g, ' '), PAY_CHIP[s] || '');

/* ═════════════ boot & routing ═════════════ */
async function boot() {
  const cfg = await api('/config');
  if (!cfg.user || cfg.user.role !== 'admin') { location.href = `/account.html?next=${encodeURIComponent('/admin/')}`; return; }
  $('[data-me]').textContent = cfg.user.email;
  $('[data-logout]').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST', body: {} }); location.href = '/'; });
  addEventListener('hashchange', route);
  route();
}

function route() {
  const [section = 'dashboard', arg] = location.hash.slice(1).split('/');
  $$('[data-nav]').forEach((a) => { if (a.dataset.nav === section) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  view.innerHTML = loaderHTML('Loading…');
  const r = { dashboard, orders: arg ? () => orderDetail(decodeURIComponent(arg)) : orders, products: arg ? () => productEditor(arg) : products, categories, notifications, setup, 'todays-special': todaysSpecial }[section] || dashboard;
  Promise.resolve(r()).catch((e) => { view.innerHTML = `<p class="notice error">${esc(e.message)}</p>`; });
  scrollTo(0, 0);
}

/* ═════════════ dashboard ═════════════ */
async function dashboard() {
  const days = Number(sessionStorage.getItem('adm_days') || 30);
  const s = await api(`/admin/stats?days=${days}`);
  view.innerHTML = `
    <div class="adm-head"><div><h1>Good day, baker ✿</h1><div class="sub">Here's how the little shop is doing.</div></div>
      <div class="filters" style="margin:0"><label class="sr-only" for="days">Range</label>
      <select class="input" id="days">${[7, 30, 90, 365].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select></div></div>
    <div class="kpis">
      ${kpi('Revenue (net)', money(s.revenue), s.refunded ? `${money(s.refunded)} refunded` : 'all time, after refunds')}
      ${kpi('Paid orders', s.totalOrders, 'all time')}
      ${kpi('To prepare & ship', s.pendingOrders, 'paid, not yet shipped')}
      ${kpi('In transit', s.inTransit, 'with the courier')}
      ${kpi('Delivered', s.completedOrders, 'completed')}
      ${kpi('Charms sold', s.productsSold, 'units, excl. cancelled')}
      ${kpi('Awaiting payment', s.awaitingPayment, 'open checkouts')}
    </div>
    <div class="dash-grid">
      <section class="card"><h2>Revenue per day <small>last ${s.days} days · paid orders</small></h2><div class="chart" data-rev></div></section>
      <section class="card"><h2>Best sellers <small>units sold</small></h2>${hbars(s.bestSellers)}</section>
      <section class="card"><h2>Recent orders <a class="text-link" href="#orders" style="font-size:.85rem">All orders</a></h2>
        <div class="tbl-wrap" style="box-shadow:none"><table class="tbl"><tbody>${s.recentOrders.map((o) => `<tr data-href="#orders/${esc(o.order_number)}">
          <td><b>${esc(o.order_number)}</b><div class="muted" style="font-size:.8rem">${esc(o.customer_name)} · ${fmtDate(o.created_at)}</div></td>
          <td>${statusChip(o.status)}</td><td class="num">${money(o.total)}</td></tr>`).join('') || '<tr><td class="muted">No orders yet</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2>Low stock <a class="text-link" href="#products" style="font-size:.85rem">Inventory</a></h2>
        ${s.lowStock.length ? `<ul class="history">${s.lowStock.map((p) => `<li><a href="#products/${p.id}"><b>${esc(p.name)}</b></a> — ${p.stock <= 0 || p.sold_out ? chip('Sold out', 'red') : chip(`${p.stock} left`, 'amber')}</li>`).join('')}</ul>` : '<p class="muted">Everything is well stocked 🎀</p>'}
        <h2 style="margin-top:20px">Orders by status</h2>${statusBars(s.byStatus)}</section>
    </div>`;
  $('#days').addEventListener('change', (e) => { sessionStorage.setItem('adm_days', e.target.value); dashboard(); });
  revenueChart($('[data-rev]'), s.daily, s.days);
  bindRowLinks(view);
}

const kpi = (k, v, s) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

function hbars(rows) {
  if (!rows.length) return '<p class="chart-empty">No sales yet — your first order will appear here.</p>';
  const max = Math.max(...rows.map((r) => r.qty));
  return `<div class="hbars">${rows.map((r) => `<div class="hbar" title="${esc(r.name)}: ${r.qty} sold, ${money(r.revenue)}">
    ${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span></span>'}
    <div><div>${esc(r.name)}</div><div class="track"><div class="fill" style="width:${(r.qty / max) * 100}%"></div></div></div>
    <div class="val">${r.qty}<div class="muted" style="font-size:.74rem;font-weight:600">${money(r.revenue)}</div></div></div>`).join('')}</div>`;
}

function statusBars(rows) {
  if (!rows.length) return '<p class="muted">No orders yet.</p>';
  const max = Math.max(...rows.map((r) => r.n));
  return `<div class="hbars">${rows.sort((a, b) => b.n - a.n).map((r) => `<div class="hbar" style="grid-template-columns:120px 1fr auto">
    <span style="font-size:.82rem">${esc(STATUS_LABELS[r.status] || r.status)}</span><div class="track" style="margin:0"><div class="fill" style="width:${(r.n / max) * 100}%"></div></div><span class="val">${r.n}</span></div>`).join('')}</div>`;
}

/** Column chart: one series, thin bars with 2px gaps & rounded tops, hover tooltip, sr-only table. */
function revenueChart(host, daily, days) {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const pts = [];
  const shopDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let i = days - 1; i >= 0; i--) {
    const d = shopDay.format(new Date(Date.now() - i * 86400e3)); // YYYY-MM-DD in India time, matching the server
    pts.push({ day: d, revenue: byDay.get(d)?.revenue || 0, orders: byDay.get(d)?.orders || 0 });
  }
  if (!pts.some((p) => p.revenue)) { host.innerHTML = '<p class="chart-empty">No paid orders in this period yet.</p>'; return; }
  const W = 640; const H = 220; const L = 54; const B = 24; const T = 8;
  const max = Math.max(...pts.map((p) => p.revenue));
  const nice = niceMax(max);
  const bw = (W - L) / pts.length;
  const gap = Math.min(2, bw * 0.3);
  const y = (v) => T + (H - T - B) * (1 - v / nice);
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(pts.length / 6);
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day for the last ${days} days">
    <g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
    <g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t ? '₹' + compact(t / 100) : '0'}</text>`).join('')}
      ${pts.map((p, i) => (i % labelEvery === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${fmtDate(p.day, { day: 'numeric', month: 'short' })}</text>` : '')).join('')}</g>
    ${pts.map((p, i) => {
      const x = L + i * bw + gap / 2;
      const h = Math.max(0, H - B - y(p.revenue));
      const w = Math.max(1, bw - gap);
      const r = Math.min(4, w / 2, h);
      const bar = h > 0 ? `<path class="bar" data-i="${i}" d="M${x} ${H - B} V${H - B - h + r} Q${x} ${H - B - h} ${x + r} ${H - B - h} H${x + w - r} Q${x + w} ${H - B - h} ${x + w} ${H - B - h + r} V${H - B} Z"/>` : '';
      return `<rect class="bar-hit" data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/>${bar}`;
    }).join('')}
  </svg><div class="chart-tip"></div>
  <table class="sr-only"><caption>Revenue per day</caption><tr><th>Date</th><th>Revenue</th><th>Orders</th></tr>${pts.filter((p) => p.revenue).map((p) => `<tr><td>${p.day}</td><td>${money(p.revenue)}</td><td>${p.orders}</td></tr>`).join('')}</table>`;
  const tip = $('.chart-tip', host);
  const svg = $('svg', host);
  svg.addEventListener('pointermove', (e) => {
    const hit = e.target.closest('[data-i]');
    $$('.bar.is-hot', svg).forEach((b) => b.classList.remove('is-hot'));
    if (!hit) { tip.classList.remove('show'); return; }
    const p = pts[hit.dataset.i];
    svg.querySelector(`.bar[data-i="${hit.dataset.i}"]`)?.classList.add('is-hot');
    const sr = svg.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const scale = sr.width / W;
    tip.style.left = `${(L + hit.dataset.i * bw + bw / 2) * scale + (sr.left - hr.left)}px`;
    tip.style.top = `${y(p.revenue) * scale}px`;
    tip.innerHTML = `<b>${fmtDate(p.day)}</b> · ${money(p.revenue)} · ${p.orders} order${p.orders === 1 ? '' : 's'}`;
    tip.classList.add('show');
  });
  svg.addEventListener('pointerleave', () => { tip.classList.remove('show'); $$('.bar.is-hot', svg).forEach((b) => b.classList.remove('is-hot')); });
}
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v || 1)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const compact = (v) => (v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : String(Math.round(v)));

function bindRowLinks(root) {
  root.addEventListener('click', (e) => {
    if (e.target.closest('a, button, input, select')) return;
    const tr = e.target.closest('tr[data-href]');
    if (tr) location.hash = tr.dataset.href;
  });
}

/* ═════════════ orders ═════════════ */
const orderFilters = { q: '', status: '', payment: '', shipping: '', from: '', to: '', includeAbandoned: '', page: 1 };
async function orders() {
  view.innerHTML = `<div class="adm-head"><div><h1>Orders</h1><div class="sub">Search, filter and fulfil.</div></div></div>
    <form class="filters" data-filters>
      <input class="input" type="search" name="q" placeholder="Order no., name, email, phone, AWB…" value="${esc(orderFilters.q)}">
      <select class="input" name="status"><option value="">Any status</option>${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${orderFilters.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select class="input" name="payment"><option value="">Any payment</option>${['paid', 'pending', 'refunded', 'partially_refunded', 'expired'].map((p) => `<option ${orderFilters.payment === p ? 'selected' : ''} value="${p}">${p.replace('_', ' ')}</option>`).join('')}</select>
      <select class="input" name="shipping"><option value="">Any shipping</option>
        ${[['none', 'Not shipped yet'], ['pickup', 'Pickup scheduled'], ['transit', 'In transit'], ['delivered', 'Delivered']].map(([v, l]) => `<option value="${v}" ${orderFilters.shipping === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="muted" style="font-size:.85rem">From <input class="input" type="date" name="from" value="${orderFilters.from}"></label>
      <label class="muted" style="font-size:.85rem">To <input class="input" type="date" name="to" value="${orderFilters.to}"></label>
      <label class="check" style="font-size:.85rem"><input type="checkbox" name="includeAbandoned" value="1" ${orderFilters.includeAbandoned ? 'checked' : ''}> show expired checkouts</label>
    </form><div data-list>${loaderHTML()}</div>`;
  const form = $('[data-filters]');
  let t;
  form.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const f = new FormData(form);
      Object.assign(orderFilters, Object.fromEntries(['q', 'status', 'payment', 'shipping', 'from', 'to'].map((k) => [k, f.get(k) || ''])), { includeAbandoned: f.get('includeAbandoned') || '', page: 1 });
      loadOrders();
    }, 250);
  });
  loadOrders();
}

async function loadOrders() {
  const host = $('[data-list]');
  const params = new URLSearchParams(Object.entries(orderFilters).filter(([, v]) => v));
  const r = await api(`/admin/orders?${params}`);
  host.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th class="num">Items</th><th class="num">Total</th><th>Payment</th><th>Status</th><th>Courier / AWB</th></tr></thead><tbody>
    ${r.rows.map((o) => `<tr data-href="#orders/${esc(o.order_number)}"><td><b>${esc(o.order_number)}</b></td><td>${fmtDateTime(o.created_at)}</td>
      <td>${esc(o.customer_name)}<div class="muted" style="font-size:.78rem">${esc(o.customer_email)}</div></td><td class="num">${o.items}</td><td class="num">${money(o.total)}</td>
      <td>${payChip(o.payment_status)}</td><td>${statusChip(o.status)}</td><td>${o.courier_name ? `${esc(o.courier_name)}<div class="muted" style="font-size:.78rem">${esc(o.awb_code || '')}</div>` : '<span class="muted">—</span>'}</td></tr>`).join('')
      || '<tr><td colspan="8" class="muted" style="text-align:center;padding:30px">No orders match these filters.</td></tr>'}
    </tbody></table></div>
    <div class="pager"><span class="muted">${r.total} order${r.total === 1 ? '' : 's'}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-p="-1" ${r.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${r.page} of ${Math.max(1, r.pages)}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-p="1" ${r.page >= r.pages ? 'disabled' : ''}>Next ›</button></div>`;
  $$('[data-p]', host).forEach((b) => b.addEventListener('click', () => { orderFilters.page += Number(b.dataset.p); loadOrders(); }));
  bindRowLinks(host);
}

async function orderDetail(number) {
  const o = await api(`/admin/orders/${encodeURIComponent(number)}`);
  const s = o.shipmentRaw;
  const canRefund = ['paid', 'partially_refunded'].includes(o.paymentStatus);
  const nextStatuses = o.allowedTransitions.filter((t) => t !== 'cancelled');
  view.innerHTML = `
    <div class="adm-head"><div><a href="#orders" class="muted">← Orders</a><h1>${esc(o.orderNumber)}</h1>
      <div class="sub">${fmtDateTime(o.createdAt)} · ${statusChip(o.status)} ${payChip(o.paymentStatus)}</div></div>
      <div class="actions-row"><a class="btn btn-ghost btn-sm" href="/track.html?order=${encodeURIComponent(o.orderNumber)}" target="_blank" rel="noopener">Customer view ↗</a></div></div>
    <div class="od-grid">
      <div style="display:grid;gap:16px">
        <section class="card"><h2>Items</h2>
          <table class="od-items">${o.items.map((i) => `<tr><td style="width:56px">${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}</td>
            <td><b>${esc(i.name)}</b>${i.variantName ? ` · ${esc(i.variantName)}` : ''}<div class="muted" style="font-size:.8rem">${esc(i.sku || '')}</div></td>
            <td class="num">${i.quantity} × ${money(i.unitPrice)}</td><td class="num" style="text-align:right"><b>${money(i.lineTotal)}</b></td></tr>`).join('')}</table>
          <div style="max-width:280px;margin-left:auto;margin-top:8px">
            <div class="sum-row"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
            <div class="sum-row"><span>Delivery</span><span>${money(o.shippingFee)}</span></div>
            <div class="sum-row total"><span>Total</span><span>${money(o.total)}</span></div>
            ${o.refundedAmount ? `<div class="sum-row"><span>Refunded</span><span>−${money(o.refundedAmount)}</span></div>` : ''}
          </div>
          ${o.giftNote ? `<p class="notice" style="margin-top:12px">🎁 Gift note: “${esc(o.giftNote)}”</p>` : ''}
        </section>

        <section class="card"><h2>Fulfilment</h2>
          ${nextStatuses.length ? `<div class="field"><label>Move order to</label><div class="actions-row">${nextStatuses.map((t) => `<button class="btn btn-sm ${t === 'preparing' || t === 'packed' ? '' : 'btn-ghost'}" type="button" data-status="${t}">${esc(STATUS_LABELS[t])}</button>`).join('')}</div></div>` : ''}
          ${s ? `<dl class="kv" style="margin-top:8px">
              <dt>Provider</dt><dd>${esc(s.provider)}</dd><dt>Courier</dt><dd>${esc(s.courier_name || '—')}</dd>
              <dt>AWB</dt><dd><b>${esc(s.awb_code || '—')}</b></dd><dt>Shipment status</dt><dd>${esc(s.status)}</dd>
              ${s.pickup_scheduled_at ? `<dt>Pickup</dt><dd>${esc(s.pickup_scheduled_at)}</dd>` : ''}
              ${s.etd ? `<dt>ETD</dt><dd>${esc(s.etd)}</dd>` : ''}
              ${s.tracking_url ? `<dt>Tracking</dt><dd><a href="${esc(s.tracking_url)}" target="_blank" rel="noopener">Open ↗</a></dd>` : ''}
              ${s.label_url ? `<dt>Label</dt><dd><a href="${esc(s.label_url)}" target="_blank" rel="noopener">Download shipping label ↗</a></dd>` : ''}
              ${s.last_synced_at ? `<dt>Last synced</dt><dd>${fmtDateTime(s.last_synced_at)}</dd>` : ''}
            </dl>
            <div class="actions-row" style="margin-top:12px">
              ${s.provider === 'shiprocket' && (!s.awb_code || !s.pickup_scheduled_at) ? '<button class="btn btn-sm" type="button" data-ship>Resume Shiprocket booking</button>' : ''}
              ${s.provider === 'shiprocket' && s.awb_code ? '<button class="btn btn-ghost btn-sm" type="button" data-sync>Refresh tracking</button>' : ''}
              ${s.provider === 'shiprocket' && s.awb_code && !s.label_url && s.status !== 'cancelled' ? '<button class="btn btn-ghost btn-sm" type="button" data-label>Generate label</button>' : ''}
            </div>`
          : o.paymentStatus === 'paid' && !['cancelled'].includes(o.status) ? `
            <p class="muted" style="font-size:.9rem">No shipment yet. Book with Shiprocket (creates the shipment, assigns a courier & AWB and schedules pickup), or record one you booked yourself.</p>
            <div class="actions-row"><button class="btn btn-sm" type="button" data-couriers>Book with Shiprocket</button><button class="btn btn-ghost btn-sm" type="button" data-manual-open>Record manual shipment</button></div>
            <div data-courier-box></div>
            <form class="subform" data-manual hidden novalidate>
              <div class="grid-2"><div class="field"><label>Courier</label><input name="courierName" placeholder="India Post, Delhivery…"></div><div class="field"><label>Tracking / AWB no.</label><input name="awb"></div></div>
              <div class="field"><label>Tracking link (optional)</label><input name="trackingUrl" placeholder="https://"></div>
              <button class="btn btn-sm" type="submit">Mark as shipped</button></form>` : '<p class="muted">Shipping opens once the order is paid.</p>'}
        </section>

        <section class="card"><h2>History</h2><ul class="history">${o.history.map((h) => `<li><time>${fmtDateTime(h.created_at)} · ${esc(h.actor)}</time>${h.from_status !== h.to_status ? `<b>${esc(STATUS_LABELS[h.to_status] || h.to_status)}</b> ` : ''}${esc(h.note || '')}</li>`).join('')}</ul>
          ${o.trackingEvents.length ? `<h2 style="margin-top:18px">Courier scans</h2><ul class="history">${o.trackingEvents.map((e) => `<li><time>${fmtDateTime(e.occurred_at)}${e.location ? ` · ${esc(e.location)}` : ''}</time>${esc(e.description || e.status)}</li>`).join('')}</ul>` : ''}
        </section>
      </div>

      <div style="display:grid;gap:16px;align-content:start">
        <section class="card"><h2>Customer</h2>
          <dl class="kv"><dt>Name</dt><dd>${esc(o.customer.name)}</dd><dt>Email</dt><dd><a href="mailto:${esc(o.customer.email)}">${esc(o.customer.email)}</a></dd>
          <dt>Phone</dt><dd><a href="tel:${esc(o.customer.phone)}">${esc(o.customer.phone)}</a></dd><dt>Account</dt><dd>${o.userId ? 'Registered' : 'Guest'}</dd>
          <dt>Ship to</dt><dd>${esc(o.address.name)} · ${esc(o.address.phone)}<br>${esc(o.address.line1)}${o.address.line2 ? `, ${esc(o.address.line2)}` : ''}<br>${esc(o.address.city)}, ${esc(o.address.state)} – ${esc(o.address.pincode)}</dd></dl>
        </section>
        <section class="card"><h2>Payment</h2>
          ${o.payments.length ? `<ul class="history">${o.payments.map((p) => `<li><time>${fmtDateTime(p.created_at)}</time>${payChip(p.status)} ${money(p.amount)} · ${esc(p.method || '')}<div class="muted" style="font-size:.78rem">${esc(p.provider_payment_id)}${p.error_reason ? ` — ${esc(p.error_reason)}` : ''}</div></li>`).join('')}</ul>` : '<p class="muted">No payment attempts yet.</p>'}
          ${o.razorpayOrderId ? `<p class="muted" style="font-size:.78rem;margin-top:8px">Razorpay order: ${esc(o.razorpayOrderId)}</p>` : ''}
          ${o.refunds.length ? `<h3 style="font-size:1rem;margin-top:12px">Refunds</h3><ul class="history">${o.refunds.map((r) => `<li><time>${fmtDateTime(r.created_at)}</time>${money(r.amount)} · ${esc(r.status)}<div class="muted" style="font-size:.78rem">${esc(r.provider_refund_id || '')} ${esc(r.reason || '')}</div></li>`).join('')}</ul>` : ''}
          ${canRefund ? `<form class="subform" data-refund novalidate><div class="field"><label>Refund amount (₹) — blank = full remaining</label><input name="amount" inputmode="decimal" placeholder="${(o.total - o.refundedAmount) / 100}"></div>
            <div class="field"><label>Reason</label><input name="reason"></div><button class="btn btn-ghost btn-sm" type="submit">Issue refund via Razorpay</button></form>` : ''}
        </section>
        ${o.allowedTransitions.includes('cancelled') ? `<section class="card"><h2>Cancel order</h2>
          <form data-cancel novalidate><div class="field"><label>Reason (shared with the customer)</label><input name="reason"></div>
          ${o.paymentStatus === 'paid' ? '<label class="check" style="margin-bottom:12px"><input type="checkbox" name="refund" checked> Refund the full amount via Razorpay</label>' : ''}
          <button class="btn btn-ghost btn-sm" type="submit" style="--fg:#9C2F27">Cancel order</button></form></section>` : ''}
        <section class="card"><h2>Emails sent</h2>${o.notifications.length ? `<ul class="history">${o.notifications.map((n) => `<li><time>${fmtDateTime(n.created_at)} · ${esc(n.status)}</time>${esc(n.subject)}${n.error ? `<div class="muted" style="font-size:.76rem">${esc(n.error)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted">None yet.</p>'}</section>
      </div>
    </div>`;

  const act = async (btn, fn, msg) => {
    btn?.classList.add('is-loading');
    try { await fn(); toast({ title: msg, icon: 'star' }); orderDetail(number); } catch (e) { toastError(e); } finally { btn?.classList.remove('is-loading'); }
  };
  const base = `/admin/orders/${encodeURIComponent(number)}`;
  $$('[data-status]').forEach((b) => b.addEventListener('click', () => act(b, () => api(`${base}/status`, { method: 'POST', body: { status: b.dataset.status } }), `Moved to ${STATUS_LABELS[b.dataset.status]}`)));
  $('[data-ship]')?.addEventListener('click', (e) => act(e.currentTarget, () => api(`${base}/ship`, { method: 'POST', body: {} }), 'Shipment booked'));
  $('[data-sync]')?.addEventListener('click', (e) => act(e.currentTarget, () => api(`${base}/sync-tracking`, { method: 'POST', body: {} }), 'Tracking refreshed'));
  $('[data-label]')?.addEventListener('click', (e) => act(e.currentTarget, () => api(`${base}/label`, { method: 'POST', body: {} }), 'Label generated'));
  $('[data-manual-open]')?.addEventListener('click', () => { $('[data-manual]').hidden = false; });
  $('[data-manual]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    act($('button', f), async () => { try { await api(`${base}/manual-shipment`, { method: 'POST', body: Object.fromEntries(new FormData(f)) }); } catch (err) { showFieldErrors(f, err.details); throw err; } }, 'Marked as shipped');
  });
  $('[data-couriers]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-loading');
    try {
      const r = await api(`${base}/couriers`);
      const box = $('[data-courier-box]');
      if (!r.serviceable) { box.innerHTML = '<p class="notice error" style="margin-top:10px">No courier services this PIN code.</p>'; return; }
      const pc = r.parcel;
      box.innerHTML = `<form class="subform" data-book>${pc ? `<p class="muted" style="font-size:.82rem;margin:0 0 6px">Parcel ${pc.lengthCm}×${pc.breadthCm}×${pc.heightCm} cm · ${pc.weightGrams} g (billed as ${pc.chargeableGrams} g) · from PIN ${esc(r.pickupPincode || '')}</p>` : ''}<div class="field"><label>Courier</label><select name="courierId">
        <option value="">Shiprocket recommended (${esc(r.recommended?.name || '')})</option>
        ${r.couriers.map((c) => `<option value="${c.id}">${esc(c.name)} — ${money(c.rate)} · ${esc(c.etd || '')}</option>`).join('')}</select></div>
        <button class="btn btn-sm" type="submit">Create shipment, assign AWB &amp; schedule pickup</button></form>`;
      $('[data-book]').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const courierId = new FormData(ev.currentTarget).get('courierId') || undefined;
        act($('button', ev.currentTarget), () => api(`${base}/ship`, { method: 'POST', body: { courierId } }), 'Shipment booked with Shiprocket');
      });
    } catch (err) { toastError(err); } finally { btn.classList.remove('is-loading'); }
  });
  $('[data-refund]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (!confirm(`Refund ${f.amount ? `₹${f.amount}` : 'the full remaining amount'} to the customer?`)) return;
    act($('button', e.currentTarget), () => api(`${base}/refund`, { method: 'POST', body: f }), 'Refund issued');
  });
  $('[data-cancel]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!confirm('Cancel this order? Stock will be returned to inventory.')) return;
    act($('button', e.currentTarget), () => api(`${base}/cancel`, { method: 'POST', body: { reason: f.get('reason'), refund: f.get('refund') === 'on' } }), 'Order cancelled');
  });
}

/* ═════════════ products ═════════════ */
async function products() {
  const list = await api('/admin/products');
  view.innerHTML = `<div class="adm-head"><div><h1>Products</h1><div class="sub">${list.length} products · edit stock inline, or open a product for photos &amp; details.</div></div>
    <a class="btn" href="#products/new">+ Add product</a></div>
    <div class="filters"><input class="input" type="search" placeholder="Filter products…" data-pf></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>Product</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((p) => `<tr data-name="${esc(p.name.toLowerCase())}">
      <td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : ''}</td>
      <td><a href="#products/${p.id}"><b>${esc(p.name)}</b></a><div class="muted" style="font-size:.78rem">${esc(p.sku || '')}${p.variants.length ? ` · ${p.variants.length} styles` : ''}</div></td>
      <td>${esc(p.category?.name || '—')}</td><td class="num">${money(p.price)}</td>
      <td class="num">${p.variants.length ? `${p.stock} <span class="muted" style="font-size:.76rem">(per style)</span>` : `<input class="mini" type="number" min="0" value="${p.ownStock}" data-stock="${p.id}" aria-label="Stock for ${esc(p.name)}">`}</td>
      <td>${!p.isActive ? chip('Hidden', 'grey') : p.soldOut ? chip('Sold out', 'red') : p.stock <= 3 ? chip(p.stock ? 'Low' : 'Out of stock', 'amber') : chip('Live', 'green')} ${p.isFeatured ? chip('Featured') : ''}</td>
      <td><button class="link-btn" type="button" data-soldout="${p.id}" data-val="${p.soldOut ? 0 : 1}">${p.soldOut ? 'Back in stock' : 'Mark sold out'}</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('[data-pf]').addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('tr[data-name]').forEach((tr) => { tr.hidden = !tr.dataset.name.includes(q); }); });
  $$('[data-stock]').forEach((inp) => inp.addEventListener('change', async () => {
    try { await api(`/admin/products/${inp.dataset.stock}/stock`, { method: 'PATCH', body: { stock: Number(inp.value) } }); toast({ title: 'Stock updated', icon: 'star', ms: 1800 }); } catch (e) { toastError(e); }
  }));
  $$('[data-soldout]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/admin/products/${b.dataset.soldout}/stock`, { method: 'PATCH', body: { soldOut: b.dataset.val === '1' } }); products(); } catch (e) { toastError(e); }
  }));
}

async function productEditor(id) {
  const isNew = id === 'new';
  const [cats, p] = await Promise.all([api('/admin/categories'), isNew ? null : api(`/admin/products/${id}`)]);
  const v = p || { name: '', slug: '', price: 0, stock: 0, variants: [], images: [], angleImages: [], isActive: true, weightGrams: 30, materials: 'Polymer clay, UV-resin glaze, gold-tone alloy keyring & chain' };
  const rupees = (paise) => (paise == null ? '' : (paise / 100).toString());
  view.innerHTML = `<div class="adm-head"><div><a href="#products" class="muted">← Products</a><h1>${isNew ? 'New product' : esc(v.name)}</h1></div>
    <div class="actions-row">${!isNew ? `<a class="btn btn-ghost btn-sm" href="/p/${esc(v.slug)}" target="_blank" rel="noopener">View in shop ↗</a><button class="btn btn-ghost btn-sm" type="button" data-delete>Delete</button>` : ''}</div></div>
    <div class="pe-grid">
      <form class="card" data-pform novalidate>
        <div class="grid-2"><div class="field"><label>Name</label><input name="name" value="${esc(v.name)}" required></div>
          <div class="field"><label>URL name (slug)</label><input name="slug" value="${esc(v.slug)}" placeholder="auto from name"></div></div>
        <div class="grid-3"><div class="field"><label>Price (₹)</label><input name="price" inputmode="decimal" value="${rupees(v.price)}"></div>
          <div class="field"><label>Compare-at price (₹)</label><input name="comparePrice" inputmode="decimal" value="${rupees(v.comparePrice)}" placeholder="optional"></div>
          <div class="field"><label>Category</label><select name="categoryId"><option value="">—</option>${cats.map((c) => `<option value="${c.id}" ${v.category?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
        <div class="field"><label>Short description (shown on cards)</label><input name="shortDesc" maxlength="200" value="${esc(v.shortDesc || '')}"></div>
        <div class="field"><label>Full description</label><textarea name="description" rows="5">${esc(v.description || '')}</textarea></div>
        <div class="grid-2"><div class="field"><label>Materials</label><input name="materials" value="${esc(v.materials || '')}"></div>
          <div class="field"><label>Dimensions</label><input name="dimensions" value="${esc(v.dimensions || '')}" placeholder="Charm 3.8 × 3.2 cm · total length 9 cm"></div></div>
        <div class="grid-3"><div class="field"><label>Stock ${v.variants.length ? '(unused — styles have stock)' : ''}</label><input name="stock" type="number" min="0" value="${v.ownStock ?? v.stock ?? 0}"></div>
          <div class="field"><label>SKU</label><input name="sku" value="${esc(v.sku || '')}"></div>
          <div class="field"><label>Weight (g, for shipping)</label><input name="weightGrams" type="number" min="1" value="${v.weightGrams || 30}"></div></div>
        <div class="actions-row" style="margin-bottom:14px">
          <label class="check"><input type="checkbox" name="isActive" ${v.isActive ? 'checked' : ''}> Visible in shop</label>
          <label class="check"><input type="checkbox" name="isFeatured" ${v.isFeatured ? 'checked' : ''}> Featured on homepage</label>
          <label class="check"><input type="checkbox" name="soldOut" ${v.soldOut ? 'checked' : ''}> Sold out</label></div>
        <h2>Styles / variations <small>optional — e.g. colours. When present, stock is tracked per style.</small></h2>
        <div class="var-row var-head"><span>Name</span><span>Colour</span><span>Price ₹</span><span>Stock</span><span>SKU</span><span></span></div>
        <div data-vars></div>
        <button class="btn btn-ghost btn-sm" type="button" data-addvar>+ Add style</button>
        <hr class="hr-dots"><button class="btn" type="submit">${isNew ? 'Create product' : 'Save changes'}</button>
      </form>
      <div style="display:grid;gap:16px">
        <section class="card"><h2>Photos <small>first photo is the cover · JPG, PNG, WebP</small></h2>
          ${isNew ? '<p class="muted">Save the product first, then add photos.</p>' : `<div class="img-grid" data-gallery></div>
          <label class="drop" data-drop="gallery">Drop photos here or click to upload<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden></label>`}
        </section>
        <section class="card"><h2>360° spin frames <small>${v.angleImages.length} uploaded</small></h2>
          <p class="muted" style="font-size:.86rem">Photograph the charm on a turntable every 10–30° (12–36 shots, same framing). Upload them all at once — they're ordered by file name. With 8+ frames, a "360° view" appears on the product page.</p>
          ${isNew ? '' : `<div class="img-grid" data-angles></div>
          <label class="drop" data-drop="angle">Upload angle frames<input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden></label>`}
        </section>
      </div>
    </div>`;

  // variants
  const varHost = $('[data-vars]');
  const addVarRow = (x = {}) => {
    const row = document.createElement('div');
    row.className = 'var-row';
    row.dataset.id = x.id || '';
    row.innerHTML = `<input name="v_name" placeholder="Rose" value="${esc(x.name || '')}" aria-label="Style name">
      <input name="v_color" type="color" value="${esc(x.colorHex || '#E6C0C9')}" aria-label="Colour">
      <input name="v_price" inputmode="decimal" placeholder="same" value="${x.price != null && p && x.price !== p.price ? x.price / 100 : ''}" aria-label="Price">
      <input name="v_stock" type="number" min="0" value="${x.stock ?? 0}" aria-label="Stock">
      <input name="v_sku" value="${esc(x.sku || '')}" aria-label="SKU">
      <button class="link-btn" type="button" aria-label="Remove style">✕</button>`;
    $('button', row).onclick = () => row.remove();
    varHost.append(row);
  };
  v.variants.filter((x) => x.isActive !== false).forEach(addVarRow);
  $('[data-addvar]').onclick = () => addVarRow();

  const form = $('[data-pform]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = Object.fromEntries(f);
    ['isActive', 'isFeatured', 'soldOut'].forEach((k) => { body[k] = f.get(k) === 'on'; });
    body.variants = $$('.var-row:not(.var-head)', varHost).map((r) => ({
      id: r.dataset.id ? Number(r.dataset.id) : undefined, name: $('[name=v_name]', r).value, colorHex: $('[name=v_color]', r).value,
      price: $('[name=v_price]', r).value, stock: $('[name=v_stock]', r).value, sku: $('[name=v_sku]', r).value,
    })).filter((x) => x.name.trim());
    const btn = $('button[type=submit]', form);
    btn.classList.add('is-loading');
    try {
      const saved = await api(isNew ? '/admin/products' : `/admin/products/${id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast({ title: isNew ? 'Product created — now add photos!' : 'Saved', icon: 'star' });
      if (isNew) location.hash = `#products/${saved.id}`; else productEditor(id);
    } catch (err) { showFieldErrors(form, err.details); toastError(err); } finally { btn.classList.remove('is-loading'); }
  });

  if (isNew) return;
  $('[data-delete]').onclick = async () => {
    if (!confirm('Delete this product? If it has been ordered before it will be hidden instead, so past orders stay intact.')) return;
    const r = await api(`/admin/products/${id}`, { method: 'DELETE' });
    toast({ title: r.archived ? 'Product hidden (it has past orders)' : 'Product deleted', icon: 'heart' });
    location.hash = '#products';
  };
  renderImages(p);
}

function renderImages(p) {
  const tile = (im, i, kind, total) => `<div class="img-tile">${i === 0 && kind === 'gallery' ? '<span class="badge">cover</span>' : ''}<img src="${esc(im.url)}" alt="">
    <div class="tools">${kind === 'gallery' ? `<button type="button" data-move="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">‹</button><button type="button" data-move="${i}" data-d="1" ${i === total - 1 ? 'disabled' : ''} aria-label="Move later">›</button>` : `<span style="color:#fff;font-size:.7rem;padding:4px">#${i + 1}</span>`}
    <button type="button" data-delimg="${im.id}" aria-label="Delete image">✕</button></div></div>`;
  $('[data-gallery]').innerHTML = p.images.map((im, i) => tile(im, i, 'gallery', p.images.length)).join('') || '<p class="muted">No photos yet.</p>';
  $('[data-angles]').innerHTML = p.angleImages.map((im, i) => tile(im, i, 'angle', p.angleImages.length)).join('');
  $$('[data-delimg]').forEach((b) => { b.onclick = async () => { if (!confirm('Delete this image?')) return; renderImages(await api(`/admin/products/${p.id}/images/${b.dataset.delimg}`, { method: 'DELETE' })); }; });
  $$('[data-move]').forEach((b) => {
    b.onclick = async () => {
      const ids = p.images.map((x) => x.id);
      const i = Number(b.dataset.move);
      const j = i + Number(b.dataset.d);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      renderImages(await api(`/admin/products/${p.id}/images/order`, { method: 'PUT', body: { ids } }));
    };
  });
  $$('[data-drop]').forEach((drop) => {
    const input = $('input', drop);
    const upload = async (files) => {
      const list = [...files].filter((f) => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (!list.length) return;
      drop.textContent = `Uploading ${list.length} image${list.length === 1 ? '' : 's'}…`;
      try {
        let latest = p;
        for (const f of list) if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name} is over 10 MB`);
        // Preferred: straight to Supabase Storage with one-time signed URLs (no size cap from the host), then the
        // server verifies each file before attaching it. Falls back to sending the image through the server.
        const signed = await api('/admin/uploads/sign', { method: 'POST', body: { target: drop.dataset.drop, id: p.id, files: list.map((f) => ({ name: f.name, type: f.type, size: f.size })) } });
        if (signed.direct) {
          for (let i = 0; i < list.length; i += 6) {
            const part = list.slice(i, i + 6);
            await Promise.all(part.map(async (f, j) => {
              const fd = new FormData();
              fd.append('cacheControl', '31536000');
              fd.append('', f);
              const res = await fetch(signed.uploads[i + j].uploadUrl, { method: 'PUT', body: fd, headers: { 'x-upsert': 'false' } });
              if (!res.ok) throw new Error(`${f.name} could not be uploaded (storage said ${res.status})`);
            }));
            drop.textContent = `Uploading… ${Math.min(i + 6, list.length)} of ${list.length}`;
          }
          latest = await api(`/admin/products/${p.id}/images`, { method: 'POST', body: { kind: drop.dataset.drop, uploads: signed.uploads.map((u) => ({ ticket: u.ticket, alt: p.name })) } });
          list.length = 0; // done — skip the fallback below
        }
        for (let i = 0; i < list.length; i += 6) { // small batches keep requests light
          const batch = await Promise.all(list.slice(i, i + 6).map((f) => new Promise((res, rej) => {
            if (f.size > 10 * 1024 * 1024) return rej(new Error(`${f.name} is over 10 MB`));
            const r = new FileReader();
            r.onload = () => res({ name: f.name, dataUrl: r.result, alt: p.name });
            r.onerror = rej;
            r.readAsDataURL(f);
          })));
          latest = await api(`/admin/products/${p.id}/images`, { method: 'POST', body: { kind: drop.dataset.drop, files: batch } });
        }
        toast({ title: 'Photos uploaded', icon: 'star' });
        renderImages(latest);
        Object.assign(p, latest);
      } catch (e) { toastError(e); renderImages(p); }
    };
    input.onchange = () => upload(input.files);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files); };
  });
}

/* ═════════════ categories ═════════════ */
async function categories() {
  const cats = await api('/admin/categories');
  const iconSelect = (sel) => `<select name="icon">${CHARM_NAMES.map((n) => `<option ${n === sel ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  view.innerHTML = `<div class="adm-head"><div><h1>Categories</h1><div class="sub">These become the sections of “Our Little Menu”.</div></div></div>
    <div style="display:grid;gap:12px">${cats.map((c) => `<form class="card" data-cat="${c.id}" novalidate>
      <div style="display:grid;grid-template-columns:56px 1fr;gap:14px;align-items:start">
        <div class="menu-icon" style="width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:var(--blush)">${charmSVG(c.icon, { size: 40 })}</div>
        <div><div class="grid-3"><div class="field"><label>Name</label><input name="name" value="${esc(c.name)}"></div><div class="field"><label>Slug</label><input name="slug" value="${esc(c.slug)}"></div>
          <div class="grid-2"><div class="field"><label>Icon</label>${iconSelect(c.icon)}</div><div class="field"><label>Order</label><input name="sortOrder" type="number" value="${c.sortOrder}"></div></div></div>
          <div class="field"><label>Menu description</label><input name="description" value="${esc(c.description || '')}"></div>
          <div class="actions-row"><button class="btn btn-sm" type="submit">Save</button><button class="link-btn" type="button" data-delcat="${c.id}">Delete</button><span class="muted" style="font-size:.84rem">${c.productCount} live products</span></div></div></div></form>`).join('')}
    <form class="card" data-cat="new" novalidate><h2>New category</h2>
      <div class="grid-3"><div class="field"><label>Name</label><input name="name"></div><div class="field"><label>Icon</label>${iconSelect('heart')}</div><div class="field"><label>Order</label><input name="sortOrder" type="number" value="${cats.length}"></div></div>
      <div class="field"><label>Menu description</label><input name="description"></div><button class="btn btn-sm" type="submit">Add category</button></form></div>`;
  $$('[data-cat]').forEach((f) => f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    try {
      await api(f.dataset.cat === 'new' ? '/admin/categories' : `/admin/categories/${f.dataset.cat}`, { method: f.dataset.cat === 'new' ? 'POST' : 'PUT', body });
      toast({ title: 'Category saved', icon: 'star' });
      categories();
    } catch (err) { showFieldErrors(f, err.details); toastError(err); }
  }));
  $$('[data-delcat]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this category? Its products stay, but become uncategorised.')) return;
    await api(`/admin/categories/${b.dataset.delcat}`, { method: 'DELETE' });
    categories();
  }));
}

/* ═════════════ notifications ═════════════ */
async function notifications() {
  const rows = await api('/admin/notifications');
  view.innerHTML = `<div class="adm-head"><div><h1>Emails</h1><div class="sub">Every customer &amp; owner email, with delivery status.</div></div></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Order</th><th>To</th><th>Subject</th><th>Status</th></tr></thead><tbody>
    ${rows.map((n) => `<tr><td>${fmtDateTime(n.created_at)}</td><td>${n.order_number ? `<a href="#orders/${esc(n.order_number)}">${esc(n.order_number)}</a>` : ''}</td><td>${esc(n.recipient)}</td><td>${esc(n.subject)}${n.order_id ? ` <a class="muted" style="font-size:.76rem" href="/api/admin/notifications/${encodeURIComponent(n.id)}/preview" target="_blank" rel="noopener">Preview</a>` : ''}</td>
      <td>${chip(n.status, n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : 'amber')}${n.error ? `<div class="muted" style="font-size:.74rem;max-width:280px">${esc(n.error)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No emails yet.</td></tr>'}
    </tbody></table></div>`;
}

/* ═════════════ setup ═════════════ */
async function setup() {
  const s = await api('/admin/integrations');
  const ok = (b, yes = 'Connected', no = 'Not configured') => chip(b ? yes : no, b ? 'green' : 'amber');
  view.innerHTML = `<div class="adm-head"><div><h1>Setup &amp; integrations</h1><div class="sub">Credentials live in the server's <code>.env</code> file — never in the browser.</div></div></div>
    <div class="setup-list">
      <section class="card"><h2>Payments — Razorpay ${s.payments.mode === 'razorpay' ? (s.payments.env === 'live' ? chip('Live mode — real money', 'green') : chip('Test mode', 'amber'))
          : s.payments.mode === 'mock' ? chip('Local simulator', 'amber') : chip('Disabled', 'red')}</h2>
        ${s.payments.problem ? `<p class="notice error" style="margin-bottom:10px">${esc(s.payments.problem)}</p>` : ''}
        <ol><li>Set <code>PAYMENT_PROVIDER=razorpay</code> and <code>RAZORPAY_MODE=test</code> (switch to <code>live</code> only after test payments work).</li>
        <li>Razorpay Dashboard → Account &amp; Settings → API Keys → generate keys for the same mode. Put them in <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code>.</li>
        <li>Dashboard → Webhooks → Add: URL <code>${esc(s.payments.webhookUrl)}</code>, events <code>payment.captured, payment.failed, order.paid</code> (optionally <code>payment.authorized, refund.processed, refund.failed</code>), and a secret → <code>RAZORPAY_WEBHOOK_SECRET</code>. ${ok(s.payments.webhookSecret, 'Secret set', 'Secret missing')}</li>
        <li>Restart the server.</li></ol></section>
      <section class="card"><h2>Shipping — Shiprocket ${ok(s.shipping.shiprocket)}</h2>
        <ol><li>Shiprocket → Settings → API → create an API user. Put its email &amp; password in <code>SHIPROCKET_EMAIL</code> / <code>SHIPROCKET_PASSWORD</code>.</li>
        <li>Settings → Pickup Addresses: copy the exact nickname into <code>SHIPROCKET_PICKUP_LOCATION</code> (now: <code>${esc(s.shipping.pickupLocation)}</code>) — its PIN code is read from Shiprocket (<code>PICKUP_PINCODE</code> is only a fallback${s.shipping.pickupPincode ? `, now <code>${esc(s.shipping.pickupPincode)}</code>` : ''}).</li>
        <li>Settings → API → Webhooks: URL <code>${esc(s.shipping.webhookUrl)}</code>, token = <code>SHIPROCKET_WEBHOOK_TOKEN</code>. ${ok(s.shipping.webhookToken, 'Token set', 'Token missing')} Tracking is also polled hourly as a backup.</li>
        <li>Delivery fee mode: <code>${esc(s.shipping.feeMode)}</code> (<code>SHIPPING_FEE_MODE</code> = flat | courier).</li>
        <li>Parcel used for rates &amp; bookings: ${s.shipping.parcel.lengthCm}×${s.shipping.parcel.breadthCm}×${s.shipping.parcel.heightCm} cm box + ${s.shipping.parcel.packagingGrams} g packing + each charm's weight (<code>SHIP_BOX_*_CM</code>, <code>SHIP_PACKAGING_GRAMS</code>).</li>
        <li>Booking real shipments: ${s.shipping.bookingAllowed ? chip('Allowed', 'green') : chip('Off on this server', 'amber')} (<code>SHIPROCKET_ALLOW_BOOKING</code>; on by default only in production).</li></ol>
        ${s.shipping.shiprocket ? '<div class="actions-row" style="margin-top:10px"><button class="btn btn-ghost btn-sm" type="button" data-sr-check>Check Shiprocket connection</button></div><div data-sr-result></div>' : ''}
        ${s.shipping.shiprocket ? '' : '<p class="notice" style="margin-top:10px">Until then, use “Record manual shipment” on an order to enter a courier and tracking number you booked yourself.</p>'}</section>
      <section class="card"><h2>Email — Resend ${ok(s.email.provider)}</h2>
        <ol><li>Create an account at resend.com, verify your domain, create an API key → <code>RESEND_API_KEY</code>.</li>
        <li>Set <code>EMAIL_FROM</code> (now: <code>${esc(s.email.from)}</code>) and <code>SHOP_OWNER_EMAIL</code> for new-order alerts. ${ok(s.email.ownerAlerts, 'Owner alerts on', 'Owner email missing')}</li></ol>
        ${s.email.provider ? '' : '<p class="notice" style="margin-top:10px">Until then, no emails are sent: each one is listed under Emails as “logged”, with a Preview link.</p>'}</section>
    </div>`;
  $('[data-sr-check]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-loading');
    try {
      const r = await api('/admin/shipping/check', { method: 'POST', body: {} });
      $('[data-sr-result]').innerHTML = r.ok
        ? `<p class="notice" style="margin-top:10px">✓ Logged in. Pickup “${esc(r.pickup.name)}” · PIN ${esc(r.pickup.pincode)}${r.pickup.city ? ` · ${esc(r.pickup.city)}` : ''}.${r.warning ? `<br>⚠ ${esc(r.warning)}` : ''}</p>`
        : `<p class="notice error" style="margin-top:10px">${esc(r.problem || 'Check failed')}${r.available?.length ? `<br>Pickup locations in Shiprocket: ${r.available.map((n) => `<code>${esc(n)}</code>`).join(', ')}` : ''}</p>`;
    } catch (err) { toastError(err); } finally { btn.classList.remove('is-loading'); }
  });
}

/* ═════════════ today's special (the floral curtain board on the homepage) ═════════════ */
async function todaysSpecial() {
  const [cfg, list] = await Promise.all([api('/admin/todays-special'), api('/admin/products')]);
  const byId = new Map(list.map((p) => [p.id, p]));
  const st = { isActive: cfg.isActive, showAgain: cfg.showAgain, ids: cfg.slots.map((s) => s.productId), updatedAt: cfg.updatedAt, target: null, errors: {} };
  const snapshot = () => JSON.stringify([st.isActive, st.showAgain, st.ids]);
  let saved = snapshot();

  // Same shape the public board uses (original photo URL, live price incl. styles).
  const card = (p) => {
    const prices = [p.price, ...p.variants.filter((v) => v.isActive).map((v) => v.price)];
    return { id: p.id, slug: p.slug, name: p.name, shortDesc: p.shortDesc, price: Math.min(...prices), fromPrice: new Set(prices).size > 1,
      comparePrice: p.comparePrice, image: p.image, imageAlt: p.images[0]?.alt || p.name, availability: p.availability };
  };
  const problem = (id) => {
    if (!id) return 'empty';
    const p = byId.get(id);
    if (!p) return 'deleted';
    if (!p.isActive) return 'hidden';
    return p.availability.status === 'sold_out' ? 'sold_out' : null;
  };
  const PROBLEM = {
    empty: ['Empty — choose a treasure', 'amber'], deleted: ['Product was deleted — please replace', 'red'],
    hidden: ['Hidden from the shop — visitors won\'t see it', 'red'], sold_out: ['Sold out — shown with a “sold out” tag', 'amber'],
  };
  const liveCards = () => st.ids.filter((id) => id && byId.get(id)?.isActive).map((id) => card(byId.get(id)));

  view.innerHTML = `<div data-ts-root><div class="adm-head"><div><h1>Today's Special</h1>
      <div class="sub">The floral curtain board visitors see first on the homepage — three treasures you choose.</div></div>
      <div class="actions-row"><button class="btn btn-ghost btn-sm" type="button" data-ts-preview>Preview the curtain</button>
        <button class="btn btn-sm" type="button" data-ts-save>Save</button></div></div>
    <div class="ts-grid">
      <div class="ts-col">
        <section class="card"><h2>Publishing <span data-ts-status></span></h2>
          <label class="ts-switch"><input type="checkbox" data-ts-active ${st.isActive ? 'checked' : ''}><span class="ts-track" aria-hidden="true"></span>
            <span><b>Show Today's Special on the homepage</b><br><span class="muted">When off, visitors go straight to the shop.</span></span></label>
          <div class="field" style="margin:14px 0 0"><label for="ts-again">Show the closed curtains again</label>
            <select class="input" id="ts-again" data-ts-again>
              ${[['session', 'On every new visit (each new browsing session)'], ['day', 'At most once a day'], ['week', 'At most once a week']]
                .map(([v, l]) => `<option value="${v}" ${st.showAgain === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <span class="hint">Once a visitor opens the curtains, they stay open for the rest of that visit.</span></div>
          <p class="muted ts-updated" data-ts-updated></p></section>
        <section class="card"><h2>The three treasures <small>use ↑ ↓ to reorder</small></h2><ol class="ts-slots" data-ts-slots></ol></section>
        <section class="card" data-ts-picker-card><h2>Choose treasures <small data-ts-target></small></h2>
          <div class="filters"><input class="input" type="search" placeholder="Search your products…" aria-label="Search products" data-ts-q></div>
          <ul class="ts-picker" data-ts-picker></ul></section>
      </div>
      <section class="card ts-preview"><h2>Preview <small>exactly what visitors will see</small></h2><div class="vbc-preview-stage" data-ts-board></div></section>
    </div></div>`;
  const root = $('[data-ts-root]'); // listeners live on this section's own element, so they vanish when you navigate away

  const render = () => {
    const dirty = snapshot() !== saved;
    $('[data-ts-status]').innerHTML = `${st.isActive ? chip('On', 'green') : chip('Off', 'grey')} ${dirty ? chip('Unsaved changes', 'amber') : ''}`;
    $('[data-ts-save]').textContent = st.isActive ? 'Save & publish' : 'Save';
    $('[data-ts-updated]').textContent = st.updatedAt ? `Last saved ${fmtDateTime(st.updatedAt)}` : 'Not saved yet';
    $('[data-ts-target]').textContent = st.target != null ? `choosing for place ${st.target + 1}` : 'fills the first empty place';
    $('[data-ts-slots]').innerHTML = st.ids.map((id, i) => {
      const p = id ? byId.get(id) : null;
      const pr = problem(id);
      return `<li class="ts-slot ${st.target === i ? 'is-target' : ''} ${pr && pr !== 'sold_out' ? 'has-problem' : ''}">
        <span class="ts-n">${i + 1}</span>
        ${p?.image ? `<img src="${esc(p.image)}" alt="">` : '<span class="ts-ph">✿</span>'}
        <div class="ts-info">${p ? `<b>${esc(p.name)}</b><div class="muted">${money(card(p).price)}${p.category ? ` · ${esc(p.category.name)}` : ''}</div>` : '<b class="muted">No treasure chosen</b>'}
          ${pr ? `<div>${chip(PROBLEM[pr][0], PROBLEM[pr][1])}</div>` : ''}
          ${st.errors[`slot${i + 1}`] ? `<div class="ts-err">${esc(st.errors[`slot${i + 1}`])}</div>` : ''}</div>
        <div class="ts-tools">
          <button class="link-btn" type="button" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move place ${i + 1} up">↑</button>
          <button class="link-btn" type="button" data-down="${i}" ${i === 2 ? 'disabled' : ''} aria-label="Move place ${i + 1} down">↓</button>
          <button class="link-btn" type="button" data-replace="${i}">${p ? 'Replace' : 'Choose'}</button>
          ${id ? `<button class="link-btn" type="button" data-remove="${i}">Remove</button>` : ''}</div></li>`;
    }).join('');
    const q = ($('[data-ts-q]').value || '').trim().toLowerCase();
    $('[data-ts-picker]').innerHTML = list.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category?.name || '').toLowerCase().includes(q)).map((p) => {
      const chosen = st.ids.indexOf(p.id);
      const why = !p.isActive ? 'Hidden' : chosen >= 0 ? `In place ${chosen + 1}` : '';
      return `<li class="ts-pick">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="ts-ph">✿</span>'}
        <div class="ts-info"><b>${esc(p.name)}</b><div class="muted">${money(card(p).price)} · ${esc(p.availability.label)}</div></div>
        ${why ? chip(why, chosen >= 0 ? 'green' : 'grey') : `<button class="btn btn-ghost btn-sm" type="button" data-pick="${p.id}">Choose</button>`}</li>`;
    }).join('') || '<li class="muted">No products match.</li>';
    const cards = liveCards();
    $('[data-ts-board]').innerHTML = cards.length ? boardHTML(cards, { titleId: 'ts-preview-title' })
      : '<p class="muted" style="background:#fffcf6;padding:16px;border-radius:8px">Choose treasures to see the board.</p>';
  };

  const pick = (id) => {
    let i = st.target ?? st.ids.findIndex((x) => !x || problem(x) === 'deleted' || problem(x) === 'hidden');
    if (i < 0) { toast({ title: 'All three places are filled', text: 'Click “Replace” on the treasure you want to change.', icon: 'bow' }); return; }
    st.ids[i] = id;
    st.target = null;
    delete st.errors[`slot${i + 1}`];
    render();
  };

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button, a');
    if (!t || !root.contains(t)) return;
    if (t.closest('[data-ts-board]')) { e.preventDefault(); return; } // the preview isn't clickable
    const d = t.dataset;
    if (d.up != null) { const i = +d.up; [st.ids[i - 1], st.ids[i]] = [st.ids[i], st.ids[i - 1]]; st.errors = {}; render(); }
    else if (d.down != null) { const i = +d.down; [st.ids[i + 1], st.ids[i]] = [st.ids[i], st.ids[i + 1]]; st.errors = {}; render(); }
    else if (d.remove != null) { st.ids[+d.remove] = null; render(); }
    else if (d.replace != null) {
      st.target = st.target === +d.replace ? null : +d.replace;
      render();
      if (st.target != null) { $('[data-ts-picker-card]').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('[data-ts-q]').focus({ preventScroll: true }); }
    } else if (d.pick) pick(Number(d.pick));
    else if (t.matches('[data-ts-preview]')) {
      const cards = liveCards();
      if (!cards.length) { toast({ title: 'Choose at least one live treasure first', icon: 'bow' }); return; }
      previewCurtain(cards);
    } else if (t.matches('[data-ts-save]')) {
      t.classList.add('is-loading');
      try {
        const r = await api('/admin/todays-special', { method: 'PUT', body: { isActive: st.isActive, showAgain: st.showAgain, productIds: st.ids, updatedAt: st.updatedAt } });
        Object.assign(st, { isActive: r.isActive, showAgain: r.showAgain, ids: r.slots.map((s) => s.productId), updatedAt: r.updatedAt, errors: {}, target: null });
        saved = snapshot();
        toast({ title: r.isActive ? 'Today\'s Special is live ✿' : 'Saved', text: r.isActive ? 'Visitors will see the new board on their next visit.' : 'The curtain is switched off.', icon: 'heart' });
      } catch (err) {
        st.errors = err.details || {};
        toastError(err);
      } finally { t.classList.remove('is-loading'); render(); }
    }
  });
  $('[data-ts-active]').addEventListener('change', (e) => { st.isActive = e.target.checked; render(); });
  $('[data-ts-again]').addEventListener('change', (e) => { st.showAgain = e.target.value; render(); });
  $('[data-ts-q]').addEventListener('input', render);
  render();
}

boot().catch(toastError);
