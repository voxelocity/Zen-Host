'use strict';

// Fetches server jar download info from the official APIs for each server type,
// and streams downloads to disk with progress callbacks.

const fs = require('fs');
const path = require('path');
const { request, getJson, getText, parse, outdatedError } = require('./http');
const { newestFirst, isRelease, neoforgeMcVersion, estimateJavaMajor } = require('./versions');

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
// PaperMC's "Fill" v3 API. The old api.papermc.io/v2 was shut down in 2026.
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

// ---- Vanilla (Mojang) ----------------------------------------------------

let _mojangManifest = null;
async function mojangManifest() {
  if (!_mojangManifest) _mojangManifest = await getJson(MOJANG_MANIFEST, 'Mojang');
  return _mojangManifest;
}

const _versionMeta = {};
async function mojangVersionMeta(version) {
  if (_versionMeta[version]) return _versionMeta[version];
  const m = await mojangManifest();
  const entry = parse('Mojang', m, (d) => d.versions.find((v) => v.id === version));
  if (!entry) throw new Error(`Unknown Minecraft version: ${version}`);
  _versionMeta[version] = await getJson(entry.url, 'Mojang');
  return _versionMeta[version];
}

async function vanillaVersions() {
  const m = await mojangManifest();
  return parse('Mojang', m, (d) => d.versions.filter((v) => v.type === 'release').map((v) => v.id));
}

async function vanillaServerUrl(version) {
  const meta = await mojangVersionMeta(version);
  const server = meta.downloads && meta.downloads.server;
  if (!server || !server.url) throw new Error(`Mojang doesn't publish a server jar for ${version}.`);
  return server.url;
}

// The Java major version Mojang says this Minecraft version needs (25 for 26.x,
// 21 for 1.20.5+…). Falls back to an estimate if Mojang can't be reached.
async function requiredJava(mcVersion) {
  try {
    const meta = await mojangVersionMeta(mcVersion);
    const major = meta.javaVersion && Number(meta.javaVersion.majorVersion);
    if (major) return major;
  } catch { /* offline, or a version Mojang doesn't list */ }
  return estimateJavaMajor(mcVersion);
}

// ---- Paper ---------------------------------------------------------------

async function paperVersions() {
  const data = await getJson(PAPER_API, 'PaperMC');
  // { versions: { "26.3": ["26.3", "26.3-rc-3"], "1.21": ["1.21.11", …], … } }
  return parse('PaperMC', data, (d) => Object.values(d.versions).flat())
    .filter(isRelease)
    .sort(newestFirst);
}

async function paperServerUrl(version) {
  const builds = await getJson(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds`, 'PaperMC');
  const pick = parse('PaperMC', builds, (list) => {
    const newest = list.slice().sort((a, b) => b.id - a.id);
    return newest.find((b) => b.channel === 'STABLE') || newest[0];
  });
  if (!pick) throw new Error(`PaperMC has no builds for ${version} yet.`);
  return parse('PaperMC', pick, (b) => {
    const url = b.downloads['server:default'].url;
    if (!url) throw new TypeError('missing download url');
    return url;
  });
}

// ---- Fabric --------------------------------------------------------------

async function fabricGameVersions() {
  const data = await getJson(`${FABRIC_META}/versions/game`, 'Fabric');
  return parse('Fabric', data, (d) => d.filter((v) => v.stable).map((v) => v.version));
}

async function fabricServerUrl(version) {
  const loaders = await getJson(`${FABRIC_META}/versions/loader`, 'Fabric');
  const installers = await getJson(`${FABRIC_META}/versions/installer`, 'Fabric');
  return parse('Fabric', { loaders, installers }, ({ loaders: l, installers: i }) => {
    const loader = (l.find((x) => x.stable) || l[0]).version;
    const installer = (i.find((x) => x.stable) || i[0]).version;
    return `${FABRIC_META}/versions/loader/${version}/${loader}/${installer}/server/jar`;
  });
}

// ---- Forge ---------------------------------------------------------------

const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

let _forgePromos = null;
async function forgePromos() {
  if (!_forgePromos) {
    const data = await getJson(FORGE_PROMOS, 'Forge');
    _forgePromos = parse('Forge', data, (d) => {
      if (typeof d.promos !== 'object') throw new TypeError('no promos');
      return d.promos;
    });
  }
  return _forgePromos;
}

async function forgeVersions() {
  const promos = await forgePromos();
  const mc = new Set();
  for (const key of Object.keys(promos)) {
    const m = key.match(/^(.+)-(latest|recommended)$/);
    if (m && isRelease(m[1])) mc.add(m[1]);
  }
  return [...mc].sort(newestFirst);
}

async function forgeInstallerUrl(mcVersion) {
  const promos = await forgePromos();
  const build = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
  if (!build) throw new Error(`Forge has no build for Minecraft ${mcVersion}.`);
  const full = `${mcVersion}-${build}`;
  return `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`;
}

// ---- NeoForge ------------------------------------------------------------

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

// Minecraft version -> newest NeoForge build for it (stable preferred over beta).
let _neoforgeBuilds = null;
async function neoforgeBuilds() {
  if (_neoforgeBuilds) return _neoforgeBuilds;
  const xml = await getText(`${NEOFORGE_MAVEN}/maven-metadata.xml`, 'NeoForge');
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  if (!all.length) throw outdatedError('NeoForge sent a version list Zen Host doesn\'t understand.');

  const best = {};
  for (const build of all) {
    // Skip snapshot alphas ("26.1.0.0-alpha.3+snapshot-1") and April Fools builds.
    if (!/^\d+\.\d+\.\d+(\.\d+)?(-beta)?$/.test(build) || build.startsWith('0.')) continue;
    const mc = neoforgeMcVersion(build);
    if (!mc) continue;
    const stable = !build.endsWith('-beta');
    const cur = best[mc];
    if (!cur || (stable && !cur.stable) || (stable === cur.stable && newestFirst(build, cur.build) < 0)) {
      best[mc] = { build, stable };
    }
  }
  _neoforgeBuilds = best;
  return best;
}

async function neoforgeVersions() {
  return Object.keys(await neoforgeBuilds()).sort(newestFirst);
}

async function neoforgeBuildFor(mcVersion) {
  const entry = (await neoforgeBuilds())[mcVersion];
  if (!entry) throw new Error(`NeoForge has no build for Minecraft ${mcVersion}.`);
  return entry.build;
}

async function neoforgeInstallerUrl(mcVersion) {
  const build = await neoforgeBuildFor(mcVersion);
  return `${NEOFORGE_MAVEN}/${build}/neoforge-${build}-installer.jar`;
}

// ---- Dispatch ------------------------------------------------------------

async function listVersions(type) {
  switch (type) {
    case 'vanilla': return vanillaVersions();
    case 'paper': return paperVersions();
    case 'fabric': return fabricGameVersions();
    case 'forge': return forgeVersions();
    case 'neoforge': return neoforgeVersions();
    default: throw new Error(`Unknown server type: ${type}`);
  }
}

// For vanilla/paper/fabric this is a direct server jar; for forge/neoforge it is
// the installer jar (the caller runs it to generate the server).
async function resolveServerUrl(type, version) {
  switch (type) {
    case 'vanilla': return vanillaServerUrl(version);
    case 'paper': return paperServerUrl(version);
    case 'fabric': return fabricServerUrl(version);
    case 'forge': return forgeInstallerUrl(version);
    case 'neoforge': return neoforgeInstallerUrl(version);
    default: throw new Error(`Unknown server type: ${type}`);
  }
}

// Streams a URL to destPath, calling onProgress({received, total}) periodically.
// A failed download never leaves a truncated file behind.
async function downloadToFile(url, destPath, onProgress) {
  const res = await request(url, new URL(url).host);
  if (!res.body) throw new Error('Download failed (empty response).');
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
  const finished = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  const reader = res.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise((r) => out.once('drain', r));
      }
      if (onProgress) onProgress({ received, total });
    }
    out.end();
    await finished;
  } catch (err) {
    out.destroy();
    try { fs.rmSync(destPath, { force: true }); } catch {}
    throw new Error(`Download interrupted: ${err.message}`);
  }
  if (total && received < total) {
    try { fs.rmSync(destPath, { force: true }); } catch {}
    throw new Error('Download was cut short. Check your connection and try again.');
  }
  return { received, total };
}

module.exports = {
  listVersions,
  resolveServerUrl,
  downloadToFile,
  requiredJava,
  neoforgeBuildFor,
};
