'use strict';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Nav background + scroll progress bar.
const nav = document.getElementById('nav');
const progress = document.getElementById('scrollProgress');
const onScroll = () => {
  nav.classList.toggle('scrolled', window.scrollY > 24);
  const max = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
};
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll, { passive: true });
onScroll();

// Mobile nav.
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
navToggle.addEventListener('click', () => {
  const open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
});
navLinks.addEventListener('click', (ev) => {
  if (ev.target.closest('a')) {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && navLinks.classList.contains('open')) {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.focus();
  }
});

// Scroll-reveal: fade/slide elements in as they enter the viewport.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add('in-view');
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.12, rootMargin: '0px 0px -40px' });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

// Feature cards: spotlight follows the cursor.
if (!reduceMotion) {
  document.querySelectorAll('.feature').forEach((card) => {
    card.addEventListener('mousemove', (ev) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${ev.clientX - r.left}px`);
      card.style.setProperty('--my', `${ev.clientY - r.top}px`);
    });
  });
}

// Hero 3D stage: parallax the whole scene toward the cursor.
const stageInner = document.getElementById('stageInner');
const stage = document.getElementById('heroStage');
if (stage && stageInner && !reduceMotion) {
  let raf = null;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  stage.addEventListener('mousemove', (ev) => {
    const r = stage.getBoundingClientRect();
    tx = ((ev.clientX - r.left) / r.width - 0.5) * 2;   // -1..1
    ty = ((ev.clientY - r.top) / r.height - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(tick);
  });
  stage.addEventListener('mouseleave', () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(tick); });
  function tick() {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    stageInner.style.transform = `rotateY(${cx * 10}deg) rotateX(${-cy * 8}deg)`;
    // Per-panel depth parallax.
    stageInner.querySelectorAll('[data-depth]').forEach((el) => {
      const d = Number(el.dataset.depth) || 0;
      el.style.marginLeft = `${cx * d * 0.12}px`;
      el.style.marginTop = `${cy * d * 0.12}px`;
    });
    if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) raf = requestAnimationFrame(tick);
    else raf = null;
  }
}

// Showcase panels: tilt toward the cursor on hover.
if (!reduceMotion) {
  document.querySelectorAll('[data-tilt]').forEach((panel) => {
    let raf = null, rx = 0, ry = 0, trx = 0, tryy = 0;
    panel.addEventListener('mousemove', (ev) => {
      const r = panel.getBoundingClientRect();
      tryy = ((ev.clientX - r.left) / r.width - 0.5) * 16;   // rotateY
      trx = -((ev.clientY - r.top) / r.height - 0.5) * 12;   // rotateX
      if (!raf) raf = requestAnimationFrame(spin);
    });
    panel.addEventListener('mouseleave', () => { trx = 0; tryy = 0; if (!raf) raf = requestAnimationFrame(spin); });
    function spin() {
      rx += (trx - rx) * 0.12;
      ry += (tryy - ry) * 0.12;
      panel.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      if (Math.abs(trx - rx) > 0.01 || Math.abs(tryy - ry) > 0.01) raf = requestAnimationFrame(spin);
      else raf = null;
    }
  });
}

// Pause hero/showcase videos while they're off screen.
const videoIo = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) v.play().catch(() => {});
    else v.pause();
  }
}, { threshold: 0.05 });
document.querySelectorAll('video').forEach((v) => videoIo.observe(v));

// Point the primary download button at the visitor's platform and flag the
// matching card. Every option stays listed, so a wrong guess costs nothing.
const RELEASE_BASE = 'https://github.com/voxelocity/Zen-Host/releases/latest/download/';
const VERSION = '0.1.0';

const PRIMARY = {
  win: {
    x64:   { file: `Zen.Host-${VERSION}-win-x64.exe`,   label: 'Download for Windows', meta: '64-bit installer · Windows 10/11' },
    arm64: { file: `Zen.Host-${VERSION}-win-arm64.exe`, label: 'Download for Windows', meta: 'ARM64 installer · Windows 10/11' },
  },
  mac: {
    arm64: { file: `Zen.Host-${VERSION}-mac-arm64.dmg`, label: 'Download for macOS', meta: 'Apple Silicon · macOS 11+' },
    x64:   { file: `Zen.Host-${VERSION}-mac-x64.dmg`,   label: 'Download for macOS', meta: 'Intel · macOS 11+' },
  },
  linux: {
    x64:   { file: `Zen.Host-${VERSION}-linux-x86_64.AppImage`, label: 'Download for Linux', meta: 'AppImage · x86_64' },
    arm64: { file: `Zen.Host-${VERSION}-linux-arm64.AppImage`,  label: 'Download for Linux', meta: 'AppImage · ARM64' },
  },
};

async function detectPlatform() {
  const ua = navigator.userAgent || '';
  let os = null;
  if (/Windows|Win32|Win64/i.test(ua)) os = 'win';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'mac';
  else if (/Linux|X11|CrOS/i.test(ua) && !/Android/i.test(ua)) os = 'linux';

  // Default macs to Apple Silicon — Safari never reports architecture, and most
  // Macs in use are now ARM. Intel remains one click away in the card.
  let arch = os === 'mac' ? 'arm64' : 'x64';

  const uaData = navigator.userAgentData;
  if (uaData && typeof uaData.getHighEntropyValues === 'function') {
    try {
      const hev = await uaData.getHighEntropyValues(['architecture', 'platform']);
      const p = (hev.platform || '').toLowerCase();
      if (p.includes('windows')) os = 'win';
      else if (p.includes('mac')) os = 'mac';
      else if (p.includes('linux') || p.includes('chrome os')) os = 'linux';
      if (hev.architecture === 'arm') arch = 'arm64';
      else if (hev.architecture === 'x86') arch = 'x64';
    } catch { /* high-entropy values are best-effort */ }
  }
  return { os, arch };
}

detectPlatform().then(({ os, arch }) => {
  if (!os || !PRIMARY[os]) return;   // unknown platform keeps the neutral CTA
  const pick = PRIMARY[os][arch] || PRIMARY[os].x64;
  const btn = document.getElementById('dlPrimaryBtn');
  const title = document.getElementById('dlPrimaryTitle');
  const meta = document.getElementById('dlPrimaryMeta');
  if (btn) {
    btn.href = RELEASE_BASE + encodeURIComponent(pick.file);
    btn.textContent = `↓ ${pick.label}`;
  }
  if (title) title.textContent = pick.label;
  if (meta) meta.textContent = pick.meta;

  const card = document.querySelector(`.dl-card[data-os="${os}"]`);
  if (card) card.classList.add('is-detected');
});

const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
