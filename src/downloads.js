'use strict';

// Fetches server jar download info from the official APIs for each server type,
// and streams downloads to disk with progress callbacks.

const fs = require('fs');
const path = require('path');

const MOJANG_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_API = 'https://api.papermc.io/v2/projects/paper';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Zen-Host' } });
  if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return res.json();
}

// ---- Vanilla (Mojang) ----------------------------------------------------

let _mojangManifest = null;
async function mojangManifest() {
  if (!_mojangManifest) _mojangManifest = await getJson(MOJANG_MANIFEST);
  return _mojangManifest;
}

async function vanillaVersions() {
  const m = await mojangManifest();
  return m.versions
    .filter((v) => v.type === 'release')
    .map((v) => v.id);
}

async function vanillaServerUrl(version) {
  const m = await mojangManifest();
  const entry = m.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`Unknown Minecraft version: ${version}`);
  const meta = await getJson(entry.url);
  if (!meta.downloads || !meta.downloads.server) {
    throw new Error(`No server jar available for ${version}`);
  }
  return meta.downloads.server.url;
}

// ---- Paper ---------------------------------------------------------------

async function paperVersions() {
  const data = await getJson(PAPER_API);
  return data.versions.slice().reverse(); // newest first
}

async function paperServerUrl(version) {
  const builds = await getJson(`${PAPER_API}/versions/${version}/builds`);
  if (!builds.builds || builds.builds.length === 0) {
    throw new Error(`No Paper builds for ${version}`);
  }
  const latest = builds.builds[builds.builds.length - 1];
  const name = latest.downloads.application.name;
  return `${PAPER_API}/versions/${version}/builds/${latest.build}/downloads/${name}`;
}

// ---- Fabric --------------------------------------------------------------

async function fabricGameVersions() {
  const data = await getJson(`${FABRIC_META}/versions/game`);
  return data.filter((v) => v.stable).map((v) => v.version);
}

async function fabricServerUrl(version) {
  const loaders = await getJson(`${FABRIC_META}/versions/loader`);
  const loader = loaders.find((l) => l.stable) || loaders[0];
  const installers = await getJson(`${FABRIC_META}/versions/installer`);
  const installer = installers.find((i) => i.stable) || installers[0];
  return `${FABRIC_META}/versions/loader/${version}/${loader.version}/${installer.version}/server/jar`;
}

// ---- Forge ---------------------------------------------------------------

const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

// Sort dotted versions descending ("1.21.1" before "1.20.4").
function cmpVerDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

let _forgePromos = null;
async function forgePromos() {
  if (!_forgePromos) _forgePromos = await getJson(FORGE_PROMOS);
  return _forgePromos;
}

async function forgeVersions() {
  const data = await forgePromos();
  const mc = new Set();
  for (const key of Object.keys(data.promos || {})) {
    const m = key.match(/^(.+)-(latest|recommended)$/);
    if (m) mc.add(m[1]);
  }
  return [...mc].sort(cmpVerDesc);
}

async function forgeInstallerUrl(mcVersion) {
  const data = await forgePromos();
  const build = data.promos[`${mcVersion}-recommended`] || data.promos[`${mcVersion}-latest`];
  if (!build) throw new Error(`No Forge build for ${mcVersion}`);
  const full = `${mcVersion}-${build}`;
  return `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`;
}

// ---- NeoForge ------------------------------------------------------------

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

async function neoforgeVersions() {
  const res = await fetch(`${NEOFORGE_MAVEN}/maven-metadata.xml`, { headers: { 'User-Agent': 'Zen-Host' } });
  if (!res.ok) throw new Error(`NeoForge metadata failed (${res.status})`);
  const xml = await res.text();
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  // Maven lists oldest→newest; show newest first, prefer stable over beta.
  const stable = all.filter((v) => !/beta/i.test(v)).reverse();
  const beta = all.filter((v) => /beta/i.test(v)).reverse();
  return [...stable, ...beta];
}

function neoforgeInstallerUrl(version) {
  return `${NEOFORGE_MAVEN}/${version}/neoforge-${version}-installer.jar`;
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
async function downloadToFile(url, destPath, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Zen-Host' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
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
  } finally {
    out.end();
  }
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  return { received, total };
}

module.exports = {
  listVersions,
  resolveServerUrl,
  downloadToFile,
};
