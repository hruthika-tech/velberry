/**
 * Generates placeholder "product photos" for the starter catalogue from the shared charm art:
 *   public/uploads/seed/<slug>-1.svg  (full keychain on its backdrop)
 *   public/uploads/seed/<slug>-2.svg  (close-up detail)
 * plus PNG twins (for emails — mail clients don't render SVG) when Chrome/Edge is available.
 * Replace these with your real photographs in Admin → Products.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../server/config.js';
import { CHARMS, PALETTE as P } from '../public/js/charms.js';
import { PRODUCTS } from '../server/db/seed-data.js';

const OUT = path.join(ROOT, 'public', 'uploads', 'seed');
fs.mkdirSync(OUT, { recursive: true });

const defs = (bg) => `
<defs>
  <pattern id="linen" width="6" height="6" patternUnits="userSpaceOnUse">
    <path d="M0 3h6M3 0v6" stroke="#fff" stroke-width=".7" opacity=".45"/>
  </pattern>
  <radialGradient id="spot" cx="50%" cy="45%" r="65%"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="${bg}" stop-opacity="0"/></radialGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6E3B4"/><stop offset=".45" stop-color="#D8B26E"/><stop offset="1" stop-color="#A9823F"/></linearGradient>
  <filter id="clay" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" result="blur"/>
    <feSpecularLighting in="blur" surfaceScale="3.2" specularConstant=".42" specularExponent="22" lighting-color="#fff" result="spec">
      <feDistantLight azimuth="235" elevation="52"/>
    </feSpecularLighting>
    <feComposite in="spec" in2="SourceAlpha" operator="in" result="specIn"/>
    <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="4" result="noise"/>
    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 .42  0 0 0 0 .27  0 0 0 0 .27  0 0 0 .07 0" result="speck"/>
    <feComposite in="speck" in2="SourceAlpha" operator="in" result="speckIn"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="speckIn"/><feMergeNode in="specIn"/></feMerge>
  </filter>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#6B4545" flood-opacity=".22"/>
  </filter>
</defs>`;

function chainLinks(x, y1, y2) {
  let s = '';
  let y = y1;
  let i = 0;
  while (y < y2 - 6) {
    const vertical = i % 2 === 0;
    s += vertical
      ? `<ellipse cx="${x}" cy="${y + 13}" rx="8" ry="15" fill="none" stroke="url(#gold)" stroke-width="5.5"/>`
      : `<ellipse cx="${x}" cy="${y + 13}" rx="3" ry="15" fill="none" stroke="url(#gold)" stroke-width="5.5"/>`;
    y += 22;
    i++;
  }
  return s;
}

function fullShot({ art, bg }) {
  const c = CHARMS[art];
  const scale = 6.2;
  const ox = 500 - 50 * scale;
  const oy = 330;
  const hookY = oy + c.hook * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">${defs(bg)}
  <rect width="1000" height="1000" fill="${bg}"/><rect width="1000" height="1000" fill="url(#linen)"/><rect width="1000" height="1000" fill="url(#spot)"/>
  <ellipse cx="500" cy="955" rx="230" ry="18" fill="#6B4545" opacity=".08"/>
  <g filter="url(#shadow)">
    <circle cx="500" cy="150" r="92" fill="none" stroke="url(#gold)" stroke-width="15"/>
    <path d="M430 92 A92 92 0 0 1 560 80" fill="none" stroke="#fff" stroke-width="4" opacity=".7" stroke-linecap="round"/>
    ${chainLinks(500, 236, hookY - 14)}
    <circle cx="500" cy="${hookY - 6}" r="14" fill="none" stroke="url(#gold)" stroke-width="5.5"/>
    <g transform="translate(${ox} ${oy}) scale(${scale})" filter="url(#clay)">${c.svg}</g>
  </g>
</svg>`;
}

function closeUp({ art, bg }) {
  const c = CHARMS[art];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">${defs(P.cream)}
  <rect width="1000" height="1000" fill="${P.cream}"/>
  <g opacity=".55">${Array.from({ length: 21 }, (_, i) => `<rect x="${i * 50}" y="0" width="25" height="1000" fill="${bg}"/><rect x="0" y="${i * 50}" width="1000" height="25" fill="${bg}" opacity=".7"/>`).join('')}</g>
  <rect width="1000" height="1000" fill="url(#spot)"/>
  <g filter="url(#shadow)"><g transform="translate(40 30) scale(9.2)" filter="url(#clay)">${c.svg}</g></g>
</svg>`;
}

function findBrowser() {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return c.find((p) => fs.existsSync(p));
}

const browser = findBrowser();
const only = process.argv[2];
for (const p of PRODUCTS.filter((x) => !only || x.slug === only)) {
  for (const [n, svg] of [[1, fullShot(p)], [2, closeUp(p)]]) {
    const file = path.join(OUT, `${p.slug}-${n}.svg`);
    fs.writeFileSync(file, svg);
    if (browser) {
      // PNG twin at 600px for email clients
      const html = path.join(OUT, `_tmp.html`);
      fs.writeFileSync(html, `<html><body style="margin:0"><img src="${pathToFileURL(file)}" width="600" height="600"></body></html>`);
      try {
        execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--screenshot=${file.replace(/\.svg$/, '.png')}`, '--window-size=600,600', pathToFileURL(html).href], { stdio: 'ignore', timeout: 30000 });
      } catch (e) { console.warn('PNG render failed for', file, e.message); }
      fs.rmSync(html, { force: true });
    }
  }
  console.log('✿', p.slug);
}
if (!browser) console.warn('No Chrome/Edge found — PNG email images skipped (SVGs still generated).');
