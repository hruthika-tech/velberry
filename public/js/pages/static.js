import '../layout.js';
import { charmSVG } from '../charms.js';

document.querySelectorAll('[data-charm]').forEach((el) => { el.innerHTML = charmSVG(el.dataset.charm, { size: Number(el.dataset.size) || 96 }); });
