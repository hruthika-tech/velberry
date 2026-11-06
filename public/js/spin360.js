/**
 * "Take a Little Closer Look" — two genuine ways to inspect a charm from every side:
 *
 *  1. FrameSpinner: a 360° photo sequence (upload 12–72 angle shots per product in Admin → Products → "360° angle frames").
 *     Dragging scrubs through the real photos.
 *  2. ModelViewer: a real-time 3D model (three.js) with studio lighting, glossy clay glaze and gold hardware,
 *     used for the homepage showcase until photo sequences are uploaded.
 *
 * Both support mouse + touch drag with inertia, keyboard arrows, and preset viewing angles.
 */
import { reducedMotion } from './api.js';

/* ═════════════ shared drag-with-inertia controller ═════════════ */
function dragController(el, { onDelta, onStart, onEnd }) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let vx = 0;
  let raf = 0;
  el.style.touchAction = 'pan-y';
  el.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY; vx = 0;
    el.setPointerCapture(e.pointerId);
    cancelAnimationFrame(raf);
    el.classList.add('is-dragging');
    onStart?.();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    vx = dx;
    onDelta(dx, dy);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('is-dragging');
    const coast = () => {
      vx *= 0.92;
      if (Math.abs(vx) < 0.15) { onEnd?.(); return; }
      onDelta(vx, 0);
      raf = requestAnimationFrame(coast);
    };
    if (!reducedMotion()) raf = requestAnimationFrame(coast); else onEnd?.();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { onDelta(-24, 0); e.preventDefault(); }
    if (e.key === 'ArrowRight') { onDelta(24, 0); e.preventDefault(); }
  });
  return { isDragging: () => dragging };
}

/* ═════════════ 1. photo-sequence spinner ═════════════ */
export class FrameSpinner {
  constructor(host, frames, { alt = '' } = {}) {
    this.host = host;
    this.frames = frames;
    this.index = 0;
    this.acc = 0;
    host.innerHTML = `<div class="spin-frames" tabindex="0" role="img" aria-label="${alt} — 360° view, drag or use arrow keys to rotate">
      <img alt="" draggable="false" src="${frames[0]}"></div>`;
    this.box = host.firstElementChild;
    this.img = this.box.querySelector('img');
    // Preload all frames for smooth scrubbing
    this.ready = Promise.all(frames.map((src) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = src; })));
    const pxPerFrame = Math.max(4, 900 / frames.length / 2);
    dragController(this.box, {
      onDelta: (dx) => {
        this.acc += dx;
        while (Math.abs(this.acc) >= pxPerFrame) {
          this.show(this.index + (this.acc > 0 ? -1 : 1));
          this.acc -= Math.sign(this.acc) * pxPerFrame;
        }
      },
    });
  }
  show(i) {
    const n = this.frames.length;
    this.index = ((i % n) + n) % n;
    this.img.src = this.frames[this.index];
  }
  /** angle in degrees (0 = front) */
  goTo(deg) {
    const target = Math.round(((deg % 360) / 360) * this.frames.length);
    const step = () => {
      if (this.index === target % this.frames.length) return;
      this.show(this.index + 1);
      requestAnimationFrame(step);
    };
    if (reducedMotion()) this.show(target); else step();
  }
  destroy() { this.host.innerHTML = ''; }
}

/* ═════════════ 2. real-time 3D model ═════════════ */
export async function createModelViewer(host, { model = 'strawberry', onReady } = {}) {
  let THREE;
  try {
    THREE = await import('/vendor/three/three.module.js');
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'spin-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Interactive 3D strawberry keychain — drag or use arrow keys to rotate');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    return null; // no WebGL — caller shows the photo instead
  }
  host.append(canvas);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.2, 11.2);
  camera.lookAt(0, -0.05, 0);

  scene.environment = studioEnvironment(THREE, renderer);

  // lights: warm key, pink fill, cream rim
  scene.add(new THREE.HemisphereLight(0xfff6ea, 0xe6c0c9, 0.55));
  const key = new THREE.DirectionalLight(0xfff3e4, 2.2);
  key.position.set(3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -3; key.shadow.camera.right = 3; key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
  key.shadow.radius = 6;
  key.shadow.bias = -0.0008;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xf2b6c3, 0.7);
  fill.position.set(-4, 1.5, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-1.5, 3, -4);
  scene.add(rim);

  // soft contact shadow on an invisible floor
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.16 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.6;
  floor.receiveShadow = true;
  scene.add(floor);

  const pivot = new THREE.Group(); // swing pivot at the keyring
  pivot.position.y = 1.75;
  scene.add(pivot);
  const charm = buildStrawberryKeychain(THREE);
  charm.position.y = -2.95;
  pivot.add(charm);

  // interaction state
  let rotY = -0.5;
  let rotX = 0.05;
  let target = null;
  let idle = !reducedMotion();
  let idleTimer;
  const ctrl = dragController(canvas, {
    onStart: () => { idle = false; target = null; clearTimeout(idleTimer); },
    onDelta: (dx, dy) => {
      rotY += dx * 0.012;
      rotX = Math.max(-0.45, Math.min(0.55, rotX + dy * 0.006));
      requestRender();
    },
    onEnd: () => { clearTimeout(idleTimer); if (!reducedMotion()) idleTimer = setTimeout(() => { idle = true; requestRender(); }, 3500); },
  });

  const resize = () => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 36 : 30;
    camera.updateProjectionMatrix();
    requestRender();
  };
  new ResizeObserver(resize).observe(host);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) requestRender(); }).observe(host);

  let raf = 0;
  let t0 = performance.now();
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - t0) / 1000);
    t0 = now;
    if (target !== null) {
      const d = target - rotY;
      rotY += d * Math.min(1, dt * 6);
      rotX += (0.05 - rotX) * Math.min(1, dt * 6);
      if (Math.abs(d) < 0.002) { rotY = target; target = null; }
    } else if (idle) {
      rotY += dt * 0.45;
    }
    charm.rotation.y = rotY;
    pivot.rotation.x = rotX;
    // gentle pendulum sway, like a charm hanging from a bag
    pivot.rotation.z = reducedMotion() ? 0 : Math.sin(now / 900) * 0.035;
    renderer.render(scene, camera);
    if (visible && (idle || target !== null || ctrl.isDragging() || !reducedMotion())) requestRender();
  }
  function requestRender() { if (!raf) raf = requestAnimationFrame(frame); }
  resize();
  requestRender();
  onReady?.();

  return {
    /** Rotate to a preset angle (degrees around the vertical axis; tilt for top view). */
    goTo(deg, tilt = 0.05) {
      idle = false;
      clearTimeout(idleTimer);
      const twoPi = Math.PI * 2;
      const want = (deg * Math.PI) / 180;
      const base = Math.round((rotY - want) / twoPi) * twoPi;
      target = base + want;
      rotX = tilt;
      if (reducedMotion()) { rotY = target; target = null; }
      requestRender();
      idleTimer = setTimeout(() => { idle = !reducedMotion(); requestRender(); }, 6000);
    },
  };
}

/** Small procedural "photo studio" so metal and glaze get believable reflections. */
function studioEnvironment(THREE, renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0xf6ece4);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const panel = (color, intensity, pos, scale) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }));
    m.position.set(...pos);
    m.scale.set(...scale);
    env.add(m);
  };
  panel(0xffffff, 6, [0, 6, 0], [8, 0.2, 8]); // softbox overhead
  panel(0xffe9ef, 3, [-6, 1, 1], [0.2, 6, 5]); // pink side light
  panel(0xfff6e6, 4, [6, 2, 2], [0.2, 4, 4]); // warm side light
  panel(0xe6c0c9, 1.2, [0, -4, 0], [10, 0.2, 10]); // floor bounce
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return tex;
}

/** A glazed polymer-clay strawberry on a gold chain & keyring — modelled to match the shop's charm art. */
function buildStrawberryKeychain(THREE) {
  const g = new THREE.Group();
  const clay = new THREE.MeshPhysicalMaterial({ color: 0xc8344d, roughness: 0.55, clearcoat: 1, clearcoatRoughness: 0.1, sheen: 0.25, sheenColor: new THREE.Color(0xffc2cc) });
  const seedMat = new THREE.MeshPhysicalMaterial({ color: 0xfbe7b8, roughness: 0.35, clearcoat: 0.8 });
  const leafMat = new THREE.MeshPhysicalMaterial({ color: 0x8fae4e, roughness: 0.55, clearcoat: 0.7, side: THREE.DoubleSide });
  const gold = new THREE.MeshStandardMaterial({ color: 0xe0b872, metalness: 1, roughness: 0.22 });

  // berry body (lathe) — a soft heart-shaped strawberry profile
  const prof = [[0, -1.22], [0.18, -1.15], [0.42, -0.92], [0.66, -0.55], [0.84, -0.12], [0.93, 0.26], [0.9, 0.56], [0.76, 0.8], [0.5, 0.95], [0.22, 1.0], [0, 1.0]];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y));
  const curve = new THREE.SplineCurve(pts);
  const body = new THREE.Mesh(new THREE.LatheGeometry(curve.getPoints(48), 96), clay);
  body.scale.set(1, 1, 0.82); // slightly flattened like a real handmade charm
  body.castShadow = true;
  g.add(body);

  // seeds placed on the surface along a golden-angle spiral, oriented to the surface normal
  const seedGeo = new THREE.SphereGeometry(0.045, 12, 8);
  seedGeo.scale(1, 1.7, 0.6);
  const radiusAt = (y) => {
    for (let i = 0; i < prof.length - 1; i++) {
      const [r1, y1] = prof[i]; const [r2, y2] = prof[i + 1];
      if (y >= y1 && y <= y2) return r1 + ((y - y1) / (y2 - y1)) * (r2 - r1);
    }
    return 0;
  };
  const N = 70;
  for (let i = 0; i < N; i++) {
    const y = -0.98 + (i / N) * 1.72;
    const a = i * 2.39996;
    const r = radiusAt(y) * 0.985;
    const s = new THREE.Mesh(seedGeo, seedMat);
    s.position.set(Math.cos(a) * r, y, Math.sin(a) * r * 0.82);
    s.lookAt(Math.cos(a) * r * 3, y + 0.25, Math.sin(a) * r * 0.82 * 3);
    s.rotateX(Math.PI / 2);
    g.add(s);
  }

  // calyx leaves
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, 0);
  leafShape.quadraticCurveTo(0.17, 0.2, 0, 0.58);
  leafShape.quadraticCurveTo(-0.17, 0.2, 0, 0);
  const leafGeo = new THREE.ExtrudeGeometry(leafShape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    const a = (i / 7) * Math.PI * 2;
    leaf.position.set(0, 0.97, 0);
    leaf.rotation.set(0, -a, 0);
    leaf.rotateX(Math.PI / 2 - 0.28);
    leaf.castShadow = true;
    g.add(leaf);
  }
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.26, 12), leafMat);
  stem.position.y = 1.1;
  g.add(stem);

  // hardware: eye pin, jump ring, chain, keyring
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.022, 12, 32), gold);
  eye.position.y = 1.3;
  g.add(eye);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.026, 12, 36), gold);
  ring.position.y = 1.46;
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  const linkGeo = new THREE.TorusGeometry(0.075, 0.02, 10, 28);
  linkGeo.scale(1, 1.55, 1);
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(linkGeo, gold);
    l.position.y = 1.66 + i * 0.17;
    l.rotation.y = i % 2 ? Math.PI / 2 : 0;
    l.castShadow = true;
    g.add(l);
  }
  const keyring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.045, 16, 80), gold);
  keyring.position.y = 2.95;
  keyring.castShadow = true;
  g.add(keyring);
  // split-ring second coil
  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.045, 16, 80, Math.PI * 1.6), gold);
  coil.position.set(0, 2.95, 0.07);
  g.add(coil);

  return g;
}
