/**
 * The signature order confirmation: an envelope whose letter carries the REAL order (fetched from the server).
 * Only plays once the server says the payment is verified ("paid"). Sequence:
 *   envelope appears → flap opens → folded letter slides out → unfolds (readable, scrollable)
 *   → folds back → slides in → flap closes → heart seal stamps.
 */
import '../layout.js';
import { api, money, esc, fmtDate, qs, reducedMotion, $ } from '../api.js';
import { CHARMS, charmSVG } from '../charms.js';
import { burst, loaderHTML } from '../ui.js';

const root = $('[data-root]');
const orderNumber = qs('order');
const token = qs('t') || (orderNumber && sessionStorage.getItem(`vb_order_${orderNumber}`));
const PAID = ['paid', 'partially_refunded', 'refunded'];

async function fetchOrder() {
  return api('/orders/lookup', { method: 'POST', body: { orderNumber, token } });
}

async function init() {
  if (!orderNumber) { location.href = '/'; return; }
  root.innerHTML = `<div class="confirming panel stitched">${loaderHTML('Confirming your payment with the bank…')}<p class="muted">This usually takes a few seconds. Please don't close this page.</p></div>`;
  let order;
  // The webhook may land a moment after the redirect — poll briefly. Never animate unless verified as paid.
  for (let i = 0; i < 15; i++) {
    try { order = await fetchOrder(); } catch (e) {
      if (e.status === 429) break; // busy (rate limit): fall through to the calm "still waiting" message below
      root.innerHTML = `<div class="confirming panel stitched">${charmSVG('cherries', { size: 90 })}<h2>We couldn't open this order</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="/track.html">Find my order</a></div>`;
      return;
    }
    if (order.isCancelled) {
      root.innerHTML = `<div class="confirming panel stitched">${charmSVG('cherries', { size: 90 })}<h2>This order was cancelled</h2>
        <p>Order <b>${esc(order.orderNumber)}</b> is cancelled. Any payment made for it is refunded to your original payment method.</p>
        <a class="btn" href="/track.html?order=${encodeURIComponent(order.orderNumber)}${token ? `&t=${encodeURIComponent(token)}` : ''}">See details</a></div>`;
      return;
    }
    if (PAID.includes(order.paymentStatus)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!order || !PAID.includes(order.paymentStatus)) {
    root.innerHTML = `<div class="confirming panel stitched">${charmSVG('teacup', { size: 90 })}
      <h2>We're still waiting for your bank</h2>
      <p>Order <b>${esc(order?.orderNumber || orderNumber)}</b> hasn't been confirmed as paid yet. If money was deducted, it will be confirmed automatically (or refunded by your bank) — you'll get an email either way.</p>
      <a class="btn" href="/track.html?order=${encodeURIComponent(order?.orderNumber || orderNumber)}${token ? `&t=${encodeURIComponent(token)}` : ''}">Check order status</a></div>`;
    return;
  }
  document.dispatchEvent(new CustomEvent('cart:change', { detail: { count: 0 } }));
  buildScene(order);
}

/* ───────── letter content (real order data) ───────── */
function letterHTML(o) {
  const first = o.customer.name.split(' ')[0];
  return `<div class="paper">
    <div class="lt-head"><div class="lt-brand">Velberry<small>handmade clay charms</small></div><div class="lt-date">${fmtDate(o.paidAt || o.createdAt, { day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
    <div class="lt-dear">Dear ${esc(first)},</div>
    <p class="lt-body">Thank you for choosing a little piece of Velberry! Your payment is confirmed and your treasures are being lovingly prepared — shaped, glazed and wrapped by hand, just for you.</p>
    <div class="lt-meta"><span>Order <b>${esc(o.orderNumber)}</b></span><span>Payment <b class="chip green">✓ ${o.paymentStatus === 'paid' ? 'Paid' : esc(o.paymentStatus)}</b></span><span>For <b>${esc(o.customer.name)}</b></span></div>
    <table class="lt-items"><tbody>
      ${o.items.map((i) => `<tr><td style="width:54px">${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}</td>
        <td><div class="n">${esc(i.name)}</div>${i.variantName ? `<div class="v">${esc(i.variantName)}</div>` : ''}<div class="v">${i.quantity} × ${money(i.unitPrice)}</div></td>
        <td class="r">${money(i.lineTotal)}</td></tr>`).join('')}
    </tbody></table>
    <div class="lt-sum"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div><div><span>Delivery</span><span>${o.shippingFee ? money(o.shippingFee) : 'Free'}</span></div><div class="t"><span>Total paid</span><span>${money(o.total)}</span></div></div>
    <div class="lt-addr"><b>Sending it to</b>${esc(o.address.name)} · ${esc(o.address.phone)}<br>${esc(o.address.line1)}${o.address.line2 ? `, ${esc(o.address.line2)}` : ''}<br>${esc(o.address.city)}, ${esc(o.address.state)} – ${esc(o.address.pincode)}</div>
    ${o.giftNote ? `<p class="lt-note">Your gift note: “${esc(o.giftNote)}” — we'll handwrite it on a card ♡</p>` : ''}
    <div class="lt-sign">With love &amp; sprinkles,<span>the Velberry studio</span></div>
  </div>`;
}

const pocketSVG = `<svg viewBox="0 0 100 62" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 0 L50 35 L0 62Z" fill="#BE5870"/><path d="M100 0 L50 35 L100 62Z" fill="#BA546C"/>
  <path d="M0 62 L50 27 L100 62Z" fill="#C9637A"/>
  <path d="M0 62 L50 27 L100 62" fill="none" stroke="rgba(255,255,255,.28)" stroke-width=".35"/>
  <path d="M0 0 L50 35 M100 0 L50 35" fill="none" stroke="rgba(91,30,45,.18)" stroke-width=".3"/></svg>`;

const sealSVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M50 6 C62 4 68 12 78 12 C88 14 92 26 94 36 C98 48 92 56 94 66 C92 80 80 86 70 90 C60 96 46 96 36 92 C24 90 14 82 10 70 C4 58 8 48 6 38 C8 24 18 16 28 12 C36 8 42 8 50 6Z" fill="#B23F57"/>
  <circle cx="50" cy="50" r="31" fill="#C24C64"/><circle cx="50" cy="50" r="31" fill="none" stroke="#9C3149" stroke-width="2.4" stroke-dasharray="2 3"/>
  <path d="M50 70 C32 58 28 47 34 40 C40 34 47 37 50 43 C53 37 60 34 66 40 C72 47 68 58 50 70Z" fill="#E68A9C" stroke="#8E2B42" stroke-width="2"/>
  <path d="M38 41 Q40 37 44 37" stroke="#FFD0D8" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;

/* ───────── animation helpers ───────── */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function to(el, frames, duration, easing = 'cubic-bezier(.22,.8,.32,1)') {
  const last = frames[frames.length - 1];
  if (!reducedMotion()) {
    const a = el.animate(frames, { duration, easing, fill: 'forwards' });
    await a.finished;
    Object.assign(el.style, last);
    a.cancel();
  } else {
    Object.assign(el.style, last);
  }
}

function buildScene(o) {
  root.innerHTML = `
    <div class="env-intro"><span class="eyebrow">Special delivery</span><h1 data-title>A little letter, just for you</h1></div>
    <div class="env-scene" data-scene>
      <div class="letter" data-letter aria-hidden="true">
        <span class="tape-l"></span><span class="tape-r"></span>
        <div class="panel p0"><div class="face"></div><div class="back"></div></div>
        <div class="panel p1"><div class="face"></div><div class="back"></div></div>
        <div class="panel p2"><div class="face"></div><div class="back"></div></div>
        <div class="letter-read" data-read tabindex="0" aria-label="Your order letter" role="document">${letterHTML(o)}</div>
      </div>
      <div class="envelope" data-envelope style="opacity:0">
        <div class="env-back"><div class="env-liner"></div></div>
        <div class="env-pocket">${pocketSVG}</div>
        <div class="env-stickers">
          <span class="sticker" style="left:7%;top:58%;width:13%;transform:rotate(-14deg)">${charmSVG('strawberry', { size: 60 })}</span>
          <span class="sticker" style="left:22%;top:72%;width:9%;transform:rotate(10deg)">${charmSVG('daisy', { size: 60 })}</span>
          <span class="sticker" style="right:28%;top:66%;width:11%;transform:rotate(8deg)">${charmSVG('bow', { size: 60 })}</span>
          <span class="postmark">with love · velberry</span>
          <span class="stamp"><div>${charmSVG('heart', { size: 40 })}</div></span>
        </div>
        <div class="env-flap" data-flap><div class="face"></div><div class="back"></div></div>
      </div>
      <div class="env-seal" data-seal>${sealSVG}</div>
    </div>
    <div class="letter-controls" data-controls hidden>
      <button class="btn" type="button" data-seal-btn>💌 Tuck it back &amp; seal</button>
    </div>
    <div class="env-final" data-final>
      <span class="script">Your little treasures are getting ready!</span>
      <p class="muted">A copy of this letter is on its way to ${esc(o.customer.email)}.</p>
      <div class="actions">
        <a class="btn" href="/track.html?order=${encodeURIComponent(o.orderNumber)}${token ? `&t=${encodeURIComponent(token)}` : ''}">View my order</a>
        <a class="btn btn-ghost" href="/shop.html">Continue shopping</a>
        <button class="btn btn-cream" type="button" data-reread>Read my letter again</button>
      </div>
    </div>`;

  const scene = $('[data-scene]');
  const letter = $('[data-letter]');
  const read = $('[data-read]');
  const env = $('[data-envelope]');
  const flap = $('[data-flap]');
  const seal = $('[data-seal]');
  const [p0, p1, p2] = letter.querySelectorAll('.panel');
  const controls = $('[data-controls]');
  const final = $('[data-final]');

  // ── geometry (px) ──
  const W = scene.clientWidth;
  const EH = W * 0.62;
  const LW = W * 0.9;
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;width:${LW}px;left:-9999px`;
  probe.innerHTML = letterHTML(o);
  document.body.append(probe);
  const natural = probe.offsetHeight;
  probe.remove();
  const maxH = Math.min(EH * 0.9 * 3, Math.max(420, innerHeight - 190));
  const H = Math.round(Math.min(natural, maxH) / 3) * 3;
  const F = H / 3;
  const envTop = H - EH * 0.42;
  scene.style.height = `${envTop + EH + 12}px`;
  env.style.top = `${envTop}px`;
  letter.style.height = `${H}px`;
  seal.style.top = `${envTop + EH * 0.64}px`;
  [p0, p1, p2].forEach((p, i) => {
    p.style.top = `${i * F}px`;
    p.style.height = `${F}px`;
    const face = p.querySelector('.face');
    face.innerHTML = `<div style="position:absolute;left:0;right:0;top:${-i * F}px">${letterHTML(o)}</div>`;
  });
  const inY = envTop + EH * 0.92 - 2 * F;
  const outY = envTop + EH * 0.18 - 2 * F;
  const FOLD0 = 'translateZ(2px) rotateX(-180deg)';
  const FOLD2 = 'translateZ(1px) rotateX(180deg)';
  const OPEN = 'translateZ(0) rotateX(0deg)';

  let autoTimer = null;
  let busy = false;

  async function open({ fromSealed = false } = {}) {
    busy = true;
    final.classList.remove('show');
    controls.hidden = true;
    if (!fromSealed) {
      await to(env, [{ opacity: 0, transform: 'translateY(50px) scale(.9)' }, { opacity: 1, transform: 'none' }], 750, 'cubic-bezier(.34,1.56,.64,1)');
      env.style.transform = ''; // keep envelope parts in the scene's stacking context
      env.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      await wait(350);
    } else {
      await to(seal, [{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-80%) scale(.6) rotate(20deg)' }], 350);
    }
    // flap opens
    flap.style.zIndex = 4;
    await to(flap, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(180deg)' }], 700, 'cubic-bezier(.45,.05,.3,1)');
    flap.style.zIndex = 0;
    // folded letter slides out
    p0.style.transform = FOLD0; p2.style.transform = FOLD2;
    letter.style.zIndex = 2;
    letter.classList.remove('reading');
    letter.style.opacity = 1;
    await to(letter, [{ transform: `translateY(${inY}px)` }, { transform: `translateY(${outY}px)` }], 900);
    letter.style.zIndex = 6;
    // rises to you, then unfolds
    letter.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    await to(letter, [{ transform: `translateY(${outY}px) scale(.96)` }, { transform: 'translateY(0) scale(1)' }], 700);
    await to(p2, [{ transform: FOLD2 }, { transform: OPEN }], 650, 'cubic-bezier(.3,.7,.3,1)');
    await to(p0, [{ transform: FOLD0 }, { transform: OPEN }], 650, 'cubic-bezier(.3,.7,.3,1)');
    letter.classList.add('reading');
    letter.removeAttribute('aria-hidden');
    read.scrollTop = 0;
    controls.hidden = false;
    $('[data-title]').textContent = 'Your order, written with love';
    busy = false;
    // Seal automatically after a while — unless the customer is reading (any interaction pauses it).
    clearTimeout(autoTimer);
    if (!reducedMotion()) autoTimer = setTimeout(seal_, 16000);
  }

  async function seal_() {
    if (busy) return;
    busy = true;
    clearTimeout(autoTimer);
    controls.hidden = true;
    read.scrollTop = 0;
    letter.classList.remove('reading');
    letter.setAttribute('aria-hidden', 'true');
    await to(p0, [{ transform: OPEN }, { transform: FOLD0 }], 600, 'cubic-bezier(.5,0,.5,1)');
    await to(p2, [{ transform: OPEN }, { transform: FOLD2 }], 600, 'cubic-bezier(.5,0,.5,1)');
    env.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    await to(letter, [{ transform: 'translateY(0) scale(1)' }, { transform: `translateY(${outY}px) scale(.96)` }], 650);
    letter.style.zIndex = 2;
    await to(letter, [{ transform: `translateY(${outY}px)` }, { transform: `translateY(${inY}px)` }], 800, 'cubic-bezier(.5,0,.4,1)');
    // flap closes over it
    await to(flap, [{ transform: 'rotateX(180deg)' }, { transform: 'rotateX(90deg)' }], 320, 'ease-in');
    flap.style.zIndex = 4;
    await to(flap, [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }], 320, 'ease-out');
    letter.style.opacity = 0;
    // the heart seal
    await to(seal, [
      { opacity: 0, transform: 'translate(-50%,-50%) scale(2.4) rotate(-25deg)' },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(.92) rotate(4deg)', offset: 0.7 },
      { opacity: 1, transform: 'translate(-50%,-50%) scale(1) rotate(0deg)' },
    ], 650, 'cubic-bezier(.3,.6,.3,1)');
    const r = seal.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, ['♥', '♡', '✿', '✦']);
    $('[data-title]').textContent = 'Sealed with love';
    final.classList.add('show');
    busy = false;
  }

  // reading pauses the automatic sealing
  ['pointerdown', 'wheel', 'keydown', 'touchstart'].forEach((ev) => read.addEventListener(ev, () => clearTimeout(autoTimer), { passive: true }));
  $('[data-seal-btn]').addEventListener('click', seal_);
  $('[data-reread]').addEventListener('click', () => { if (!busy) open({ fromSealed: true }); });

  if (reducedMotion()) {
    // No motion: show the open letter straight away.
    env.style.opacity = 1;
    flap.style.transform = 'rotateX(180deg)';
    flap.style.zIndex = 0;
    letter.style.opacity = 1;
    letter.style.zIndex = 6;
    letter.style.transform = 'none';
    letter.classList.add('reading');
    letter.removeAttribute('aria-hidden');
    controls.hidden = false;
  } else {
    open();
  }
}

init();
