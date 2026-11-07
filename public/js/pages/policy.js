/**
 * Contact / Privacy / Terms pages: fill business details from site-info.js.
 *   <span data-site="contactEmail"></span>   → the value (emails and URLs become links)
 *   <li data-site-row="phone">…</li>         → hidden when that detail isn't set
 *   [data-site-missing]                      → shown only while no contact detail is set at all
 */
import './static.js';
import { SITE } from '../site-info.js';

const link = (key, v) => {
  if (key === 'contactEmail') return Object.assign(document.createElement('a'), { href: `mailto:${v}`, textContent: v });
  if (key === 'instagram') return Object.assign(document.createElement('a'), { href: v, textContent: v.replace(/^https?:\/\/(www\.)?/, ''), rel: 'noopener' });
  if (key === 'phone') return Object.assign(document.createElement('a'), { href: `tel:${v.replace(/[^\d+]/g, '')}`, textContent: v });
  return document.createTextNode(v);
};

document.querySelectorAll('[data-site]').forEach((el) => {
  const v = SITE[el.dataset.site];
  if (v) el.replaceChildren(link(el.dataset.site, String(v)));
});
document.querySelectorAll('[data-site-row]').forEach((el) => { el.hidden = !SITE[el.dataset.siteRow]; });
const anyContact = ['contactEmail', 'phone', 'instagram'].some((k) => SITE[k]);
document.querySelectorAll('[data-site-missing]').forEach((el) => { el.hidden = anyContact; });
