/**
 * CLAYSLAY charm illustrations — hand-tuned kawaii SVG, 100×100 viewBox.
 * `hook` is the y coordinate where a jump ring attaches. Shared by the decorative chains,
 * menu icons and the seed product artwork (scripts/generate-art.js), so everything matches.
 * Pure strings, no DOM — safe to import in Node too.
 */
export const PALETTE = {
  guava: '#C96C80', kobi: '#D197A2', ballerina: '#E6C0C9', titanium: '#D5D4CD', matcha: '#BCCA7D',
  cream: '#FFF6E9', vanilla: '#FBEBC8', cocoa: '#6B4545', berry: '#D9546A', leaf: '#9AB25A', gold: '#D8B26E', butter: '#F3CF7A',
};
const P = PALETTE;
const O = `stroke="${P.cocoa}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"`;
const thin = (w) => `stroke="${P.cocoa}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const shine = (d, w = 3.5) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" opacity=".75"/>`;
const face = (x, y, s = 1) => `
  <g transform="translate(${x} ${y}) scale(${s})">
    <circle cx="-7" cy="0" r="1.9" fill="${P.cocoa}"/><circle cx="7" cy="0" r="1.9" fill="${P.cocoa}"/>
    <path d="M-2.6 2.4 Q0 5 2.6 2.4" fill="none" stroke="${P.cocoa}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="-11" cy="4" rx="3.2" ry="1.9" fill="#F28AA0" opacity=".55"/><ellipse cx="11" cy="4" rx="3.2" ry="1.9" fill="#F28AA0" opacity=".55"/>
  </g>`;
const mirror = (s) => `${s}<g transform="translate(100 0) scale(-1 1)">${s}</g>`;

function starPath(cx, cy, R, r, n = 5) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI / n) * i - Math.PI / 2;
    const rad = i % 2 ? r : R;
    d += `${i ? 'L' : 'M'}${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)} `;
  }
  return d + 'Z';
}

export const CHARMS = {
  strawberry: { hook: 13, svg: `
    <path d="M50 30 C72 25 87 40 80 60 C74 80 58 92 50 94 C42 92 26 80 20 60 C13 40 28 25 50 30Z" fill="${P.berry}" ${O}/>
    ${[[36, 46], [50, 42], [64, 46], [30, 60], [44, 58], [58, 58], [70, 61], [38, 72], [52, 72], [64, 73], [46, 84], [56, 84]]
      .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.6" ry="2.6" fill="${P.vanilla}"/>`).join('')}
    <path d="M50 24 L51 12" ${O} fill="none"/>
    <path d="M50 36 C40 36 27 33 22 26 C32 23 39 27 43 29 C39 23 40 17 44 13 C48 19 50 25 50 27 C50 25 52 19 56 13 C60 17 61 23 57 29 C61 27 68 23 78 26 C73 33 60 36 50 36Z" fill="${P.leaf}" ${O}/>
    ${shine('M30 46 Q33 38 41 36')}` },

  cherries: { hook: 14, svg: `
    <path d="M36 66 Q40 36 56 16 M64 64 Q62 38 56 16" fill="none" ${O}/>
    <path d="M56 16 C66 10 78 14 82 22 C72 26 62 24 56 16Z" fill="${P.leaf}" ${O}/>
    <circle cx="35" cy="72" r="16" fill="${P.berry}" ${O}/><circle cx="65" cy="70" r="16" fill="${P.guava}" ${O}/>
    ${shine('M26 66 Q28 60 34 59', 3)}${shine('M56 64 Q58 58 64 57', 3)}` },

  daisy: { hook: 16, svg: `
    ${Array.from({ length: 8 }, (_, i) => `<ellipse cx="50" cy="35" rx="9.5" ry="17" transform="rotate(${i * 45} 50 56)" fill="${P.cream}" ${O}/>`).join('')}
    <circle cx="50" cy="56" r="13" fill="${P.butter}" ${O}/>${face(50, 55, 0.62)}` },

  tulip: { hook: 14, svg: `
    <path d="M50 58 L50 92" ${O} fill="none"/>
    <path d="M50 84 C36 84 28 72 30 62 C40 64 48 72 50 84Z" fill="${P.leaf}" ${O}/>
    <path d="M50 78 C62 78 70 68 70 58 C60 60 52 68 50 78Z" fill="${P.matcha}" ${O}/>
    <path d="M30 26 L40 34 L50 20 L60 34 L70 26 C74 46 66 60 50 60 C34 60 26 46 30 26Z" fill="${P.kobi}" ${O}/>
    ${shine('M36 38 Q36 48 42 53', 3)}` },

  bow: { hook: 40, svg: mirror(`
    <path d="M47 58 L34 90 L42 86 L47 93 L51 61Z" fill="${P.guava}" ${O}/>
    <path d="M50 52 C34 28 10 30 12 50 C14 70 36 68 50 56Z" fill="${P.kobi}" ${O}/>
    <path d="M44 52 C34 42 24 42 22 48" fill="none" stroke="${P.cocoa}" stroke-width="1.6" stroke-linecap="round" opacity=".6"/>`) + `
    <rect x="42" y="45" width="16" height="16" rx="6" fill="${P.guava}" ${O}/>
    ${shine('M18 46 Q20 40 26 38', 3)}` },

  butterfly: { hook: 26, svg: mirror(`
    <path d="M50 50 C30 18 4 24 12 48 C16 60 38 58 50 52Z" fill="${P.ballerina}" ${O}/>
    <path d="M50 56 C34 60 18 80 32 86 C44 90 50 72 50 60Z" fill="${P.kobi}" ${O}/>
    <circle cx="26" cy="42" r="4" fill="${P.guava}"/><circle cx="34" cy="74" r="3" fill="${P.cream}"/>`) + `
    <rect x="45" y="36" width="10" height="44" rx="5" fill="${P.cocoa}"/>
    <path d="M48 37 Q42 26 38 24 M52 37 Q58 26 62 24" fill="none" stroke="${P.cocoa}" stroke-width="2" stroke-linecap="round"/>` },

  heart: { hook: 28, svg: `
    <path d="M50 88 C18 66 10 46 22 33 C32 22 45 26 50 37 C55 26 68 22 78 33 C90 46 82 66 50 88Z" fill="${P.guava}" ${O}/>
    ${face(50, 54, 0.85)}${shine('M26 42 Q27 34 35 32')}` },

  star: { hook: 12, svg: `<path d="${starPath(50, 56, 42, 19)}" fill="${P.butter}" ${O}/>${face(50, 58, 0.7)}${shine('M37 44 L44 38', 3)}` },

  macaron: { hook: 30, svg: `
    <rect x="18" y="58" width="64" height="24" rx="12" fill="${P.kobi}" ${O}/>
    <path d="M22 59 Q26 54 30 59 Q34 54 38 59 Q42 54 46 59 Q50 54 54 59 Q58 54 62 59 Q66 54 70 59 Q74 54 78 59" fill="${P.cream}" ${O}/>
    <rect x="18" y="32" width="64" height="24" rx="12" fill="${P.kobi}" ${O}/>
    <path d="M22 56 Q26 61 30 56 Q34 61 38 56 Q42 61 46 56 Q50 61 54 56 Q58 61 62 56 Q66 61 70 56 Q74 61 78 56" fill="${P.ballerina}" stroke="${P.cocoa}" stroke-width="1.6"/>
    ${face(50, 44, 0.65)}${shine('M26 40 Q28 36 34 35', 3)}` },

  cupcake: { hook: 16, svg: `
    <path d="M28 60 L72 60 L66 91 L34 91Z" fill="${P.kobi}" ${O}/>
    ${[38, 46, 54, 62].map((x) => `<path d="M${x} 61 L${x - 1.5} 90" stroke="${P.cocoa}" stroke-width="1.5" opacity=".5"/>`).join('')}
    <path d="M24 62 C16 52 28 42 35 45 C35 33 53 28 58 39 C66 32 82 40 74 52 C83 56 78 66 70 62 Z" fill="${P.cream}" ${O}/>
    <path d="M32 52 Q44 56 54 50 Q62 46 70 52" fill="none" stroke="${P.ballerina}" stroke-width="3" stroke-linecap="round"/>
    <path d="M52 22 Q54 14 60 12" fill="none" ${O}/><circle cx="51" cy="28" r="7" fill="${P.berry}" ${O}/>
    ${face(50, 74, 0.55)}` },

  cake: { hook: 18, svg: `
    <path d="M14 54 L84 44 L84 84 L14 90Z" fill="${P.vanilla}" ${O}/>
    <path d="M14 66 L84 58 M14 77 L84 71" stroke="${P.kobi}" stroke-width="5"/>
    <path d="M14 54 L48 34 L84 44Z" fill="${P.ballerina}" ${O}/>
    <path d="M14 54 Q18 60 22 54 Q26 60 30 53 Q34 59 38 52 Q42 58 46 51" fill="none" stroke="${P.cocoa}" stroke-width="1.6" opacity=".5"/>
    <path d="M50 34 C58 32 62 22 56 18 C50 16 44 22 46 28Z" fill="${P.berry}" ${O}/>
    <path d="M50 18 L46 13 L54 15Z" fill="${P.leaf}" ${O}/>` },

  shell: { hook: 22, svg: `
    <path d="M50 88 L16 50 Q50 6 84 50Z" fill="${P.ballerina}" ${O}/>
    ${[22, 34, 50, 66, 78].map((x, i) => `<path d="M50 86 L${x} ${[44, 30, 24, 30, 44][i]}" stroke="${P.guava}" stroke-width="2" stroke-linecap="round" opacity=".55"/>`).join('')}
    <path d="M42 84 L36 92 L64 92 L58 84" fill="${P.kobi}" ${O}/>
    <circle cx="50" cy="66" r="7" fill="#FFFDF8" ${O}/>${shine('M47 63 L49 62', 2)}` },

  bunny: { hook: 8, svg: `
    <ellipse cx="38" cy="30" rx="8" ry="20" fill="${P.cream}" ${O}/><ellipse cx="62" cy="30" rx="8" ry="20" fill="${P.cream}" ${O}/>
    <ellipse cx="38" cy="32" rx="3.5" ry="13" fill="${P.ballerina}"/><ellipse cx="62" cy="32" rx="3.5" ry="13" fill="${P.ballerina}"/>
    <ellipse cx="50" cy="66" rx="30" ry="25" fill="${P.cream}" ${O}/>${face(50, 66, 1)}
    <path d="M44 46 Q50 40 56 46" fill="${P.guava}" ${O}/>` },

  bear: { hook: 30, svg: `
    <circle cx="27" cy="40" r="11" fill="${P.ballerina}" ${O}/><circle cx="73" cy="40" r="11" fill="${P.ballerina}" ${O}/>
    <circle cx="27" cy="40" r="5" fill="${P.kobi}"/><circle cx="73" cy="40" r="5" fill="${P.kobi}"/>
    <circle cx="50" cy="62" r="29" fill="${P.ballerina}" ${O}/>
    <ellipse cx="50" cy="70" rx="12" ry="9" fill="${P.cream}" ${O}/>
    <circle cx="40" cy="58" r="2.2" fill="${P.cocoa}"/><circle cx="60" cy="58" r="2.2" fill="${P.cocoa}"/>
    <ellipse cx="50" cy="66" rx="3.5" ry="2.5" fill="${P.cocoa}"/>
    <path d="M47 71 Q50 74 53 71" fill="none" stroke="${P.cocoa}" stroke-width="1.6" stroke-linecap="round"/>
    <ellipse cx="32" cy="68" rx="4" ry="2.4" fill="#F28AA0" opacity=".55"/><ellipse cx="68" cy="68" rx="4" ry="2.4" fill="#F28AA0" opacity=".55"/>` },

  teacup: { hook: 30, svg: `
    <ellipse cx="50" cy="85" rx="36" ry="8" fill="${P.titanium}" ${O}/>
    <path d="M74 50 C88 48 88 70 72 70" fill="none" stroke="${P.cocoa}" stroke-width="7" stroke-linecap="round"/>
    <path d="M74 50 C88 48 88 70 72 70" fill="none" stroke="${P.cream}" stroke-width="3" stroke-linecap="round"/>
    <path d="M22 44 L78 44 C78 70 66 82 50 82 C34 82 22 70 22 44Z" fill="${P.cream}" ${O}/>
    <path d="M50 70 C38 62 40 54 46 55 C48 55 50 58 50 58 C50 58 52 55 54 55 C60 54 62 62 50 70Z" fill="${P.guava}"/>
    <ellipse cx="50" cy="44" rx="28" ry="5" fill="${P.matcha}" ${O}/>
    <path d="M40 34 Q36 28 40 22 M52 34 Q48 28 52 22" fill="none" stroke="${P.kobi}" stroke-width="2.4" stroke-linecap="round"/>` },

  croissant: { hook: 34, svg: `
    <path d="M10 66 C10 56 18 50 24 52 L30 70 C22 76 12 74 10 66Z" fill="${P.butter}" ${O}/>
    <path d="M90 66 C90 56 82 50 76 52 L70 70 C78 76 88 74 90 66Z" fill="${P.butter}" ${O}/>
    <path d="M22 50 C26 40 36 38 40 40 L42 72 C34 76 28 74 26 70Z" fill="#EBBE6E" ${O}/>
    <path d="M78 50 C74 40 64 38 60 40 L58 72 C66 76 72 74 74 70Z" fill="#EBBE6E" ${O}/>
    <path d="M38 40 C42 32 58 32 62 40 L60 74 C54 78 46 78 40 74Z" fill="#E2A957" ${O}/>
    ${face(50, 56, 0.55)}${shine('M44 40 Q48 37 54 38', 2.6)}` },

  mushroom: { hook: 20, svg: `
    <rect x="37" y="52" width="26" height="36" rx="11" fill="${P.cream}" ${O}/>
    <path d="M12 56 C12 24 88 24 88 56 C88 62 12 62 12 56Z" fill="${P.guava}" ${O}/>
    <circle cx="32" cy="42" r="6" fill="${P.cream}"/><circle cx="56" cy="34" r="5" fill="${P.cream}"/><circle cx="72" cy="48" r="4" fill="${P.cream}"/>
    ${face(50, 70, 0.55)}` },

  key: { hook: 10, svg: `
    <circle cx="50" cy="30" r="15" fill="none" stroke="${P.gold}" stroke-width="7"/>
    <circle cx="50" cy="30" r="15" fill="none" ${thin(1.5)} opacity=".5"/>
    <rect x="46.5" y="44" width="7" height="44" rx="3" fill="${P.gold}" ${thin(1.5)}/>
    <rect x="53" y="70" width="12" height="6" rx="2" fill="${P.gold}" ${thin(1.5)}/>
    <rect x="53" y="80" width="9" height="6" rx="2" fill="${P.gold}" ${thin(1.5)}/>
    <path d="M44 30 C44 24 50 22 52 26 C54 22 60 24 58 30 C56 36 50 38 50 38 C50 38 44 36 44 30Z" fill="${P.guava}" transform="translate(-1 -2)"/>` },

  pearl: { hook: 38, svg: `<circle cx="50" cy="52" r="14" fill="#FFFBF4" ${thin(2)}/><circle cx="45" cy="47" r="4" fill="#fff"/><circle cx="54" cy="58" r="6" fill="${P.ballerina}" opacity=".35"/>` },
};

/** Inline SVG markup for a charm. */
export function charmSVG(name, { size = 48, title = '', cls = '' } = {}) {
  const c = CHARMS[name] || CHARMS.heart;
  return `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" ${title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"'} focusable="false">${c.svg}</svg>`;
}

export const CHARM_NAMES = Object.keys(CHARMS);
