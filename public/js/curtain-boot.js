/*
 * Velberry — Today's Special, step 0 (runs in <head>, before the page is painted).
 * If this visitor should see the closed curtains, draw them immediately (CSS) so the homepage never flashes
 * underneath; /js/curtain.js then fills in the real curtains and the board.
 * Only a "seen" marker and a "no special right now" hint are stored — never anything personal.
 */
(function () {
  try {
    if (sessionStorage.getItem('vb-special-seen')) return;            // already opened in this browsing session
    if (localStorage.getItem('vb-special-hint') === 'off') return;    // last check: no special published
    var seen = JSON.parse(localStorage.getItem('vb-special-seen') || 'null');
    if (seen && seen.until > Date.now()) return;                      // "once a day / week" window still running
  } catch (e) { /* storage blocked (private mode etc.): show the curtains */ }
  document.documentElement.classList.add('vbc-pending');
}());
