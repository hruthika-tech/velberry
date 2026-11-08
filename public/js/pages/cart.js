import '../layout.js';
import { money, esc, $, $$ } from '../api.js';
import { charmSVG } from '../charms.js';
import { cart, stepper, toastError, loaderHTML } from '../ui.js';

const host = $('[data-bag]');
host.innerHTML = loaderHTML('Peeking inside your bag…');

function render(data) {
  if (!data.items.length) {
    $('[data-hello]').hidden = true;
    host.innerHTML = `<div class="panel stitched empty-state" style="max-width:560px;margin:0 auto 90px">
      ${charmSVG('teacup', { size: 110 })}
      <h2>Your bag is feeling a little empty</h2>
      <p class="lede">Let's fill it with something sweet.</p>
      <a class="btn" href="/shop.html"><span class="heart">♥</span> Explore the Collection</a></div>`;
    return;
  }
  $('[data-hello]').hidden = false;
  const blocked = data.items.some((i) => i.problem);
  const remaining = data.freeShippingAbove ? Math.max(0, data.freeShippingAbove - data.subtotal) : 0;
  const pct = data.freeShippingAbove ? Math.min(100, (data.subtotal / data.freeShippingAbove) * 100) : 100;
  host.innerHTML = `<div class="bag-layout">
    <ul class="bag-list">
      ${data.items.map((i) => `<li class="bag-item" data-item="${i.id}">
        <a href="/p/${esc(i.slug)}"><img src="${esc(i.image || '')}" alt="${esc(i.name)}" width="104" height="104"></a>
        <div>
          <h3><a href="/p/${esc(i.slug)}">${esc(i.name)}</a></h3>
          ${i.variantName ? `<div class="variant">Style: ${esc(i.variantName)}</div>` : ''}
          <div class="unit">${money(i.unitPrice)} each</div>
          ${i.problem ? `<div class="problem">⚠ ${esc(i.problem)}</div>` : ''}
          <div class="controls"><span data-stepper></span><button class="remove-btn" type="button" data-remove>Remove</button></div>
        </div>
        <div class="line"><span class="price">${money(i.lineTotal)}</span></div>
      </li>`).join('')}
    </ul>
    <aside class="summary panel stitched">
      <h2>Order summary</h2>
      <div class="free-meter">${remaining > 0
        ? `Add <b>${money(remaining)}</b> more for <b>free delivery</b> ✿`
        : '<b>Yay — your delivery is free!</b> 🎀'}<div class="bar"><i style="width:${pct}%"></i></div></div>
      <div class="sum-row"><span>Subtotal (${data.count} item${data.count === 1 ? '' : 's'})</span><span>${money(data.subtotal)}</span></div>
      <div class="sum-row"><span>Delivery</span><span>${data.shippingEstimate ? money(data.shippingEstimate) : 'Free'}</span></div>
      <div class="sum-row total"><span>Total</span><span>${money(data.total)}</span></div>
      <p class="muted" style="font-size:.8rem;margin:4px 0 16px">Delivery is confirmed for your PIN code at checkout.</p>
      ${blocked ? '<p class="notice error" style="margin-bottom:12px">Please fix the highlighted items first.</p>' : ''}
      <a class="btn btn-block ${blocked ? 'is-disabled' : ''}" href="/checkout.html" ${blocked ? 'aria-disabled="true" tabindex="-1"' : ''}>Checkout securely</a>
      <p style="text-align:center;margin:14px 0 0"><a href="/shop.html">← keep shopping</a></p>
    </aside>
  </div>`;

  data.items.forEach((i) => {
    const row = host.querySelector(`[data-item="${i.id}"]`);
    const s = stepper({
      value: Math.min(i.quantity, Math.max(1, i.maxQuantity)), min: 1, max: Math.max(1, i.maxQuantity), size: 'sm', label: i.name,
      onChange: async (v) => {
        row.style.opacity = '.6';
        try { await cart.setQty(i.id, v); } catch (e) { toastError(e); await cart.load(); }
      },
    });
    $('[data-stepper]', row).append(s.el);
    $('[data-remove]', row).addEventListener('click', async () => {
      row.style.transition = 'opacity .3s, transform .3s';
      row.style.opacity = '0';
      row.style.transform = 'translateX(30px)';
      try { await cart.remove(i.id); } catch (e) { toastError(e); await cart.load(); }
    });
  });
  $$('.is-disabled', host).forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
}

// The bag belongs to a signed-in customer: a visitor is sent to log in and comes straight back here.
document.addEventListener('cart:change', (e) => {
  if (e.detail?.loginRequired) { location.replace(`/account.html?reason=bag&next=${encodeURIComponent('/cart.html')}`); return; }
  if (e.detail) render(e.detail);
});
