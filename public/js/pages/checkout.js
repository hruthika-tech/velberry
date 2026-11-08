import { siteConfig } from '../layout.js';
import { api, money, esc, $, $$, showFieldErrors } from '../api.js';
import { charmSVG } from '../charms.js';
import { cart, toastError, toast, loaderHTML } from '../ui.js';

const host = $('[data-checkout]');
host.innerHTML = loaderHTML('Setting the table…');
const pageNonce = crypto.randomUUID();
let config;
let account = null;
let quote = null;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

async function init() {
  config = await siteConfig;
  // Checkout is for signed-in customers (the server refuses every checkout call otherwise); come straight back after.
  if (!config.user) { location.replace(`/account.html?reason=checkout&next=${encodeURIComponent('/checkout.html')}`); return; }
  const bag = await cart.load();
  if (!bag.items.length) {
    host.innerHTML = `<div class="panel stitched empty-state" style="max-width:520px;margin:0 auto 80px">${charmSVG('teacup', { size: 100 })}<h2>Your bag is empty</h2><a class="btn" href="/shop.html">Explore the Collection</a></div>`;
    return;
  }
  if (bag.items.some((i) => i.problem)) { location.href = '/cart.html'; return; }
  try { account = await api('/account'); } catch { /* saved details are a convenience; the form still works */ }
  if (config.paymentMode === 'mock') $('[data-test-banner]').innerHTML = '<p class="notice test" style="margin-bottom:18px">🧪 Test mode — payments are simulated locally until Razorpay keys are added.</p>';
  if (config.paymentMode === 'razorpay' && config.paymentEnv === 'test') $('[data-test-banner]').innerHTML = '<p class="notice test" style="margin-bottom:18px">🧪 Razorpay test mode — use Razorpay\'s test cards or UPI IDs. No real money is charged.</p>';
  if (config.paymentMode === 'disabled') $('[data-test-banner]').innerHTML = '<p class="notice error" style="margin-bottom:18px">Payments are not set up yet, so orders can\'t be placed right now.</p>';
  render(bag);
}

const stateOptions = (sel) => `<option value="">Select state</option>${config.states.map((s) => `<option${s === sel ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;

function render(bag) {
  const u = account?.user || config.user;
  const saved = account?.addresses || [];
  // One column, in the order the customer fills it in: details → address → order summary → payment (last).
  host.innerHTML = `<form class="checkout-flow" novalidate data-form>
      <section class="panel step">
        <h2><span class="num">1</span>Your details</h2>
        <div class="field"><label for="c-name">Full name</label><input id="c-name" name="name" autocomplete="name" required value="${esc(u?.name || '')}"></div>
        <div class="grid-2">
          <div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" autocomplete="email" required value="${esc(u?.email || '')}"><span class="hint">Your order letter &amp; tracking updates go here</span></div>
          <div class="field"><label for="c-phone">Mobile number</label><input id="c-phone" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14" required value="${esc(u?.phone || '')}"></div>
        </div>
      </section>

      <section class="panel step">
        <h2><span class="num">2</span>Delivery address</h2>
        ${saved.length ? `<div class="saved-addresses" role="radiogroup" aria-label="Saved addresses">
          ${saved.map((a, i) => `<label class="addr-option"><input type="radio" name="addrChoice" value="${a.id}" ${a.is_default || (i === 0 && !saved.some((x) => x.is_default)) ? 'checked' : ''}>
            <span><b>${esc(a.name)}</b>${a.label ? ` · ${esc(a.label)}` : ''}<br>${esc(a.line1)}${a.line2 ? `, ${esc(a.line2)}` : ''}, ${esc(a.city)}, ${esc(a.state)} – ${esc(a.pincode)}<br><span class="muted">☎ ${esc(a.phone)}</span></span></label>`).join('')}
          <label class="addr-option"><input type="radio" name="addrChoice" value="new"><span><b>Deliver somewhere new</b></span></label>
        </div>` : ''}
        <div data-new-address ${saved.length ? 'hidden' : ''}>
          <div class="grid-2">
            <div class="field"><label for="a-name">Receiver's name</label><input id="a-name" name="a_name" autocomplete="shipping name"></div>
            <div class="field"><label for="a-phone">Receiver's mobile</label><input id="a-phone" name="a_phone" type="tel" inputmode="numeric" autocomplete="shipping tel-national" maxlength="14"></div>
          </div>
          <div class="field"><label for="a-line1">House / flat, street</label><input id="a-line1" name="line1" autocomplete="shipping address-line1"></div>
          <div class="field"><label for="a-line2">Area, landmark <span class="muted">(optional)</span></label><input id="a-line2" name="line2" autocomplete="shipping address-line2"></div>
          <div class="grid-3">
            <div class="field"><label for="a-pin">PIN code</label><input id="a-pin" name="pincode" inputmode="numeric" maxlength="6" autocomplete="shipping postal-code"></div>
            <div class="field"><label for="a-city">City</label><input id="a-city" name="city" autocomplete="shipping address-level2"></div>
            <div class="field"><label for="a-state">State</label><select id="a-state" name="state" autocomplete="shipping address-level1">${stateOptions('')}</select></div>
          </div>
          <label class="check"><input type="checkbox" name="saveAddress" checked> Save this address to my account</label>
        </div>
        <p class="ship-quote" data-quote aria-live="polite"></p>
      </section>

      <section class="panel stitched step co-summary">
        <h2><span class="num">3</span>Order summary</h2>
        <ul class="mini-items">${bag.items.map((i) => `<li><img src="${esc(i.image || '')}" alt=""><div>${esc(i.name)}${i.variantName ? ` <span class="muted">· ${esc(i.variantName)}</span>` : ''}<div class="q">Qty ${i.quantity} × ${money(i.unitPrice)}</div></div><span>${money(i.lineTotal)}</span></li>`).join('')}</ul>
        <p class="co-edit"><a href="/cart.html">← edit bag</a></p>
        <div class="field"><label for="g-note">Gift note <span class="muted">(optional) — we'll handwrite it on a card</span></label><textarea id="g-note" name="giftNote" maxlength="300" placeholder="Happy birthday, bestie! ♡"></textarea></div>
        <div class="sum-row"><span>Subtotal</span><span>${money(bag.subtotal)}</span></div>
        <div class="sum-row"><span>Delivery</span><span data-fee>${bag.shippingEstimate ? money(bag.shippingEstimate) : 'Free'}</span></div>
      </section>

      <section class="panel step co-pay">
        <h2><span class="num">4</span>Payment</h2>
        <div class="sum-row total"><span>Total to pay</span><span data-total>${money(bag.total)}</span></div>
        <p class="co-pay-note">The final amount is confirmed by our server for your PIN code before the payment window opens.</p>
        <button class="btn btn-block" type="submit" data-pay ${config.paymentMode === 'disabled' ? 'disabled' : ''}>Pay <span data-pay-amount>${money(bag.total)}</span> securely</button>
        <p class="pay-safe">🔒 UPI · Cards · Netbanking · Wallets via Razorpay. Your card details never touch our servers.</p>
      </section>
  </form>`;

  const form = $('[data-form]');
  const newBox = $('[data-new-address]');
  $$('input[name="addrChoice"]', form).forEach((r) => r.addEventListener('change', () => {
    if (r.checked) newBox.hidden = r.value !== 'new';
    refreshQuote();
  }));
  const pin = $('#a-pin');
  pin.addEventListener('input', async () => {
    pin.value = pin.value.replace(/\D/g, '').slice(0, 6);
    if (pin.value.length !== 6) return;
    refreshQuote();
    try {
      const r = await api(`/pincode/${pin.value}`);
      if (r.found) {
        if (!$('#a-city').value) $('#a-city').value = r.city;
        const st = config.states.find((s) => s.toLowerCase() === String(r.state).toLowerCase());
        if (st) $('#a-state').value = st;
      }
    } catch { /* lookup is best-effort */ }
  });
  // receiver defaults to the customer
  $('#c-name').addEventListener('change', () => { if (!$('#a-name').value) $('#a-name').value = $('#c-name').value; });
  $('#c-phone').addEventListener('change', () => { if (!$('#a-phone').value) $('#a-phone').value = $('#c-phone').value; });
  if (!$('#a-name').value) $('#a-name').value = u?.name || '';
  if (!$('#a-phone').value) $('#a-phone').value = u?.phone || '';

  form.addEventListener('submit', (e) => { e.preventDefault(); placeOrder(form, bag); });
  // A field's error disappears as soon as the customer edits it (the full check runs again on Pay).
  const clearError = (e) => {
    const field = e.target.closest?.('.field.has-error');
    if (!field) return;
    field.classList.remove('has-error');
    field.querySelector('.error')?.remove();
  };
  form.addEventListener('input', clearError);
  form.addEventListener('change', clearError);
  refreshQuote();

  function chosenAddress() {
    const choice = $('input[name="addrChoice"]:checked', form)?.value;
    if (choice && choice !== 'new') {
      const a = saved.find((x) => String(x.id) === choice);
      return { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 || '', city: a.city, state: a.state, pincode: a.pincode, saved: true };
    }
    const f = new FormData(form);
    return { name: f.get('a_name'), phone: f.get('a_phone'), line1: f.get('line1'), line2: f.get('line2'), city: f.get('city'), state: f.get('state'), pincode: f.get('pincode') };
  }
  form.chosenAddress = chosenAddress;

  async function refreshQuote() {
    const pincode = chosenAddress().pincode;
    const q = $('[data-quote]');
    if (!/^[1-9]\d{5}$/.test(pincode || '')) { q.textContent = ''; return; }
    q.innerHTML = '<span class="muted">Checking delivery to your PIN code…</span>';
    try {
      quote = await api('/checkout/quote', { method: 'POST', body: { pincode } });
      q.innerHTML = `<span class="chip green">✓ We deliver to ${esc(pincode)}</span>${quote.etd ? ` <span class="muted">· est. ${esc(quote.etd)}</span>` : ''}`;
      $('[data-fee]').textContent = quote.fee ? money(quote.fee) : 'Free';
      $('[data-total]').textContent = money(quote.total);
      $('[data-pay-amount]').textContent = money(quote.total);
    } catch (e) {
      quote = null;
      q.innerHTML = `<span class="chip red">${esc(e.message)}</span>`;
    }
  }
}

/** Same rules as the server (server/lib/validate.js) — checked here first so nobody reaches payment with gaps. */
const mobile = (v) => /^[6-9]\d{9}$/.test(String(v || '').replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''));
function checkoutErrors(customer, address) {
  const e = {};
  if (!String(customer.name || '').trim()) e.name = 'Please tell us your name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(customer.email || '').trim())) e.email = 'Enter a valid email';
  if (!mobile(customer.phone)) e.phone = 'Enter a valid 10-digit Indian mobile number';
  if (!address.saved) {
    if (!String(address.name || '').trim()) e.a_name = 'Who is receiving the parcel?';
    if (!mobile(address.phone)) e.a_phone = 'Enter a valid 10-digit Indian mobile number';
    if (!String(address.line1 || '').trim()) e.line1 = 'House / street is required';
    if (!String(address.city || '').trim()) e.city = 'City is required';
    if (!address.state) e.state = 'Choose your state';
    if (!/^[1-9]\d{5}$/.test(String(address.pincode || ''))) e.pincode = 'Enter a valid 6-digit PIN code';
  }
  return e;
}

async function placeOrder(form, bag) {
  const btn = $('[data-pay]');
  const f = new FormData(form);
  const customer = { name: f.get('name'), email: f.get('email'), phone: f.get('phone') };
  const address = form.chosenAddress();
  const errors = checkoutErrors(customer, address);
  showFieldErrors(form, errors);
  if (Object.keys(errors).length) {
    const first = form.querySelector('.field.has-error input, .field.has-error select');
    first?.focus();
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast({ title: 'A few details are missing', text: 'Please complete your details and delivery address before paying.', error: true });
    return;
  }
  if (!quote) {
    toast({ title: 'Delivery not confirmed yet', text: 'Please check your PIN code — we confirm delivery and the final total before payment.', error: true });
    return;
  }
  const body = {
    customer, address, giftNote: f.get('giftNote') || '', saveAddress: !address.saved && f.get('saveAddress') === 'on',
  };
  body.idempotencyKey = `${pageNonce}-${hash(JSON.stringify([bag.items.map((i) => [i.id, i.quantity]), customer, address, body.giftNote]))}`;
  btn.classList.add('is-loading');
  try {
    const order = await api('/checkout/order', { method: 'POST', body });
    sessionStorage.setItem(`vb_order_${order.orderNumber}`, order.accessToken);
    await pay(order);
  } catch (e) {
    showFieldErrors(form, e.details);
    toastError(e);
  } finally {
    btn.classList.remove('is-loading');
  }
}

function pay(order) {
  return new Promise((resolve) => {
    const succeed = async (resp) => {
      try {
        // The server re-checks everything with Razorpay; "pending" (not yet captured) also lands on the
        // order page, which keeps checking and only celebrates once the payment is confirmed.
        const v = await api('/checkout/verify', { method: 'POST', body: { orderNumber: order.orderNumber, accessToken: order.accessToken, ...resp } });
        location.href = `/order-success.html?order=${encodeURIComponent(v.orderNumber)}&t=${encodeURIComponent(order.accessToken)}`;
      } catch (e) {
        toast({ title: 'We are confirming your payment', text: `${e.message}. If money was deducted, don't worry — we verify every payment with Razorpay and will update your order.`, error: true, ms: 9000 });
      }
      resolve();
    };
    const failed = async (paymentId, reason) => {
      api('/checkout/failed', { method: 'POST', body: { orderNumber: order.orderNumber, accessToken: order.accessToken, razorpay_payment_id: paymentId } }).catch(() => {});
      toast({ title: 'Payment didn\'t go through', text: reason || 'No money was taken. You can try again — your charms are held for 30 minutes.', error: true, ms: 8000 });
    };

    if (order.paymentMode === 'mock') {
      const dlg = $('[data-mock]');
      $('[data-mock-amount]').textContent = money(order.amount);
      const simulate = async (outcome) => {
        const r = await api('/checkout/mock-pay', { method: 'POST', body: { orderNumber: order.orderNumber, accessToken: order.accessToken, outcome } });
        dlg.close();
        if (r.failed) { await failed(r.razorpay_payment_id, 'Simulated failure — try again!'); resolve(); } else await succeed(r);
      };
      $('[data-mock-pay]').onclick = (e) => { e.currentTarget.classList.add('is-loading'); simulate('success'); };
      $('[data-mock-fail]').onclick = () => simulate('fail');
      $('[data-mock-close]').onclick = () => { dlg.close(); resolve(); };
      dlg.showModal();
      return;
    }

    loadRazorpay().then(() => {
      const rzp = new window.Razorpay({
        key: order.razorpayKeyId,
        amount: order.amount,
        currency: order.currency,
        name: 'CLAYSLAY',
        description: `Order ${order.orderNumber}`,
        order_id: order.razorpayOrderId,
        prefill: order.prefill,
        notes: { order_number: order.orderNumber },
        theme: { color: '#C96C80' },
        handler: succeed,
        modal: { ondismiss: () => resolve(), confirm_close: true },
      });
      rzp.on('payment.failed', (r) => failed(r.error?.metadata?.payment_id, r.error?.description));
      rzp.open();
    }).catch(() => { toastError(new Error('Could not load the payment window. Check your connection and try again.')); resolve(); });
  });
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = res;
    s.onerror = rej;
    document.head.append(s);
  });
}

init().catch(toastError);
