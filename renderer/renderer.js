'use strict';

const api = window.mcBridge || {};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  servers: [],
  selectedId: null,
  consoleBuffers: {},
};

async function call(channel, payload) {
  const res = await api.invoke(channel, payload);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

// ---------------------------------------------------------------- sidebar

async function refreshServers() {
  state.servers = await call('servers:list');
  renderSidebar();
  if (state.selectedId && !state.servers.find((s) => s.id === state.selectedId)) {
    state.selectedId = null;
  }
  updateMainVisibility();
}

function renderSidebar() {
  const list = $('#serverList');
  list.innerHTML = '';
  for (const s of state.servers) {
    const el = document.createElement('div');
    el.className = 'server-item' + (s.id === state.selectedId ? ' active' : '');
    el.innerHTML = `
      <span class="status-dot ${s.status}"></span>
      <div style="flex:1; overflow:hidden">
        <div class="si-name">${escapeHtml(s.name)}</div>
        <div class="si-sub">${s.type} · ${s.version}</div>
      </div>`;
    el.onclick = () => selectServer(s.id);
    list.appendChild(el);
  }
}

function updateMainVisibility() {
  const has = !!state.selectedId;
  $('#serverView').classList.toggle('hidden', !has);
  $('#emptyState').classList.toggle('hidden', has);
  if (!has) {
    const h = $('#emptyState').querySelector('h1');
    const p = $('#emptyState').querySelector('p');
    if (state.servers.length > 0) {
      h.textContent = 'Select a server';
      p.textContent = 'Pick a server on the left, or create a new one.';
    }
  }
}

// ---------------------------------------------------------------- selection

function currentServer() {
  return state.servers.find((s) => s.id === state.selectedId);
}

async function selectServer(id) {
  state.selectedId = id;
  renderSidebar();
  updateMainVisibility();
  const s = currentServer();
  if (!s) return;
  $('#serverNameInput').value = s.name;
  $('#serverMeta').textContent = `${s.type} ${s.version} · ${s.memoryMB}MB`;
  updateStatusUI(s.status);
  switchTab('overview');
  renderConsole();
  loadOverview();
  loadWorld();
  loadProperties();
  loadMods();
  loadOps();
  loadFarRender();
}

function updateStatusUI(status) {
  const running = status !== 'stopped';
  $('#statusDot').className = 'status-dot ' + status;
  $('#startBtn').classList.toggle('hidden', running);
  $('#stopBtn').classList.toggle('hidden', !running);

  const label = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…' }[status] || status;
  $('#ovStatusDot').className = 'status-dot lg ' + status;
  $('#ovStatusText').textContent = label;
  $('#ovStartBtn').classList.toggle('hidden', running);
  $('#ovStopBtn').classList.toggle('hidden', !running);
}

// ---------------------------------------------------------------- overview

async function loadOverview() {
  const s = currentServer();
  if (!s) return;
  try {
    const info = await call('net:info', s.id);
    $('#connectIp').textContent = info.local;
    $('#connectIp').dataset.copy = info.local;
    if (info.lan) {
      $('#lanRow').classList.remove('hidden');
      $('#connectLan').textContent = info.lan;
      $('#connectLan').dataset.copy = info.lan;
    } else {
      $('#lanRow').classList.add('hidden');
    }
    const chips = $('#ovChips');
    chips.innerHTML = [
      ['Type', s.type],
      ['Version', s.version],
      ['Memory', s.memoryMB + ' MB'],
      ['Auth', info.onlineMode ? 'Online mode' : 'Offline (cracked)'],
    ].map(([k, v]) => `<span class="chip">${k}: <b>${escapeHtml(String(v))}</b></span>`).join('');

    $('#publicToggle').checked = info.public;
    updatePublicUI(info.tunnel || { status: 'off', address: null });
  } catch (e) { /* ignore */ }
}

function updatePublicUI(tunnel) {
  const status = tunnel.status || 'off';
  const addr = tunnel.address;
  $('#publicDot').className = 'status-dot ' + status;
  $('#publicAddr').textContent = addr || (status === 'connecting' ? 'getting a public address…' : '—');
  $('#publicAddr').dataset.copy = addr || '';
  $('#copyPublicBtn').classList.toggle('hidden', !addr);
  const hints = {
    off: $('#publicToggle').checked ? 'Start the server to get a public address.' : 'Off — only you and your network can connect.',
    connecting: 'Connecting to the tunnel…',
    reconnecting: 'Connection dropped — reconnecting…',
    online: 'Share this address with anyone, anywhere. Online-mode is on; enable the whitelist in Settings to restrict who joins.',
    error: 'Couldn\'t reach the tunnel service. The local/LAN addresses still work.',
  };
  $('#publicHint').textContent = hints[status] || '';
}

$('#publicToggle').onchange = async (e) => {
  const s = currentServer();
  if (!s) return;
  await call('servers:setPublic', { id: s.id, enabled: e.target.checked });
  if (!e.target.checked) updatePublicUI({ status: 'off', address: null });
  else if (s.status === 'stopped') $('#publicHint').textContent = 'Start the server to get a public address.';
};
$('#copyPublicBtn').onclick = async () => {
  const addr = $('#publicAddr').dataset.copy;
  if (addr) { await api.copyText(addr); toast('Copied ' + addr); }
};

$('#copyIpBtn').onclick = async () => {
  await api.copyText($('#connectIp').dataset.copy || $('#connectIp').textContent);
  toast('Copied ' + $('#connectIp').textContent);
};
$('#copyLanBtn').onclick = async () => {
  await api.copyText($('#connectLan').dataset.copy || $('#connectLan').textContent);
  toast('Copied LAN address');
};
$$('.quick-card').forEach((c) => { c.onclick = () => switchTab(c.dataset.goto); });

// ---------------------------------------------------------------- console

function renderConsole() {
  const box = $('#console');
  const lines = state.consoleBuffers[state.selectedId] || [];
  box.innerHTML = lines.join('');
  box.scrollTop = box.scrollHeight;
}

function appendConsole(id, text) {
  const buf = state.consoleBuffers[id] || (state.consoleBuffers[id] = []);
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    let cls = '';
    if (/WARN/.test(raw)) cls = 'line-warn';
    else if (/ERROR|Exception|severe/i.test(raw)) cls = 'line-error';
    else if (/INFO/.test(raw)) cls = 'line-info';
    buf.push(`<div class="${cls}">${escapeHtml(raw)}</div>`);
  }
  if (buf.length > 2000) buf.splice(0, buf.length - 2000);
  if (id === state.selectedId) renderConsole();
}

// ---------------------------------------------------------------- tabs

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ---------------------------------------------------------------- start/stop

async function doStart() {
  const s = currentServer();
  if (!s) return;
  if (!s.eulaAccepted) {
    const ok = confirm('To run a Minecraft server you must agree to the Mojang EULA:\nhttps://aka.ms/MinecraftEULA\n\nDo you agree?');
    if (!ok) return;
    await call('servers:acceptEula', s.id);
    s.eulaAccepted = true;
  }
  try { await call('servers:start', s.id); }
  catch (e) { appendConsole(s.id, `[Error] ${e.message}`); switchTab('console'); }
}
async function doStop() {
  const s = currentServer();
  if (s) await call('servers:stop', s.id);
}
$('#startBtn').onclick = doStart;
$('#stopBtn').onclick = doStop;
$('#ovStartBtn').onclick = doStart;
$('#ovStopBtn').onclick = doStop;

$('#sendCmdBtn').onclick = sendCommand;
$('#commandInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCommand(); });
async function sendCommand() {
  const s = currentServer();
  const input = $('#commandInput');
  const cmd = input.value.trim();
  if (!s || !cmd) return;
  appendConsole(s.id, `> ${cmd}`);
  await call('servers:command', { id: s.id, command: cmd });
  input.value = '';
}

$('#folderBtn').onclick = () => { const s = currentServer(); if (s) call('servers:openFolder', s.id); };
$('#deleteBtn').onclick = async () => {
  const s = currentServer();
  if (!s) return;
  if (!confirm(`Delete "${s.name}"? This permanently removes the server and its world.`)) return;
  await call('servers:delete', s.id);
  state.selectedId = null;
  delete state.consoleBuffers[s.id];
  await refreshServers();
};
$('#serverNameInput').addEventListener('change', async (e) => {
  const s = currentServer();
  if (!s) return;
  await call('servers:rename', { id: s.id, name: e.target.value });
  await refreshServers();
  selectServer(s.id);
});

// ---------------------------------------------------------------- WORLD (visual)

function gmIcon(name) {
  // 16x16 item/GUI textures get nearest-neighbour scaling; the grass render is hi-res.
  const cls = name === 'grass' ? 'cc-img' : 'cc-img pixel';
  return `<img class="${cls}" src="assets/${name}.png" alt="">`;
}
const GAMEMODES = [
  ['survival', gmIcon('heart'), 'Survival', 'Mine, craft, survive'],
  ['creative', gmIcon('grass'), 'Creative', 'Unlimited blocks, fly'],
  ['adventure', gmIcon('map'), 'Adventure', 'For custom maps'],
  ['spectator', gmIcon('spyglass'), 'Spectator', 'Fly through, no touch'],
];
const DIFFICULTIES = [
  ['peaceful', gmIcon('poppy'), 'Peaceful', 'No mobs, regen'],
  ['easy', gmIcon('wooden_sword'), 'Easy', 'Few mobs'],
  ['normal', gmIcon('iron_sword'), 'Normal', 'Standard'],
  ['hard', gmIcon('diamond_sword'), 'Hard', 'Brutal'],
];
const WORLD_TYPES = [
  ['minecraft:normal', 'Normal'],
  ['minecraft:flat', 'Superflat'],
  ['minecraft:large_biomes', 'Large Biomes'],
  ['minecraft:amplified', 'Amplified'],
];
const WORLD_TOGGLES = [
  ['hardcore', 'Hardcore', 'One life — death is permanent'],
  ['pvp', 'PvP', 'Players can damage each other'],
  ['allow-nether', 'Allow Nether', 'Enable nether portals'],
  ['generate-structures', 'Generate Structures', 'Villages, temples, etc.'],
  ['spawn-monsters', 'Spawn Monsters', 'Hostile mobs appear'],
  ['spawn-animals', 'Spawn Animals', 'Passive mobs appear'],
  ['enable-command-block', 'Command Blocks', 'Allow command blocks'],
  ['allow-flight', 'Allow Flight', 'Permit flight mods/elytra'],
];

async function loadWorld() {
  const s = currentServer();
  if (!s) return;
  const { props } = await call('props:read', s.id);
  const form = $('#worldForm');
  form._props = props;
  form._values = { ...props };

  const card = (block) => `<div class="world-block glass">${block}</div>`;
  form.innerHTML = `
    ${card(`<div class="world-section-title">Default Game Mode</div>
      <div class="choice-cards cols-4" id="gmCards">${
        GAMEMODES.map(([v, e, n, d]) => choiceCard('gamemode', v, e, n, d, props.gamemode === v)).join('')}</div>`)}
    ${card(`<div class="world-section-title">Difficulty</div>
      <div class="choice-cards cols-4" id="diffCards">${
        DIFFICULTIES.map(([v, e, n, d]) => choiceCard('difficulty', v, e, n, d, props.difficulty === v)).join('')}</div>`)}
    ${card(`<div class="world-section-title">World Generation</div>
      <div class="world-row2">
        <label class="world-field"><span>World seed (blank = random)</span>
          <input id="w_seed" type="text" value="${escapeAttr(props['level-seed'] || '')}" placeholder="e.g. 12345 or any text"></label>
        <label class="world-field"><span>World type</span>
          <select id="w_type">${WORLD_TYPES.map(([v, n]) => `<option value="${v}" ${props['level-type'] === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>`)}
    ${card(`<div class="world-section-title">Rules</div>
      <div class="world-toggles" id="worldToggles">${
        WORLD_TOGGLES.map(([k, n, d]) => toggleRow(k, n, d, props[k] === 'true')).join('')}</div>`)}
    ${card(`<div class="world-section-title">Players & View</div>
      <div class="world-row2">
        <label class="world-field"><span>Server message (MOTD)</span>
          <input id="w_motd" type="text" value="${escapeAttr(props.motd || '')}"></label>
        <label class="world-field"><span>Max players</span>
          <input id="w_maxplayers" type="number" min="1" max="1000" value="${escapeAttr(props['max-players'] || '20')}"></label>
        <label class="world-field"><span>View distance (chunks)</span>
          <input id="w_view" type="number" min="3" max="32" value="${escapeAttr(props['view-distance'] || '10')}"></label>
        <label class="world-field"><span>Spawn protection (radius)</span>
          <input id="w_spawnprot" type="number" min="0" max="256" value="${escapeAttr(props['spawn-protection'] || '16')}"></label>
      </div>`)}
  `;

  // wire choice cards
  form.querySelectorAll('.choice-card').forEach((c) => {
    c.onclick = () => {
      const group = c.dataset.group;
      form.querySelectorAll(`.choice-card[data-group="${group}"]`).forEach((x) => x.classList.remove('selected'));
      c.classList.add('selected');
      form._values[group] = c.dataset.value;
    };
  });
}

function choiceCard(group, value, emoji, name, desc, selected) {
  return `<button class="choice-card ${selected ? 'selected' : ''}" data-group="${group}" data-value="${value}">
    <span class="cc-emoji">${emoji}</span><span class="cc-name">${name}</span><span class="cc-desc">${desc}</span></button>`;
}
function toggleRow(key, name, desc, checked) {
  return `<div class="prop-row"><label>${name}<span class="prop-key">${desc}</span></label>
    <label class="switch"><input type="checkbox" data-wkey="${key}" ${checked ? 'checked' : ''}><span class="slider"></span></label></div>`;
}

$('#saveWorldBtn').onclick = async () => {
  const s = currentServer();
  if (!s) return;
  const form = $('#worldForm');
  const props = { ...form._props, ...form._values };
  form.querySelectorAll('[data-wkey]').forEach((c) => { props[c.dataset.wkey] = c.checked ? 'true' : 'false'; });
  props['level-seed'] = $('#w_seed').value;
  props['level-type'] = $('#w_type').value;
  props.motd = $('#w_motd').value;
  props['max-players'] = $('#w_maxplayers').value;
  props['view-distance'] = $('#w_view').value;
  props['spawn-protection'] = $('#w_spawnprot').value;
  await call('props:write', { id: s.id, props });
  loadOverview();
  toast('World settings saved');
};

// ---------------------------------------------------------------- OPERATORS

async function loadOps() {
  const s = currentServer();
  if (!s) return;
  const ops = await call('ops:list', s.id);
  const list = $('#opsList');
  list.innerHTML = '';
  if (!ops.length) {
    list.innerHTML = '<div class="muted" style="padding:6px">No operators yet. Add a player above to give them admin powers.</div>';
  }
  for (const op of ops) {
    const el = document.createElement('div');
    el.className = 'op-item';
    el.innerHTML = `
      <div class="op-avatar">${escapeHtml((op.name || '?')[0].toUpperCase())}</div>
      <div style="flex:1">
        <div class="op-name">${escapeHtml(op.name || '')}</div>
        <div class="op-uuid">${escapeHtml(op.uuid || '')}</div>
      </div>
      <span class="op-level">Level ${op.level ?? 4}</span>
      <button class="btn btn-ghost danger-text" title="Remove operator">Remove</button>`;
    el.querySelector('button').onclick = async () => {
      await call('ops:remove', { id: s.id, uuid: op.uuid });
      loadOps();
      toast(`Removed ${op.name}`);
    };
    list.appendChild(el);
  }
}

$('#addOpBtn').onclick = addOperator;
$('#opNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOperator(); });
async function addOperator() {
  const s = currentServer();
  if (!s) return;
  const name = $('#opNameInput').value.trim();
  const level = $('#opLevelSelect').value;
  const notice = $('#opNotice');
  if (!name) return;
  notice.className = 'notice'; notice.classList.add('hidden');
  try {
    await call('ops:add', { id: s.id, name, level });
    $('#opNameInput').value = '';
    loadOps();
    toast(`${name} is now an operator`);
  } catch (e) {
    notice.className = 'notice error';
    notice.textContent = e.message;
    notice.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------- SETTINGS (full)

async function loadProperties() {
  const s = currentServer();
  if (!s) return;
  const { props, meta } = await call('props:read', s.id);
  const form = $('#propsForm');
  form.innerHTML = '';
  form._props = props;

  const groups = {};
  const known = new Set();
  for (const [key, m] of Object.entries(meta)) {
    if (!(key in props)) continue;
    known.add(key);
    (groups[m.group] = groups[m.group] || []).push([key, m]);
  }
  const advanced = Object.keys(props).filter((k) => !known.has(k)).sort();

  for (const group of Object.keys(groups)) {
    addGroupTitle(form, group);
    for (const [key, m] of groups[group]) addPropRow(form, key, m, props[key]);
  }
  if (advanced.length) {
    addGroupTitle(form, 'Advanced');
    for (const key of advanced) addPropRow(form, key, { label: key, type: 'string' }, props[key]);
  }
}
function addGroupTitle(form, title) {
  const h = document.createElement('div');
  h.className = 'prop-group-title';
  h.textContent = title;
  form.appendChild(h);
}
function addPropRow(form, key, m, value) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.innerHTML = `${escapeHtml(m.label)}<span class="prop-key">${key}</span>`;
  row.appendChild(label);
  let control;
  if (m.type === 'boolean') {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = value === 'true';
    const sl = document.createElement('span'); sl.className = 'slider';
    wrap.appendChild(control); wrap.appendChild(sl); row.appendChild(wrap);
  } else if (m.type === 'enum') {
    control = document.createElement('select');
    for (const opt of m.options) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === value) o.selected = true;
      control.appendChild(o);
    }
    row.appendChild(control);
  } else if (m.type === 'int') {
    control = document.createElement('input');
    control.type = 'number';
    if (m.min != null) control.min = m.min;
    if (m.max != null) control.max = m.max;
    control.value = value; row.appendChild(control);
  } else {
    control = document.createElement('input');
    control.type = 'text'; control.value = value; row.appendChild(control);
  }
  control.dataset.key = key;
  control.dataset.type = m.type;
  form.appendChild(row);
}
$('#savePropsBtn').onclick = async () => {
  const s = currentServer();
  if (!s) return;
  const form = $('#propsForm');
  const props = { ...form._props };
  for (const control of form.querySelectorAll('[data-key]')) {
    const key = control.dataset.key;
    props[key] = control.dataset.type === 'boolean' ? (control.checked ? 'true' : 'false') : control.value;
  }
  await call('props:write', { id: s.id, props });
  loadOverview(); loadWorld();
  toast('Settings saved');
};

// ---------------------------------------------------------------- MODS

async function loadMods() {
  const s = currentServer();
  if (!s) return;
  const notice = $('#modsNotice');
  const MOD_TYPES = ['fabric', 'forge', 'neoforge'];
  if (!MOD_TYPES.includes(s.type)) {
    notice.className = 'notice warn';
    notice.innerHTML = `<strong>${s.type} servers don't use drag-and-drop mods.</strong> ` +
      (s.type === 'paper'
        ? 'Paper uses <em>plugins</em> — drop .jar plugins into the server\'s <code>plugins</code> folder via 📁.'
        : 'Create a <strong>Fabric</strong>, <strong>Forge</strong> or <strong>NeoForge</strong> server to add mods.');
    notice.classList.remove('hidden');
    $('#modsList').innerHTML = '';
    $('#modsDropzone').classList.add('hidden');
    return;
  }
  notice.classList.add('hidden');
  $('#modsDropzone').classList.remove('hidden');
  const mods = await call('mods:list', s.id);
  const list = $('#modsList');
  list.innerHTML = '';
  if (mods.length === 0) {
    list.innerHTML = '<div class="muted" style="padding:8px">No mods yet. Drop some .jar files above.</div>';
  }
  for (const mod of mods) {
    const el = document.createElement('div');
    el.className = 'mod-item' + (mod.enabled ? '' : ' disabled');
    el.innerHTML = `
      <span>🧩</span>
      <div class="mod-name">${escapeHtml(mod.name)}<div class="mod-size">${formatSize(mod.size)}</div></div>
      <label class="switch"><input type="checkbox" ${mod.enabled ? 'checked' : ''}><span class="slider"></span></label>
      <button class="btn btn-ghost danger-text" title="Remove">🗑</button>`;
    el.querySelector('input').onchange = async () => { await call('mods:toggle', { id: s.id, file: mod.file }); loadMods(); };
    el.querySelector('button').onclick = async () => { await call('mods:delete', { id: s.id, file: mod.file }); loadMods(); };
    list.appendChild(el);
  }
}

const dz = $('#modsDropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async (e) => {
  const s = currentServer();
  if (!s || !['fabric', 'forge', 'neoforge'].includes(s.type)) return;
  const paths = [];
  for (const file of e.dataTransfer.files) {
    const p = api.pathForFile(file);
    if (p) paths.push(p);
  }
  await addModFiles(paths);
});
$('#browseModsBtn').onclick = async () => { await addModFiles(await call('dialog:pickMods')); };
async function addModFiles(paths) {
  const s = currentServer();
  if (!s || !paths.length) return;
  const jars = paths.filter((p) => p.toLowerCase().endsWith('.jar'));
  if (!jars.length) return;
  await call('mods:add', { id: s.id, paths: jars });
  loadMods();
  toast(`Added ${jars.length} mod${jars.length > 1 ? 's' : ''}`);
}

// ---------------------------------------------------------------- FAR RENDER

const FAR_MODS_UI = [
  ['distanthorizons', 'Distant Horizons', 'Server streams far LODs to DH clients'],
  ['voxy', 'Voxy', 'Server-side LOD auto-streaming (Fabric)'],
  ['chunky', 'Chunky', 'Pre-generates the world'],
];

async function loadFarRender() {
  const s = currentServer();
  if (!s) return;
  const notice = $('#farNotice');
  if (!['fabric', 'forge', 'neoforge'].includes(s.type)) {
    notice.classList.remove('hidden');
    notice.innerHTML = `<strong>Far render needs a modded server.</strong> Distant Horizons / Voxy run on <strong>Fabric</strong>, <strong>Forge</strong> or <strong>NeoForge</strong> — ${s.type} servers can't load them.`;
    $('#farBody').classList.add('hidden');
    return;
  }
  notice.classList.add('hidden');
  $('#farBody').classList.remove('hidden');
  let installed = {};
  try { installed = await call('farrender:installed', s.id); } catch {}
  $('#farMods').innerHTML = FAR_MODS_UI.map(([slug, name, desc]) => `
    <div class="far-mod-row">
      <span>${slug === 'chunky' ? '🧱' : '🌄'}</span>
      <div class="fm-name">${name}<div class="fm-state">${escapeHtml(desc)}</div></div>
      <span class="fm-state ${installed[slug] ? 'ok' : ''}">${installed[slug] ? '✓ installed' : 'not installed'}</span>
    </div>`).join('');
  $('#pregenBtn').disabled = s.status === 'stopped';
  $('#pregenBtn').title = s.status === 'stopped' ? 'Start the server first' : '';
  $('#radiusChunks').textContent = radiusChunks(Number($('#radiusSlider').value));
}

function radiusChunks(r) {
  const chunks = Math.round(Math.PI * (r / 16) ** 2);
  return `≈ ${chunks.toLocaleString()} chunks`;
}
$('#radiusSlider').addEventListener('input', (e) => {
  const r = Number(e.target.value);
  $('#radiusLabel').textContent = `${r.toLocaleString()} blocks`;
  $('#radiusChunks').textContent = radiusChunks(r);
});

$('#installFarBtn').onclick = async () => {
  const s = currentServer();
  if (!s) return;
  const btn = $('#installFarBtn');
  btn.disabled = true; btn.textContent = '⤓ Downloading mods…';
  try {
    const results = await call('farrender:install', s.id);
    for (const r of results) {
      if (r.ok) toast(`✓ ${r.name} ${r.version}`);
      else toast(`✗ ${r.name}: ${r.error}`);
    }
    await loadFarRender();
    loadMods();
  } catch (e) {
    toast('Install failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '⤓ Install far-render mods';
  }
};

$('#pregenBtn').onclick = async () => {
  const s = currentServer();
  if (!s) return;
  const radius = Number($('#radiusSlider').value);
  try {
    await call('farrender:pregen', { id: s.id, radius });
    $('#pregenProgress').classList.remove('hidden');
    $('#pregenBtn').classList.add('hidden');
    $('#pregenCancelBtn').classList.remove('hidden');
    $('#pregenFill').style.width = '0%';
    $('#pregenText').textContent = 'Starting pre-generation…';
  } catch (e) {
    toast(e.message);
  }
};
$('#pregenCancelBtn').onclick = async () => {
  const s = currentServer();
  if (s) await call('farrender:cancel', s.id);
};

function resetPregenUI() {
  $('#pregenBtn').classList.remove('hidden');
  $('#pregenCancelBtn').classList.add('hidden');
}

// ---------------------------------------------------------------- new server modal

const modal = $('#modal');
let selectedType = 'vanilla';
const versionCache = {};

$('#newServerBtn').onclick = () => openModal();
$('#emptyCreateBtn').onclick = () => openModal();
$('#m_cancel').onclick = () => modal.classList.add('hidden');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
$('#m_memory').addEventListener('input', (e) => { $('#memLabel').textContent = `${e.target.value} MB`; });
$$('#typeCards .type-card').forEach((card) => {
  card.onclick = () => {
    selectedType = card.dataset.type;
    $$('#typeCards .type-card').forEach((c) => c.classList.toggle('selected', c === card));
    loadVersions();
  };
});

async function openModal() {
  $('#m_name').value = '';
  $('#createProgress').classList.add('hidden');
  $('#progressFill').style.width = '0%';
  $('#m_create').disabled = false;
  modal.classList.remove('hidden');
  await loadVersions();
}
async function loadVersions() {
  const sel = $('#m_version');
  sel.innerHTML = '<option>Loading…</option>';
  try {
    if (!versionCache[selectedType]) versionCache[selectedType] = await call('versions:list', selectedType);
    const versions = versionCache[selectedType];
    sel.innerHTML = '';
    for (const v of versions.slice(0, 60)) {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    }
  } catch (e) {
    sel.innerHTML = `<option>Failed to load (${escapeHtml(e.message)})</option>`;
  }
}
$('#m_create').onclick = async () => {
  const name = $('#m_name').value.trim() || 'New Server';
  const version = $('#m_version').value;
  const memoryMB = Number($('#m_memory').value);
  if (!version || version.startsWith('Loading') || version.startsWith('Failed')) return;
  $('#m_create').disabled = true;
  $('#createProgress').classList.remove('hidden');
  $('#progressText').textContent = 'Resolving download…';
  try {
    const server = await call('servers:create', { name, type: selectedType, version, memoryMB });
    modal.classList.add('hidden');
    await refreshServers();
    selectServer(server.id);
  } catch (e) {
    $('#progressText').textContent = 'Error: ' + e.message;
    $('#m_create').disabled = false;
  }
};

// ---------------------------------------------------------------- events from main

api.on(({ channel, payload }) => {
  if (channel === 'console') {
    appendConsole(payload.id, payload.text);
  } else if (channel === 'status') {
    const s = state.servers.find((x) => x.id === payload.id);
    if (s) s.status = payload.status;
    renderSidebar();
    if (payload.id === state.selectedId) {
      updateStatusUI(payload.status);
      if (payload.status === 'running') loadOverview();
    }
  } else if (channel === 'tunnel') {
    if (payload.id === state.selectedId) {
      updatePublicUI({ status: payload.status, address: payload.address });
    }
  } else if (channel === 'pregen') {
    if (payload.id !== state.selectedId) return;
    if (payload.percent != null) $('#pregenFill').style.width = payload.percent + '%';
    if (payload.cancelled) { $('#pregenText').textContent = 'Cancelled.'; resetPregenUI(); }
    else if (payload.done) { $('#pregenFill').style.width = '100%'; $('#pregenText').textContent = '✓ Pre-generation complete.'; resetPregenUI(); }
    else if (payload.line) $('#pregenText').textContent = payload.line.slice(0, 90);
  } else if (channel === 'download-progress') {
    if (payload.phase === 'downloading') {
      $('#progressFill').style.width = payload.percent + '%';
      const mb = (payload.received / 1048576).toFixed(1);
      const total = payload.total ? (payload.total / 1048576).toFixed(1) + ' MB' : '';
      $('#progressText').textContent = `Downloading… ${mb} MB ${total ? '/ ' + total : ''} (${payload.percent}%)`;
    } else if (payload.phase === 'installing') {
      $('#progressFill').style.width = '100%';
      $('#progressText').textContent = `Installing mod loader… ${payload.line ? '— ' + payload.line.slice(0, 60) : '(this can take a minute)'}`;
    } else if (payload.phase === 'done') {
      $('#progressFill').style.width = '100%';
      $('#progressText').textContent = 'Setting up server files…';
    }
  }
});

// ---------------------------------------------------------------- utils

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function formatSize(bytes) {
  if (!bytes) return '';
  const kb = bytes / 1024;
  return kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
}

refreshServers();
