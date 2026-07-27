'use strict';

// Minimal Modrinth client: finds the right mod build (.jar) for a given Minecraft
// version + loader, used to install server-side far-render mods (Distant Horizons,
// Voxy) and the Chunky pre-generator.

const API = 'https://api.modrinth.com/v2';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Zen-Host/0.1 (minecraft server manager)' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Modrinth request failed (${res.status})`);
  return res.json();
}

// Returns { name, versionNumber, url, filename } for the newest matching build,
// or null if no build exists for that version+loader.
async function getModVersion(slug, gameVersion, loader) {
  const q = `loaders=${encodeURIComponent(JSON.stringify([loader]))}`
    + `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}`;
  const versions = await getJson(`${API}/project/${slug}/version?${q}`);
  if (!versions || versions.length === 0) return null;
  // Modrinth returns newest first; prefer a stable release.
  const v = versions.find((x) => x.version_type === 'release') || versions[0];
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0];
  if (!file) return null;
  return { name: v.name, versionNumber: v.version_number, url: file.url, filename: file.filename };
}

module.exports = { getModVersion };
