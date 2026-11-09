/**
 * "Share this charm": the phone's own share sheet (WhatsApp, Instagram, Messages…) where the browser supports it,
 * otherwise copy the link; if even the clipboard is blocked, show the link in a small dialog to copy by hand.
 * The URL always comes from the server (built from the trusted APP_URL), never from location.host.
 */
import { esc } from './api.js';
import { toast } from './ui.js';

export const SHARE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`;

export async function shareCharm({ title, text, url }) {
  const data = { title, text, url };
  if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'; // they closed the share sheet — nothing to do
      // any other failure: fall back to copying
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: 'Link copied! 💌', text: 'Paste it into WhatsApp, Instagram or a message to share this charm.', icon: 'heart' });
    return 'copied';
  } catch {
    showLinkDialog(url);
    return 'manual';
  }
}

function showLinkDialog(url) {
  document.querySelector('.share-dialog')?.remove();
  const d = document.createElement('dialog');
  d.className = 'share-dialog';
  d.setAttribute('aria-labelledby', 'share-dialog-title');
  d.innerHTML = `<h2 id="share-dialog-title">Share this charm</h2>
    <p class="muted">Copy this link and paste it anywhere you like:</p>
    <input type="text" readonly value="${esc(url)}" aria-label="Link to this charm" data-share-link>
    <div class="share-dialog-actions"><button type="button" class="btn btn-sm" data-share-copy>Copy link</button>
      <button type="button" class="btn btn-ghost btn-sm" data-share-close>Close</button></div>`;
  document.body.append(d);
  const input = d.querySelector('[data-share-link]');
  d.querySelector('[data-share-close]').addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  d.querySelector('[data-share-copy]').addEventListener('click', (e) => {
    input.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* older browsers only */ }
    e.currentTarget.textContent = ok ? 'Copied ✓' : 'Press Ctrl+C / long-press to copy';
  });
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  input.focus();
  input.select();
}
