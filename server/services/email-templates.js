/**
 * Branded, table-based email templates (email clients ignore most modern CSS).
 * Palette: Guava #C96C80 · Kobi #D197A2 · Ballerina #E6C0C9 · Titanium #D5D4CD · Matcha #BCCA7D
 */
const C = { guava: '#C96C80', kobi: '#D197A2', ballerina: '#E6C0C9', titanium: '#D5D4CD', matcha: '#BCCA7D', cream: '#FFF8EE', cocoa: '#5B3A3A', ink: '#4a3434' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const abs = (url, appUrl) => (!url ? '' : /^https?:/.test(url) ? url : `${appUrl}${url}`);
/** Email clients can't show SVG; seed artwork ships a PNG twin next to each SVG. */
const emailImg = (url, appUrl) => abs(String(url || '').replace(/\.svg$/i, '.png'), appUrl);

function layout({ preheader, title, script, body, appUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.ballerina};font-family:Georgia,'Times New Roman',serif;color:${C.ink}">
<div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ballerina};padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.cream};border:2px solid ${C.guava};border-radius:6px">
<tr><td style="padding:6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px dashed ${C.kobi};border-radius:4px">
<tr><td align="center" style="padding:28px 24px 8px">
  <div style="font-size:12px;letter-spacing:4px;text-transform:uppercase;color:${C.guava}">✿ Maison ✿</div>
  <div style="font-size:30px;font-style:italic;font-weight:bold;letter-spacing:3px;color:${C.guava};line-height:1.1">CLAYSLAY</div>
  <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:${C.kobi};margin-top:4px">handmade clay charms</div>
  <div style="color:${C.kobi};font-size:14px;margin-top:10px">· ♡ · ✿ · ♡ ·</div>
</td></tr>
<tr><td align="center" style="padding:6px 28px 0">
  <div style="font-size:15px;font-style:italic;color:${C.kobi}">${esc(script)}</div>
  <h1 style="margin:6px 0 16px;font-size:26px;font-weight:normal;color:${C.cocoa}">${esc(title)}</h1>
</td></tr>
<tr><td style="padding:0 28px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${C.ink}">${body}</td></tr>
<tr><td align="center" style="padding:18px 24px 26px;border-top:1px dashed ${C.kobi};font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#8a6b6b">
  Made by hand, packed with love 🍓<br><a href="${appUrl}" style="color:${C.guava}">${esc(appUrl.replace(/^https?:\/\//, ''))}</a>
</td></tr>
</table></td></tr></table>
</td></tr></table></body></html>`;
}

function itemsTable(items, order, appUrl) {
  const rows = items.map((i) => `<tr>
    <td width="64" style="padding:8px 0;border-bottom:1px dotted ${C.kobi}">${i.image_url ? `<img src="${emailImg(i.image_url, appUrl)}" width="56" height="56" alt="" style="display:block;border-radius:4px;background:${C.ballerina};object-fit:cover">` : ''}</td>
    <td style="padding:8px 10px;border-bottom:1px dotted ${C.kobi}"><strong>${esc(i.product_name)}</strong>${i.variant_name ? `<br><span style="color:#8a6b6b;font-size:13px">${esc(i.variant_name)}</span>` : ''}<br><span style="color:#8a6b6b;font-size:13px">${i.quantity} × ${rupees(i.unit_price)}</span></td>
    <td align="right" style="padding:8px 0;border-bottom:1px dotted ${C.kobi};white-space:nowrap">${rupees(i.line_total)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">${rows}
  <tr><td></td><td style="padding:8px 10px 2px">Subtotal</td><td align="right" style="padding:8px 0 2px">${rupees(order.subtotal)}</td></tr>
  <tr><td></td><td style="padding:2px 10px">Delivery</td><td align="right" style="padding:2px 0">${order.shipping_fee ? rupees(order.shipping_fee) : 'Free'}</td></tr>
  <tr><td></td><td style="padding:6px 10px;font-weight:bold;color:${C.guava}">Total paid</td><td align="right" style="padding:6px 0;font-weight:bold;color:${C.guava}">${rupees(order.total)}</td></tr></table>`;
}

const address = (o) => `<div style="background:#fff;border:1px solid ${C.ballerina};border-radius:4px;padding:12px 14px;margin:12px 0;font-size:14px">
  <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.guava};margin-bottom:4px">Delivering to</div>
  ${esc(o.ship_name)}<br>${esc(o.ship_line1)}${o.ship_line2 ? `, ${esc(o.ship_line2)}` : ''}<br>${esc(o.ship_city)}, ${esc(o.ship_state)} – ${esc(o.ship_pincode)}<br>☎ ${esc(o.ship_phone)}</div>`;

const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px auto 6px"><tr><td style="background:${C.guava};border-radius:999px">
  <a href="${href}" style="display:inline-block;padding:12px 26px;color:#fff;text-decoration:none;font-weight:bold;font-size:14px">${esc(label)}</a></td></tr></table>`;

const shipBox = (s) => !s ? '' : `<div style="background:#f4f6e6;border:1px solid ${C.matcha};border-radius:4px;padding:12px 14px;margin:12px 0;font-size:14px">
  <strong>Courier:</strong> ${esc(s.courier_name || '—')}<br><strong>Tracking (AWB):</strong> ${esc(s.awb_code || '—')}${s.etd ? `<br><strong>Expected by:</strong> ${esc(String(s.etd).slice(0, 10))}` : ''}</div>`;

export function renderEmail(type, { order, items, shipment, extra, appUrl }) {
  const trackUrl = `${appUrl}/track.html?order=${encodeURIComponent(order.order_number)}`;
  const first = esc(order.customer_name.split(' ')[0]);
  const base = { appUrl };
  const t = type.split(':')[0];

  const T = {
    order_confirmed: () => ({
      subject: `Your CLAYSLAY order ${order.order_number} is confirmed 🎀`,
      html: layout({ ...base, preheader: 'Payment received — your little treasures are getting ready!', script: 'a little letter for you', title: 'Your little treasures are getting ready!',
        body: `<p>Hi ${first},</p><p>Thank you so much for your order! Your payment of <strong>${rupees(order.total)}</strong> has been received and confirmed. Each charm is shaped, baked and glazed by hand, and we'll write again the moment your parcel is on its way.</p>
        <p style="font-size:13px;color:#8a6b6b">Order <strong>${esc(order.order_number)}</strong> · Payment: <strong style="color:#6b7d2a">Paid</strong></p>
        ${itemsTable(items, order, appUrl)}${address(order)}${button(trackUrl, 'Track my order')}` }),
    }),
    order_preparing: () => ({
      subject: `We're making your CLAYSLAY charms ✿ (${order.order_number})`,
      html: layout({ ...base, preheader: 'Your order is on the workbench', script: 'fresh from the workbench', title: 'Your order is being prepared',
        body: `<p>Hi ${first},</p><p>Your little treasures are on our workbench right now — being finished, polished and checked one by one. Next stop: a cosy, ribbon-tied box.</p>${button(trackUrl, 'See order progress')}` }),
    }),
    shipped: () => ({
      subject: `Your CLAYSLAY parcel is on its way 🚚 (${order.order_number})`,
      html: layout({ ...base, preheader: 'Your parcel has been handed to the courier', script: 'it has left the boutique', title: 'Your parcel is on its way!',
        body: `<p>Hi ${first},</p><p>Your parcel has been picked up by our courier partner and is travelling to you.</p>${shipBox(shipment)}${button(shipment?.tracking_url || trackUrl, 'Track my parcel')}` }),
    }),
    tracking: () => ({
      subject: `Update on your CLAYSLAY parcel (${order.order_number})`,
      html: layout({ ...base, preheader: extra.description || 'A tracking update', script: 'a little update', title: esc(extra.label || 'Tracking update'),
        body: `<p>Hi ${first},</p><p>${esc(extra.description || 'There is a new update on your shipment.')}${extra.location ? ` <em>(${esc(extra.location)})</em>` : ''}</p>${shipBox(shipment)}${button(trackUrl, 'View tracking')}` }),
    }),
    out_for_delivery: () => ({
      subject: `Out for delivery today 💌 (${order.order_number})`,
      html: layout({ ...base, preheader: 'Your parcel arrives today', script: 'almost there…', title: 'Your parcel is out for delivery',
        body: `<p>Hi ${first},</p><p>Your CLAYSLAY parcel is out for delivery and should reach you today. Please keep your phone handy for the courier.</p>${shipBox(shipment)}${button(trackUrl, 'Track live')}` }),
    }),
    delivered: () => ({
      subject: `Delivered! Enjoy your little treasures 🍓 (${order.order_number})`,
      html: layout({ ...base, preheader: 'Your parcel has arrived', script: 'special delivery', title: 'Your parcel has arrived!',
        body: `<p>Hi ${first},</p><p>Your parcel has been delivered. We hope your new charms make every day a little sweeter. If anything isn't perfect, just reply to this email — we'll make it right.</p>${button(`${appUrl}/shop.html`, 'Visit the boutique')}` }),
    }),
    delivery_failed: () => ({
      subject: `We missed you — delivery attempt for ${order.order_number}`,
      html: layout({ ...base, preheader: 'The courier could not deliver your parcel', script: 'oh no!', title: 'Delivery attempt unsuccessful',
        body: `<p>Hi ${first},</p><p>The courier tried to deliver your parcel but couldn't complete it. They'll usually re-attempt; please make sure someone is available and your phone is reachable. Reply to this email if you need to change anything.</p>${shipBox(shipment)}${button(trackUrl, 'View tracking')}` }),
    }),
    rto_initiated: () => ({
      subject: `Your parcel is returning to us (${order.order_number})`,
      html: layout({ ...base, preheader: 'Delivery could not be completed', script: 'a small hiccup', title: 'Your parcel is coming back to us',
        body: `<p>Hi ${first},</p><p>After several delivery attempts, the courier is returning your parcel to us. Don't worry — reply to this email and we'll arrange re-delivery or a refund.</p>` }),
    }),
    cancelled: () => ({
      subject: `Your order ${order.order_number} has been cancelled`,
      html: layout({ ...base, preheader: 'Order cancelled', script: 'a note from the boutique', title: 'Your order was cancelled',
        body: `<p>Hi ${first},</p><p>Your order <strong>${esc(order.order_number)}</strong> has been cancelled.${order.payment_status === 'paid' || order.payment_status.includes('refund') ? ' If you were charged, your refund will be (or has been) sent back to your original payment method — we\'ll email you once it is processed.' : ''}</p>${extra.reason ? `<p><em>Reason: ${esc(extra.reason)}</em></p>` : ''}` }),
    }),
    refund: () => ({
      subject: `Refund ${extra.status === 'processed' ? 'processed' : 'initiated'} for ${order.order_number}`,
      html: layout({ ...base, preheader: 'Refund update', script: 'a refund update', title: `Refund of ${rupees(extra.amount || 0)} ${extra.status === 'processed' ? 'processed' : 'initiated'}`,
        body: `<p>Hi ${first},</p><p>We've ${extra.status === 'processed' ? 'processed' : 'initiated'} a refund of <strong>${rupees(extra.amount || 0)}</strong> to your original payment method. Banks usually take 5–7 working days to show it.</p><p style="font-size:13px;color:#8a6b6b">Reference: ${esc(extra.refundId || '')}</p>` }),
    }),
    owner_new_order: () => ({
      subject: `🛍 New paid order ${order.order_number} — ${rupees(order.total)}`,
      html: layout({ ...base, preheader: 'A new order just came in', script: 'ding ding!', title: 'New order received',
        body: `<p><strong>${esc(order.customer_name)}</strong> (${esc(order.customer_email)}, ${esc(order.customer_phone)}) just paid.</p>${itemsTable(items, order, appUrl)}${address(order)}${order.gift_note ? `<p><strong>Gift note:</strong> ${esc(order.gift_note)}</p>` : ''}${button(`${appUrl}/admin/#orders/${order.order_number}`, 'Open in admin')}` }),
    }),
  };
  const f = T[t];
  if (!f) throw new Error(`Unknown email type ${type}`);
  return f();
}

/** "Please confirm your email" — sent at sign-up and when the customer asks for a new link. */
export function renderVerifyEmail({ name, link, appUrl, hours }) {
  const first = esc(String(name || '').split(' ')[0] || 'there');
  return {
    subject: 'Please confirm your email for CLAYSLAY ✿',
    html: layout({ appUrl, preheader: 'One tap to confirm your email address', script: 'welcome to the boutique!', title: 'Confirm your email',
      body: `<p>Hi ${first},</p><p>Thank you for creating your CLAYSLAY account! Please confirm this is your email address so we can
        reach you about your orders.</p>${button(link, 'Confirm my email')}
        <p style="font-size:13px;color:#8a6b6b">This link works once and expires in ${hours} hours. If the button doesn't work, copy this
        address into your browser:<br><a href="${esc(link)}" style="color:${C.guava};word-break:break-all">${esc(link)}</a></p>
        <p style="font-size:13px;color:#8a6b6b">Didn't create an account? You can safely ignore this email.</p>` }),
  };
}
