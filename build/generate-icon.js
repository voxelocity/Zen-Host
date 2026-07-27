'use strict';
// Builds the Zen Host app icon (build/icon.ico + icon.png) from the real logo image
// (build/zenlogo.png) composited onto a dark rounded tile. No external dependencies.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const M = 512;

// ---- decode a non-interlaced 8-bit RGBA PNG ------------------------------
function decodePNG(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const colorType = buf[25];
  if (buf[24] !== 8 || (colorType !== 6 && colorType !== 2) || buf[28] !== 0) {
    throw new Error('Unsupported PNG (need 8-bit RGB/RGBA, non-interlaced)');
  }
  const channels = colorType === 6 ? 4 : 3;
  let p = 33; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.slice(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const buf2 = Buffer.alloc(w * h * channels);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++], row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[pos++];
      const a = i >= channels ? buf2[row + i - channels] : 0;
      const b = y > 0 ? buf2[row - stride + i] : 0;
      const c = (i >= channels && y > 0) ? buf2[row - stride + i - channels] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      buf2[row + i] = v & 255;
    }
  }
  // normalise to RGBA
  if (channels === 4) return { w, h, data: buf2 };
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < buf2.length; i += 3, j += 4) { rgba[j] = buf2[i]; rgba[j + 1] = buf2[i + 1]; rgba[j + 2] = buf2[i + 2]; rgba[j + 3] = 255; }
  return { w, h, data: rgba };
}

// ---- bilinear scale RGBA -------------------------------------------------
function scaleRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = (y / dh) * sh; const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = (x / dw) * sw; const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let k = 0; k < 4; k++) {
        const p00 = src[(y0 * sw + x0) * 4 + k], p10 = src[(y0 * sw + x1) * 4 + k];
        const p01 = src[(y1 * sw + x0) * 4 + k], p11 = src[(y1 * sw + x1) * 4 + k];
        out[o + k] = ((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy) | 0;
      }
    }
  }
  return out;
}

function render() {
  const buf = Buffer.alloc(M * M * 4);
  const radius = 104, inset = 8;
  // dark rounded tile + emerald glow
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    let bgAlpha = 1;
    const cx = Math.min(x - inset, (M - inset) - x), cy = Math.min(y - inset, (M - inset) - y);
    if (cx < radius && cy < radius) { const dx = radius - cx, dy = radius - cy; if (dx > 0 && dy > 0) { const d = Math.sqrt(dx * dx + dy * dy); bgAlpha = d > radius ? Math.max(0, 1 - (d - radius)) : 1; } }
    if (x < inset || y < inset || x > M - inset || y > M - inset) bgAlpha = 0;
    const o = (y * M + x) * 4;
    if (bgAlpha > 0) {
      let R = 22 + (10 - 22) * (y / M), G = 32 + (14 - 32) * (y / M), B = 58 + (22 - 58) * (y / M);
      const gx = x - 256, gy = y - 256, gd = Math.sqrt(gx * gx + gy * gy), glow = Math.max(0, 1 - gd / 250) ** 2;
      R = Math.min(255, R + 46 * glow); G = Math.min(255, G + 230 * glow * 0.55); B = Math.min(255, B + 176 * glow * 0.4);
      buf[o] = R | 0; buf[o + 1] = G | 0; buf[o + 2] = B | 0; buf[o + 3] = 255 * bgAlpha;
    }
  }
  // composite the real logo, scaled to fit and centred
  const logo = decodePNG(fs.readFileSync(path.join(__dirname, 'zenlogo.png')));
  const dw = 408, dh = Math.round(dw * logo.h / logo.w);
  const scaled = scaleRGBA(logo.data, logo.w, logo.h, dw, dh);
  const ox = (M - dw) >> 1, oy = (M - dh) >> 1;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const si = (y * dw + x) * 4, la = scaled[si + 3] / 255;
    if (la <= 0) continue;
    const o = ((oy + y) * M + (ox + x)) * 4;
    buf[o] = scaled[si] * la + buf[o] * (1 - la);
    buf[o + 1] = scaled[si + 1] * la + buf[o + 1] * (1 - la);
    buf[o + 2] = scaled[si + 2] * la + buf[o + 2] * (1 - la);
    buf[o + 3] = Math.max(buf[o + 3], scaled[si + 3]);
  }
  return buf;
}

function downscale(src, S) {
  const out = Buffer.alloc(S * S * 4), scale = M / S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.floor(y * scale); sy < (y + 1) * scale; sy++) for (let sx = Math.floor(x * scale); sx < (x + 1) * scale; sx++) {
      const o = (sy * M + sx) * 4, al = src[o + 3]; r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; n++;
    }
    const o = (y * S + x) * 4; out[o] = a ? (r / a) | 0 : 0; out[o + 1] = a ? (g / a) | 0 : 0; out[o + 2] = a ? (b / a) | 0 : 0; out[o + 3] = (a / n) | 0;
  }
  return out;
}

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
function encodePNG(S, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function buildIco(master) {
  const sizes = [256, 128, 64, 48, 32, 16];
  const pngs = sizes.map((s) => encodePNG(s, downscale(master, s)));
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = []; let offset = 6 + sizes.length * 16;
  sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; entries.push(e); });
  return Buffer.concat([header, ...entries, ...pngs]);
}

const master = render();
fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(master));
// macOS (.icns) and Linux icon sets are generated by electron-builder from this
// PNG, and it must be at least 512x512 — the master is already that size.
fs.writeFileSync(path.join(__dirname, 'icon.png'), encodePNG(M, master));
console.log(`Wrote build/icon.ico and build/icon.png (${M}x${M}, from zenlogo.png)`);
