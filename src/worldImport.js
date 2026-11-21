'use strict';

// Importing an existing Minecraft Java world (a singleplayer save folder, or a
// .zip of one) into a server. Reads level.dat to show the world's name and the
// Minecraft version it was last played on. Pure Node — no unzip binary needed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);
const gunzip = promisify(zlib.gunzip);

// Files a world carries that a server shouldn't inherit.
const SKIP_FILES = new Set(['session.lock']);
const IGNORED_DIRS = new Set(['__MACOSX']);

// ---- zip reading ---------------------------------------------------------

async function openZip(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('That file isn\'t a valid .zip.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    // Zip64 (archives over 4 GB or with more than 65535 entries).
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('That .zip is damaged.');
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('That .zip is damaged.');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('That .zip is damaged.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);

      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const tag = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (tag === 0x0001) {   // zip64 sizes/offset
          let q = e + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
        }
        e += 4 + len;
      }
      entries.push({ name: name.replace(/\\/g, '/'), flags, method, compSize, size, offset });
      p = extraEnd + commentLen;
    }
    return { fh, entries };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

function checkSupported(entry) {
  if (entry.flags & 0x1) throw new Error('That .zip is password-protected. Extract it first and pick the folder instead.');
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error('That .zip uses a compression type Zen Host can\'t read. Extract it first and pick the folder instead.');
  }
}

async function dataStart(fh, entry) {
  const h = Buffer.alloc(30);
  await fh.read(h, 0, 30, entry.offset);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('That .zip is damaged.');
  return entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
}

async function readEntry(fh, entry) {
  checkSupported(entry);
  const buf = Buffer.alloc(entry.compSize);
  await fh.read(buf, 0, entry.compSize, await dataStart(fh, entry));
  return entry.method === 8 ? inflateRaw(buf) : buf;
}

async function extractEntry(file, fh, entry, dest) {
  checkSupported(entry);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (entry.compSize === 0) { await fsp.writeFile(dest, Buffer.alloc(0)); return; }
  const start = await dataStart(fh, entry);
  const src = fs.createReadStream(file, { start, end: start + entry.compSize - 1 });
  const out = fs.createWriteStream(dest);
  if (entry.method === 8) await pipeline(src, zlib.createInflateRaw(), out);
  else await pipeline(src, out);
}

// ---- finding the world inside what the user picked ------------------------

const depth = (p) => (p ? p.split('/').length : 0);

// The prefix ('' or 'Folder/') of the shallowest level.dat in a zip.
function zipWorldPrefix(entries) {
  const roots = entries
    .map((e) => e.name)
    .filter((n) => /(^|\/)level\.dat$/i.test(n) && !n.split('/').some((s) => IGNORED_DIRS.has(s)))
    .map((n) => n.slice(0, n.length - 'level.dat'.length));
  if (!roots.length) {
    if (entries.some((e) => /(^|\/)(levelname\.txt|db\/CURRENT)$/i.test(e.name))) throw bedrockError();
    throw new Error('No Minecraft world found in that .zip (it needs a level.dat file).');
  }
  const min = Math.min(...roots.map((r) => depth(r.replace(/\/$/, ''))));
  const top = roots.filter((r) => depth(r.replace(/\/$/, '')) === min);
  if (top.length > 1) throw new Error('That .zip holds several worlds. Zip just the one you want.');
  return top[0];
}

function bedrockError() {
  return new Error('That looks like a Bedrock world. Zen Host runs Java Edition servers, which can\'t load Bedrock worlds.');
}

// The folder holding level.dat: the picked folder itself, or one or two levels down.
async function folderWorldRoot(dir) {
  const has = (d, f) => fs.existsSync(path.join(d, f));
  if (has(dir, 'level.dat')) return dir;
  if (has(dir, 'levelname.txt') || has(dir, 'db')) throw bedrockError();
  let found = [];
  let level = [dir];
  for (let i = 0; i < 2 && !found.length; i++) {
    const next = [];
    for (const d of level) {
      let entries = [];
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (!e.isDirectory() || IGNORED_DIRS.has(e.name)) continue;
        const sub = path.join(d, e.name);
        if (has(sub, 'level.dat')) found.push(sub); else next.push(sub);
      }
    }
    level = next;
  }
  if (!found.length) throw new Error('No Minecraft world found in that folder (it needs a level.dat file).');
  if (found.length > 1) throw new Error('That folder holds several worlds — pick the one you want.');
  return found[0];
}

// ---- level.dat (gzipped NBT) ----------------------------------------------

function parseNbt(buf) {
  let p = 0;
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  const payload = (type) => {
    switch (type) {
      case 1: return buf.readInt8(p++);
      case 2: { const v = buf.readInt16BE(p); p += 2; return v; }
      case 3: { const v = buf.readInt32BE(p); p += 4; return v; }
      case 4: { const v = buf.readBigInt64BE(p); p += 8; return v.toString(); }
      case 5: { const v = buf.readFloatBE(p); p += 4; return v; }
      case 6: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 7: { const n = buf.readInt32BE(p); p += 4 + n; return null; }
      case 8: return str();
      case 9: {
        const t = buf.readUInt8(p++);
        const n = buf.readInt32BE(p); p += 4;
        const list = [];
        for (let i = 0; i < n; i++) list.push(payload(t));
        return list;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = buf.readUInt8(p++);
          if (t === 0) return obj;
          const name = str();
          obj[name] = payload(t);
        }
      }
      case 11: { const n = buf.readInt32BE(p); p += 4 + n * 4; return null; }
      case 12: { const n = buf.readInt32BE(p); p += 4 + n * 8; return null; }
      default: throw new Error(`bad NBT tag ${type}`);
    }
  };
  const rootType = buf.readUInt8(p++);
  if (rootType !== 10) throw new Error('bad NBT root');
  str();
  return payload(10);
}

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];

// Best-effort summary of a world from its level.dat bytes.
async function summarize(levelDat, fallbackName) {
  const info = { name: fallbackName, version: null, difficulty: null, gamemode: null, hardcore: null };
  try {
    let raw = levelDat;
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
    const data = parseNbt(raw).Data || {};
    if (typeof data.LevelName === 'string' && data.LevelName.trim()) info.name = data.LevelName.trim();
    if (data.Version && typeof data.Version.Name === 'string') info.version = data.Version.Name;
    const diff = typeof data.Difficulty === 'number' ? data.Difficulty
      : data.difficulty_settings && typeof data.difficulty_settings.difficulty === 'string'
        ? DIFFICULTIES.indexOf(data.difficulty_settings.difficulty) : null;
    if (DIFFICULTIES[diff]) info.difficulty = DIFFICULTIES[diff];
    if (GAMEMODES[data.GameType]) info.gamemode = GAMEMODES[data.GameType];
    const hc = data.hardcore ?? (data.difficulty_settings && data.difficulty_settings.hardcore);
    if (typeof hc === 'number') info.hardcore = hc !== 0;
  } catch { /* unreadable level.dat: the server will still try to load it */ }
  return info;
}

const isZip = (src) => /\.zip$/i.test(src);

// What the UI shows after the user picks a world: name, version, game settings.
async function inspectWorld(src) {
  if (!src || !fs.existsSync(src)) throw new Error('That file or folder no longer exists.');
  if (/\.mcworld$/i.test(src)) throw bedrockError();
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    const root = await folderWorldRoot(src);
    return { source: src, ...(await summarize(await fsp.readFile(path.join(root, 'level.dat')), path.basename(root))) };
  }
  if (!isZip(src)) throw new Error('Pick a world folder or a .zip of one.');
  const { fh, entries } = await openZip(src);
  try {
    const prefix = zipWorldPrefix(entries);
    const levelDat = entries.find((e) => e.name === prefix + 'level.dat');
    const fallback = prefix ? prefix.replace(/\/$/, '').split('/').pop() : path.basename(src, path.extname(src));
    return { source: src, ...(await summarize(await readEntry(fh, levelDat), fallback)) };
  } finally {
    await fh.close();
  }
}

// Copy or extract the world into `dest` (which must not exist yet).
// `onProgress(percent)` is called as files are written.
async function importWorld(src, dest, onProgress = () => {}) {
  if (fs.existsSync(dest)) throw new Error(`${path.basename(dest)} already exists.`);
  const staging = dest + '.importing';
  await fsp.rm(staging, { recursive: true, force: true });
  try {
    const stat = await fsp.stat(src);
    if (stat.isDirectory()) {
      const root = await folderWorldRoot(src);
      onProgress(0);
      await fsp.cp(root, staging, {
        recursive: true,
        filter: (s) => !SKIP_FILES.has(path.basename(s)),
      });
      onProgress(100);
    } else {
      const { fh, entries } = await openZip(src);
      try {
        const prefix = zipWorldPrefix(entries);
        const base = path.resolve(staging);
        const files = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith('/')
          && !SKIP_FILES.has(path.posix.basename(e.name)));
        const total = files.reduce((n, e) => n + e.size, 0) || 1;
        let written = 0;
        let lastPct = -1;
        await fsp.mkdir(base, { recursive: true });
        for (const e of files) {
          const rel = e.name.slice(prefix.length);
          const out = path.resolve(base, rel);
          // Never write outside the world folder ("zip slip").
          if (!out.startsWith(base + path.sep)) continue;
          await extractEntry(src, fh, e, out);
          written += e.size;
          const pct = Math.floor((written / total) * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
        if (lastPct !== 100) onProgress(100);
      } finally {
        await fh.close();
      }
    }
    await fsp.rename(staging, dest);
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { inspectWorld, importWorld };
