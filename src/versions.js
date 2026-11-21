'use strict';

// Minecraft and mod-loader version helpers.
//
// Minecraft switched from "1.21.x" to year-based numbers in 2026 ("26.1",
// "26.1.2", "26.3"…). Comparing the numeric parts in order handles both
// schemes, since 26 > 1.

// Negative when a < b, positive when a > b. Non-numeric suffixes are ignored.
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const newestFirst = (a, b) => compareVersions(b, a);

// "1.21.11" or "26.3" — not a snapshot, pre-release or release candidate.
function isRelease(v) {
  return /^\d+(\.\d+)+$/.test(String(v));
}

// NeoForge builds encode the Minecraft version they target:
//   21.1.172   -> 1.21.1     (old scheme, MC 1.20.2 – 1.21.11)
//   21.0.167   -> 1.21
//   26.1.2.120 -> 26.1.2     (year-based scheme, MC 26.1+)
//   26.3.0.83  -> 26.3
function neoforgeMcVersion(build) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(build));
  if (!m) return null;
  const [, a, b, c, d] = m;
  if (d !== undefined) return c === '0' ? `${a}.${b}` : `${a}.${b}.${c}`;
  return b === '0' ? `1.${a}` : `1.${a}.${b}`;
}

// True for a NeoForge build number, false for a Minecraft version. Servers made
// by Zen Host 0.1 stored the NeoForge build where the Minecraft version now goes.
function isNeoforgeBuild(v) {
  return /^\d+\.\d+\.\d+\.\d+/.test(v) || /^2[01]\.\d+\.\d+/.test(v);
}

// The Minecraft version a server runs, whatever was stored for it.
function mcVersionOf(meta) {
  if (!meta) return null;
  if (meta.mcVersion) return meta.mcVersion;
  if (meta.type === 'neoforge' && isNeoforgeBuild(meta.version)) return neoforgeMcVersion(meta.version);
  return meta.version;
}

// Best guess at the Java a Minecraft version needs, for when Mojang's version
// manifest can't be consulted. New servers record the exact number instead.
function estimateJavaMajor(mcVersion) {
  const v = mcVersion || '0';
  if (compareVersions(v, '26') >= 0) return 25;
  if (compareVersions(v, '1.20.5') >= 0) return 21;
  if (compareVersions(v, '1.18') >= 0) return 17;
  if (compareVersions(v, '1.17') >= 0) return 16;
  return 8;
}

module.exports = {
  compareVersions, newestFirst, isRelease, neoforgeMcVersion, isNeoforgeBuild, mcVersionOf, estimateJavaMajor,
};
