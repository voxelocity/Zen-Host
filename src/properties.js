'use strict';

// Metadata for the most commonly edited server.properties keys, used to render
// an intuitive editor (toggles, dropdowns, numbers) instead of raw text.
// Any key not listed here still shows up as a plain text field.

const { compareVersions } = require('./versions');

const PROPERTY_META = {
  motd: { label: 'Server Message (MOTD)', type: 'string', group: 'General' },
  'max-players': { label: 'Max Players', type: 'int', min: 1, max: 1000, group: 'General' },
  difficulty: { label: 'Difficulty', type: 'enum', options: ['peaceful', 'easy', 'normal', 'hard'], group: 'Gameplay' },
  gamemode: { label: 'Default Game Mode', type: 'enum', options: ['survival', 'creative', 'adventure', 'spectator'], group: 'Gameplay' },
  'force-gamemode': { label: 'Force Game Mode', type: 'boolean', group: 'Gameplay' },
  hardcore: { label: 'Hardcore', type: 'boolean', group: 'Gameplay' },
  pvp: { label: 'PvP', type: 'boolean', group: 'Gameplay' },
  'allow-flight': { label: 'Allow Flight', type: 'boolean', group: 'Gameplay' },
  'spawn-monsters': { label: 'Spawn Monsters', type: 'boolean', group: 'World' },
  'spawn-animals': { label: 'Spawn Animals', type: 'boolean', group: 'World' },
  'spawn-npcs': { label: 'Spawn Villagers', type: 'boolean', group: 'World' },
  'allow-nether': { label: 'Allow Nether', type: 'boolean', group: 'World' },
  'level-name': { label: 'World Name', type: 'string', group: 'World' },
  'level-seed': { label: 'World Seed', type: 'string', group: 'World' },
  'level-type': { label: 'World Type', type: 'enum', options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'], group: 'World' },
  'generate-structures': { label: 'Generate Structures', type: 'boolean', group: 'World' },
  'view-distance': { label: 'View Distance (chunks)', type: 'int', min: 3, max: 32, group: 'Performance' },
  'simulation-distance': { label: 'Simulation Distance (chunks)', type: 'int', min: 3, max: 32, group: 'Performance' },
  'max-tick-time': { label: 'Max Tick Time (ms)', type: 'int', min: -1, max: 600000, group: 'Performance' },
  'server-port': { label: 'Server Port', type: 'int', min: 1, max: 65535, group: 'Network' },
  'online-mode': { label: 'Online Mode (require Mojang auth)', type: 'boolean', group: 'Network' },
  'white-list': { label: 'Whitelist Enabled', type: 'boolean', group: 'Network' },
  'enforce-whitelist': { label: 'Enforce Whitelist', type: 'boolean', group: 'Network' },
  'enable-command-block': { label: 'Enable Command Blocks', type: 'boolean', group: 'General' },
  'spawn-protection': { label: 'Spawn Protection (radius)', type: 'int', min: 0, max: 256, group: 'World' },
};

// Sensible defaults written into a brand-new server.properties.
const DEFAULT_PROPERTIES = {
  motd: 'A Minecraft Server hosted with Zen Host',
  'max-players': '20',
  difficulty: 'normal',
  gamemode: 'survival',
  pvp: 'true',
  'online-mode': 'true',
  'server-port': '25565',
  'level-name': 'world',
  'view-distance': '10',
  'simulation-distance': '10',
  'allow-nether': 'true',
  'spawn-monsters': 'true',
  'spawn-animals': 'true',
  'spawn-npcs': 'true',
  'generate-structures': 'true',
  'enable-command-block': 'false',
  'white-list': 'false',
};

// ---- settings Mojang moved out of server.properties ----------------------
//
// 1.21.2 dropped spawn-animals and spawn-npcs outright. 1.21.9 turned pvp,
// spawn-monsters, allow-nether and enable-command-block into per-world game
// rules, and 1.21.11 renamed those rules to snake_case. Zen Host keeps showing
// them as the same toggles and sets the game rule behind the scenes.

const REMOVED_IN_1_21_2 = ['spawn-animals', 'spawn-npcs'];

// setting key -> [game rule in 1.21.9–1.21.10, game rule in 1.21.11+]
const MOVED_TO_GAMERULES = {
  pvp: ['pvp', 'pvp'],
  'spawn-monsters': ['spawnMonsters', 'spawn_monsters'],
  'allow-nether': ['allowEnteringNetherUsingPortals', 'allow_entering_nether_using_portals'],
  'enable-command-block': ['commandBlocksEnabled', 'command_blocks_work'],
};

// Vanilla's value for each moved rule in a brand-new world.
const GAMERULE_DEFAULTS = {
  pvp: true,
  'spawn-monsters': true,
  'allow-nether': true,
  'enable-command-block': true,
};

// Keys that do nothing in server.properties on this Minecraft version.
function removedProperties(mcVersion) {
  const removed = [];
  if (compareVersions(mcVersion, '1.21.2') >= 0) removed.push(...REMOVED_IN_1_21_2);
  if (gameruleNames(mcVersion)) removed.push(...Object.keys(MOVED_TO_GAMERULES));
  return removed;
}

// { 'spawn-monsters': 'spawn_monsters', … } when this version uses game rules
// for those settings, otherwise null.
function gameruleNames(mcVersion) {
  if (compareVersions(mcVersion, '1.21.9') < 0) return null;
  const idx = compareVersions(mcVersion, '1.21.11') < 0 ? 0 : 1;
  const out = {};
  for (const [key, names] of Object.entries(MOVED_TO_GAMERULES)) out[key] = names[idx];
  return out;
}

// The starting server.properties for a new server on this version.
function defaultPropertiesFor(mcVersion) {
  const props = { ...DEFAULT_PROPERTIES };
  for (const key of removedProperties(mcVersion)) delete props[key];
  return props;
}

function parseProperties(text) {
  const props = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    props[line.slice(0, idx).trim()] = line.slice(idx + 1);
  }
  return props;
}

function stringifyProperties(props) {
  const lines = ['#Minecraft server properties', `#${new Date().toString()}`];
  for (const key of Object.keys(props).sort()) {
    lines.push(`${key}=${props[key]}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  PROPERTY_META, DEFAULT_PROPERTIES, GAMERULE_DEFAULTS,
  parseProperties, stringifyProperties, removedProperties, gameruleNames, defaultPropertiesFor,
};
