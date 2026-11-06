/** Thin JSON API client + formatting helpers shared by every page. */

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Something went wrong — please try again', data?.details);
  return data;
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
/** paise → "₹1,299" */
export const money = (paise) => inr.format((paise || 0) / 100);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtDate = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => {
  if (!iso) return '';
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-IN', opts);
};
export const fmtDateTime = (iso) => fmtDate(iso, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const qs = (k) => new URLSearchParams(location.search).get(k);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Show server validation errors next to form fields (matched by input name). */
export function showFieldErrors(form, details) {
  $$('.field.has-error', form).forEach((f) => { f.classList.remove('has-error'); f.querySelector('.error')?.remove(); });
  if (!details || typeof details !== 'object') return;
  for (const [k, msg] of Object.entries(details)) {
    const input = form.querySelector(`[name="${k}"]`);
    const field = input?.closest('.field');
    if (!field) continue;
    field.classList.add('has-error');
    const e = document.createElement('span');
    e.className = 'error';
    e.textContent = msg;
    field.append(e);
  }
  form.querySelector('.has-error input, .has-error select')?.focus();
}
