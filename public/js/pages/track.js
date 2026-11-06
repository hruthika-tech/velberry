import '../layout.js';
import { api, money, esc, fmtDate, fmtDateTime, qs, $ } from '../api.js';
import { charmSVG } from '../charms.js';
import { loaderHTML, toastError } from '../ui.js';

const form = $('[data-lookup]');
const out = $('[data-result]');
const ICONS = ['heart', 'strawberry', 'cupcake', 'bow', 'teacup', 'butterfly', 'star', 'key'];
const PAY = { paid: ['Paid', 'green'], pending: ['Awaiting payment', 'amber'], failed: ['Failed', 'red'], refunded: ['Refunded', 'grey'], partially_refunded: ['Partly refunded', 'grey'], expired: ['Expired', 'grey'] };

async function lookup(body, { silent = false } = {}) {
  out.innerHTML = loaderHTML('Following the little footprints…');
  try {
    const o = await api('/orders/lookup', { method: 'POST', body });
    render(o);
    history.replaceState(null, '', `/track.html?order=${encodeURIComponent(o.orderNumber)}${body.token ? `&t=${encodeURIComponent(body.token)}` : ''}`);
  } catch (e) {
    if (silent) { out.innerHTML = ''; return; }
    out.innerHTML = `<p class="notice error" style="max-width:520px;margin:0 auto">${esc(e.message)}. Please check the order number and the email or phone you used.</p>`;
  }
}

function render(o) {
  form.hidden = true;
  const doneCount = o.timeline.filter((t) => t.done).length;
  const pay = PAY[o.paymentStatus] || [o.paymentStatus, 'grey'];
  const banner = o.isCancelled
    ? `<p class="notice error">This order was cancelled.${o.refundedAmount ? ` ${money(o.refundedAmount)} has been refunded to your original payment method.` : ''}</p>`
    : o.status === 'delivery_failed' ? '<p class="notice error">The courier couldn\'t complete delivery. They\'ll usually try again — please keep your phone reachable.</p>'
    : o.status === 'rto_initiated' ? '<p class="notice error">After several attempts the parcel is returning to us. We\'ll contact you to arrange re-delivery or a refund.</p>'
    : o.status === 'rto_delivered' ? '<p class="notice">The parcel came back to our studio. We\'ll be in touch shortly.</p>'
    : o.status === 'pending_payment' ? '<p class="notice">We haven\'t received payment for this order yet.</p>'
    : o.status === 'abandoned' ? '<p class="notice">This checkout expired before payment, so nothing was charged.</p>' : '';

  out.innerHTML = `
    <div class="panel stitched">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline;margin-bottom:6px">
        <h2 style="margin:0">Order ${esc(o.orderNumber)}</h2>
        <span class="chip ${o.isCancelled ? 'red' : 'green'}">${esc(o.statusLabel)}</span>
      </div>
      <p class="muted" style="margin-bottom:18px">Placed ${fmtDate(o.createdAt)}</p>
      ${banner}
      <ol class="timeline" aria-label="Order progress">
        <span class="fill" aria-hidden="true"></span>
        ${o.timeline.map((t, i) => `<li class="tl-step ${t.done ? 'done' : ''} ${t.current && !o.isCancelled ? 'current' : ''}" ${t.current ? 'aria-current="step"' : ''}>
          <span class="tl-dot">${charmSVG(ICONS[i], { size: 32 })}</span>
          <span><b>${esc(t.label)}</b><small>${t.done && t.at ? fmtDateTime(t.at) : ''}</small></span></li>`).join('')}
      </ol>
    </div>
    <div class="track-grid">
      <div class="panel">
        <h3>Delivery</h3>
        <dl class="kv">
          <dt>Courier</dt><dd>${o.shipment?.courier ? esc(o.shipment.courier) : '<span class="muted">Assigned when your parcel is packed</span>'}</dd>
          <dt>Tracking no.</dt><dd>${o.shipment?.awb ? `<b>${esc(o.shipment.awb)}</b>` : '<span class="muted">—</span>'}</dd>
          ${o.shipment?.etd ? `<dt>Expected by</dt><dd>${fmtDate(o.shipment.etd)}</dd>` : ''}
          ${o.shipment?.trackingUrl ? `<dt>Live tracking</dt><dd><a href="${esc(o.shipment.trackingUrl)}" target="_blank" rel="noopener">Open courier tracking ↗</a></dd>` : ''}
          <dt>Address</dt><dd>${esc(o.address.name)}<br>${esc(o.address.line1)}${o.address.line2 ? `, ${esc(o.address.line2)}` : ''}<br>${esc(o.address.city)}, ${esc(o.address.state)} – ${esc(o.address.pincode)}</dd>
          <dt>Payment</dt><dd><span class="chip ${pay[1]}">${esc(pay[0])}</span></dd>
        </dl>
        ${o.trackingEvents.length ? `<h3 style="margin-top:22px">Journey so far</h3><ul class="events">${o.trackingEvents.map((e) => `<li><time>${fmtDateTime(e.occurred_at)}${e.location ? ` · ${esc(e.location)}` : ''}</time>${esc(e.description || e.status)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="panel">
        <h3>In your parcel</h3>
        <ul class="mini-items" style="max-height:none">${o.items.map((i) => `<li><img src="${esc(i.image || '')}" alt=""><div>${esc(i.name)}${i.variantName ? ` <span class="muted">· ${esc(i.variantName)}</span>` : ''}<div class="q">Qty ${i.quantity} × ${money(i.unitPrice)}</div></div><span>${money(i.lineTotal)}</span></li>`).join('')}</ul>
        <div class="sum-row"><span>Subtotal</span><span>${money(o.subtotal)}</span></div>
        <div class="sum-row"><span>Delivery</span><span>${o.shippingFee ? money(o.shippingFee) : 'Free'}</span></div>
        <div class="sum-row total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>
    </div>
    <p style="text-align:center;margin-top:24px"><button class="link-btn" type="button" data-another>Track another order</button></p>`;

  // progress line
  const tl = $('.timeline', out);
  const fill = $('.fill', tl);
  const pct = o.isCancelled ? 0 : Math.max(0, (doneCount - 1) / (o.timeline.length - 1));
  requestAnimationFrame(() => {
    fill.style.width = `${pct * 88}%`;
    fill.style.setProperty('--fill-h', `calc(${pct} * (100% - 52px))`);
  });
  $('[data-another]', out).addEventListener('click', () => { form.hidden = false; out.innerHTML = ''; history.replaceState(null, '', '/track.html'); });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(form);
  if (!f.get('orderNumber') || !f.get('email')) return toastError(new Error('Please enter your order number and email or phone'));
  lookup({ orderNumber: f.get('orderNumber').trim(), email: f.get('email').trim() });
});

const ord = qs('order');
if (ord) {
  $('#t-order').value = ord;
  const token = qs('t') || sessionStorage.getItem(`vb_order_${ord}`);
  // Logged-in owners and token holders open directly; otherwise we ask for email/phone.
  lookup({ orderNumber: ord, token }, { silent: true });
}
