'use strict';

const crypto = require('crypto');

// Format 32 hex chars into a dashed UUID.
function dash(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Offline-mode UUID = Java's UUID.nameUUIDFromBytes("OfflinePlayer:<name>") (md5, v3).
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  return dash(hash.toString('hex'));
}

// Resolve a player's real Mojang UUID by username. Returns { uuid, name } or null.
async function mojangUuid(name) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
      { headers: { 'User-Agent': 'Zen-Host' } });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (!data || !data.id) return null;
    return { uuid: dash(data.id), name: data.name };
  } catch {
    return null;
  }
}

// Resolve to { uuid, name } honoring the server's online-mode setting.
async function resolvePlayer(name, onlineMode) {
  if (onlineMode) {
    const m = await mojangUuid(name);
    if (m) return m;
    throw new Error(`Mojang has no account named "${name}" (server is in online mode).`);
  }
  return { uuid: offlineUuid(name), name };
}

module.exports = { resolvePlayer, offlineUuid };
