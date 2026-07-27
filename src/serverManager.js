'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const os = require('os');
const downloads = require('./downloads');
const { resolvePlayer } = require('./players');
const { Tunnel } = require('./tunnel');
const modrinth = require('./modrinth');
const { javaBin, installHint } = require('./java');

// Server-side far-render mods + the chunk pre-generator, fetched from Modrinth.
const FAR_MODS = [
  { slug: 'distanthorizons', name: 'Distant Horizons', loaders: ['fabric', 'forge', 'neoforge'] },
  { slug: 'voxy', name: 'Voxy', loaders: ['fabric'] },
  { slug: 'chunky', name: 'Chunky (pre-generator)', loaders: ['fabric', 'forge', 'neoforge'] },
];
const LOADER_OF = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge' };
const {
  PROPERTY_META, DEFAULT_PROPERTIES, parseProperties, stringifyProperties,
} = require('./properties');

// Server types that load .jar mods from a mods/ folder.
const MOD_TYPES = new Set(['fabric', 'forge', 'neoforge']);

// First non-internal IPv4 address, for "friends on your network" connect info.
function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

// Manages all servers: persistent metadata, files on disk, and running java
// processes. Emits events back to the UI via the `emit` callback set by main.
class ServerManager {
  constructor(rootDir) {
    this.rootDir = rootDir;                 // .../servers
    this.indexFile = path.join(rootDir, 'servers.json');
    this.servers = {};                      // id -> metadata
    this.running = {};                      // id -> { proc, status }
    this.tunnels = {};                      // id -> Tunnel
    this.tunnelState = {};                  // id -> { status, address }
    this.pregen = {};                       // id -> { active } while Chunky runs
    this.emit = () => {};                   // set by main: (channel, payload)
    fs.mkdirSync(rootDir, { recursive: true });
    this._load();
  }

  _load() {
    try {
      this.servers = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.servers = {};
    }
  }

  _save() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.servers, null, 2));
  }

  dir(id) { return path.join(this.rootDir, id); }

  list() {
    return Object.values(this.servers).map((s) => ({
      ...s,
      status: this.running[s.id] ? this.running[s.id].status : 'stopped',
    }));
  }

  get(id) {
    const s = this.servers[id];
    if (!s) return null;
    return {
      ...s,
      public: s.public !== false,
      status: this.running[id] ? this.running[id].status : 'stopped',
      tunnel: this.tunnelState[id] || { status: 'off', address: null },
    };
  }

  // ---- creation --------------------------------------------------------

  async create({ name, type, version, memoryMB }) {
    const id = randomUUID().slice(0, 8);
    const meta = {
      id,
      name: name || 'New Server',
      type,
      version,
      memoryMB: memoryMB || 2048,
      jar: 'server.jar',
      launchType: 'jar',
      public: true,            // reachable over the internet by default (bore tunnel)
      eulaAccepted: false,
      createdAt: Date.now(),
    };
    const serverDir = this.dir(id);
    fs.mkdirSync(serverDir, { recursive: true });
    if (MOD_TYPES.has(type)) fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });

    if (type === 'forge' || type === 'neoforge') {
      // These ship an installer that generates the server files locally.
      await this._installModLoader(id, meta, type, version);
    } else {
      // Direct server jar download with progress reporting.
      this.emit('download-progress', { id, phase: 'resolving', percent: 0 });
      const url = await downloads.resolveServerUrl(type, version);
      const jarPath = path.join(serverDir, 'server.jar');
      await downloads.downloadToFile(url, jarPath, ({ received, total }) => {
        const percent = total ? Math.round((received / total) * 100) : 0;
        this.emit('download-progress', { id, phase: 'downloading', percent, received, total });
      });
      this.emit('download-progress', { id, phase: 'done', percent: 100 });
    }

    // Seed a default server.properties.
    const propsPath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(propsPath, stringifyProperties({ ...DEFAULT_PROPERTIES, motd: meta.name }));
    }

    this.servers[id] = meta;
    this._save();
    return this.get(id);
  }

  // Download a Forge/NeoForge installer and run it to generate the server, then
  // figure out how the resulting server is launched (args file vs. a plain jar).
  async _installModLoader(id, meta, type, version) {
    const serverDir = this.dir(id);
    this.emit('download-progress', { id, phase: 'resolving', percent: 0 });
    const url = await downloads.resolveServerUrl(type, version);
    const installerPath = path.join(serverDir, 'installer.jar');
    await downloads.downloadToFile(url, installerPath, ({ received, total }) => {
      const percent = total ? Math.round((received / total) * 100) : 0;
      this.emit('download-progress', { id, phase: 'downloading', percent, received, total });
    });

    this.emit('download-progress', { id, phase: 'installing', line: `Running ${type} installer…` });
    const flag = type === 'neoforge' ? '--install-server' : '--installServer';
    await new Promise((resolve, reject) => {
      const proc = spawn(javaBin(), ['-jar', 'installer.jar', flag], { cwd: serverDir });
      const tail = [];
      const onData = (b) => {
        for (const ln of b.toString().split(/\r?\n/)) {
          const line = ln.trim();
          if (!line) continue;
          tail.push(line);
          if (tail.length > 6) tail.shift();
          this.emit('download-progress', { id, phase: 'installing', line });
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => reject(new Error(`Could not launch installer: ${err.message}`)));
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Installer failed (exit ${code}). ${tail.join(' | ')}`));
      });
    });

    // Modern Forge/NeoForge (MC 1.17+): launched via an @args file under libraries/.
    const argsFile = this._findArgsFile(serverDir);
    if (argsFile) {
      meta.launchType = 'args';
      meta.argsFile = argsFile;
    } else {
      // Older Forge produces a runnable forge-*.jar.
      const jar = fs.readdirSync(serverDir).find(
        (f) => /\.jar$/i.test(f) && /forge/i.test(f) && !/installer/i.test(f));
      if (!jar) throw new Error('Install finished but no run files were found.');
      meta.launchType = 'jar';
      meta.jar = jar;
    }
    try { fs.rmSync(installerPath, { force: true }); } catch {}
    try { fs.rmSync(installerPath + '.log', { force: true }); } catch {}
    this.emit('download-progress', { id, phase: 'done', percent: 100 });
  }

  // Locate the platform's launch args file produced by the installer.
  _findArgsFile(serverDir) {
    const wanted = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    let found = null;
    const walk = (dir) => {
      if (found) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === wanted) found = full;
      }
    };
    walk(path.join(serverDir, 'libraries'));
    return found ? path.relative(serverDir, found).split(path.sep).join('/') : null;
  }

  async delete(id) {
    if (this.running[id]) await this.stop(id, true);
    const serverDir = this.dir(id);
    fs.rmSync(serverDir, { recursive: true, force: true });
    delete this.servers[id];
    this._save();
  }

  rename(id, name) {
    if (!this.servers[id]) return;
    this.servers[id].name = name;
    this._save();
  }

  // ---- EULA ------------------------------------------------------------

  acceptEula(id) {
    const meta = this.servers[id];
    if (!meta) return;
    fs.writeFileSync(path.join(this.dir(id), 'eula.txt'), 'eula=true\n');
    meta.eulaAccepted = true;
    this._save();
  }

  // ---- properties ------------------------------------------------------

  readProperties(id) {
    const file = path.join(this.dir(id), 'server.properties');
    let props = {};
    try { props = parseProperties(fs.readFileSync(file, 'utf8')); } catch {}
    return { props, meta: PROPERTY_META };
  }

  writeProperties(id, props) {
    const file = path.join(this.dir(id), 'server.properties');
    fs.writeFileSync(file, stringifyProperties(props));
  }

  // ---- connection info -------------------------------------------------

  connectionInfo(id) {
    const meta = this.servers[id] || {};
    const { props } = this.readProperties(id);
    const port = props['server-port'] || '25565';
    const ip = lanIp();
    return {
      port,
      local: `localhost:${port}`,
      lan: ip ? `${ip}:${port}` : null,
      onlineMode: props['online-mode'] !== 'false',
      public: meta.public !== false,
      tunnel: this.tunnelState[id] || { status: 'off', address: null },
    };
  }

  // ---- public tunnel (bore) -------------------------------------------

  _setTunnelState(id, status, address) {
    this.tunnelState[id] = { status, address: address || null };
    this.emit('tunnel', { id, status, address: address || null });
  }

  startTunnel(id) {
    if (this.tunnels[id]) return;
    const { props } = this.readProperties(id);
    const port = Number(props['server-port'] || 25565);
    const t = new Tunnel(port);
    this.tunnels[id] = t;
    this._setTunnelState(id, 'connecting', null);
    t.on('ready', (info) => this._setTunnelState(id, 'online', info.address));
    t.on('status', (s) => { if (s === 'connecting' || s === 'reconnecting') this._setTunnelState(id, s, null); });
    t.on('error', (e) => {
      this.emit('console', { id, text: `[Public tunnel] ${e.message}\n` });
      this._setTunnelState(id, 'error', null);
    });
    t.start();
  }

  stopTunnel(id) {
    if (this.tunnels[id]) { this.tunnels[id].stop(); delete this.tunnels[id]; }
    this._setTunnelState(id, 'off', null);
  }

  setPublic(id, enabled) {
    const meta = this.servers[id];
    if (!meta) return;
    meta.public = !!enabled;
    this._save();
    if (this.running[id]) {
      if (enabled) this.startTunnel(id); else this.stopTunnel(id);
    }
  }

  // ---- far render (Distant Horizons / Voxy + Chunky pregen) ------------

  // Which far-render mods are already in the mods/ folder.
  farRenderInstalled(id) {
    const modsDir = path.join(this.dir(id), 'mods');
    let files = [];
    try { files = fs.readdirSync(modsDir); } catch {}
    const has = (re) => files.some((f) => re.test(f));
    return {
      distanthorizons: has(/distant.?horizons/i),
      voxy: has(/^voxy/i),
      chunky: has(/chunky/i),
    };
  }

  // Download server-side DH + Voxy + Chunky matching this server's version/loader.
  async installFarRender(id) {
    const meta = this.servers[id];
    if (!meta) throw new Error('Server not found');
    const loader = LOADER_OF[meta.type];
    if (!loader) throw new Error('Far render needs a Fabric, Forge or NeoForge server.');
    const modsDir = path.join(this.dir(id), 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    const results = [];
    for (const mod of FAR_MODS) {
      if (!mod.loaders.includes(loader)) {
        results.push({ slug: mod.slug, name: mod.name, ok: false, error: `${mod.name} doesn't support ${loader}.` });
        continue;
      }
      try {
        const v = await modrinth.getModVersion(mod.slug, meta.version, loader);
        if (!v) {
          results.push({ slug: mod.slug, name: mod.name, ok: false, error: `No build for Minecraft ${meta.version} yet.` });
          continue;
        }
        await downloads.downloadToFile(v.url, path.join(modsDir, v.filename));
        results.push({ slug: mod.slug, name: mod.name, ok: true, version: v.versionNumber, file: v.filename });
      } catch (e) {
        results.push({ slug: mod.slug, name: mod.name, ok: false, error: e.message });
      }
    }
    return results;
  }

  // Drive Chunky to pre-generate a radius (blocks) around spawn on the running server.
  pregenerate(id, radius) {
    if (!this.running[id]) throw new Error('Start the server first, then pre-generate.');
    if (!this.farRenderInstalled(id).chunky) throw new Error('Install the far-render mods first (Chunky is required).');
    this.pregen[id] = { active: true };
    this.emit('pregen', { id, percent: 0, line: 'Starting pre-generation…', done: false });
    this.sendCommand(id, `chunky radius ${Math.max(1, Math.round(radius))}`);
    this.sendCommand(id, 'chunky start');
  }

  cancelPregen(id) {
    if (this.running[id]) this.sendCommand(id, 'chunky cancel');
    this.pregen[id] = null;
    this.emit('pregen', { id, done: true, cancelled: true });
  }

  // ---- operators (ops.json) -------------------------------------------

  _opsPath(id) { return path.join(this.dir(id), 'ops.json'); }

  listOps(id) {
    try { return JSON.parse(fs.readFileSync(this._opsPath(id), 'utf8')); }
    catch { return []; }
  }

  async addOp(id, name, level = 4) {
    name = String(name).trim();
    if (!name) throw new Error('Enter a player name');
    const { props } = this.readProperties(id);
    const onlineMode = props['online-mode'] !== 'false';
    const { uuid, name: realName } = await resolvePlayer(name, onlineMode);

    const ops = this.listOps(id).filter((o) => o.uuid !== uuid);
    ops.push({ uuid, name: realName, level: Number(level) || 4, bypassesPlayerLimit: false });
    fs.writeFileSync(this._opsPath(id), JSON.stringify(ops, null, 2));
    if (this.running[id]) this.sendCommand(id, `op ${realName}`);
    return ops;
  }

  removeOp(id, uuid) {
    const ops = this.listOps(id);
    const removed = ops.find((o) => o.uuid === uuid);
    const next = ops.filter((o) => o.uuid !== uuid);
    fs.writeFileSync(this._opsPath(id), JSON.stringify(next, null, 2));
    if (removed && this.running[id]) this.sendCommand(id, `deop ${removed.name}`);
    return next;
  }

  // ---- mods ------------------------------------------------------------

  listMods(id) {
    const modsDir = path.join(this.dir(id), 'mods');
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir)
      .filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map((f) => {
        const enabled = f.endsWith('.jar');
        const full = path.join(modsDir, f);
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        return { file: f, name: f.replace(/\.disabled$/, ''), enabled, size };
      });
  }

  addMods(id, filePaths) {
    const modsDir = path.join(this.dir(id), 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const added = [];
    for (const src of filePaths) {
      if (!src.toLowerCase().endsWith('.jar')) continue;
      const dest = path.join(modsDir, path.basename(src));
      fs.copyFileSync(src, dest);
      added.push(path.basename(src));
    }
    return added;
  }

  toggleMod(id, file) {
    const modsDir = path.join(this.dir(id), 'mods');
    const current = path.join(modsDir, file);
    const next = file.endsWith('.disabled')
      ? path.join(modsDir, file.replace(/\.disabled$/, ''))
      : path.join(modsDir, file + '.disabled');
    fs.renameSync(current, next);
  }

  deleteMod(id, file) {
    fs.rmSync(path.join(this.dir(id), 'mods', file), { force: true });
  }

  // ---- process lifecycle ----------------------------------------------

  start(id) {
    const meta = this.servers[id];
    if (!meta) throw new Error('Server not found');
    if (this.running[id]) return; // already running
    if (!meta.eulaAccepted) throw new Error('EULA not accepted');

    const serverDir = this.dir(id);
    const xmx = `-Xmx${meta.memoryMB}M`;
    const xms = `-Xms${Math.min(meta.memoryMB, 1024)}M`;
    const args = meta.launchType === 'args'
      ? [xms, xmx, `@${meta.argsFile}`, 'nogui']                 // modern Forge/NeoForge
      : [xms, xmx, '-jar', meta.jar || 'server.jar', 'nogui'];   // vanilla/paper/fabric/old-forge

    const proc = spawn(javaBin(), args, { cwd: serverDir });
    this.running[id] = { proc, status: 'starting' };
    this.emit('status', { id, status: 'starting' });

    // Expose to the internet via the bore tunnel when the server is public.
    if (meta.public !== false) this.startTunnel(id);

    const onData = (buf) => {
      const text = buf.toString();
      this.emit('console', { id, text });
      if (/Done \(.*\)! For help/.test(text) && this.running[id]) {
        this.running[id].status = 'running';
        this.emit('status', { id, status: 'running' });
      }
      // Track Chunky pre-generation progress.
      if (this.pregen[id] && /Chunky/i.test(text)) {
        const pm = text.match(/(\d+(?:\.\d+)?)%/);
        const done = /finished|Task stopped|complete\b/i.test(text);
        this.emit('pregen', { id, percent: pm ? Number(pm[1]) : null, line: text.trim(), done });
        if (done) this.pregen[id] = null;
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      this.emit('console', { id, text: `\n[Server process exited with code ${code}]\n` });
      delete this.running[id];
      this.stopTunnel(id);
      this.emit('status', { id, status: 'stopped' });
    });
    proc.on('error', (err) => {
      this.emit('console', { id, text: `\n[Failed to launch java: ${err.message}]\n${installHint()}\n` });
      delete this.running[id];
      this.stopTunnel(id);
      this.emit('status', { id, status: 'stopped' });
    });
  }

  sendCommand(id, command) {
    const r = this.running[id];
    if (!r || !r.proc.stdin.writable) return;
    r.proc.stdin.write(command + '\n');
  }

  async stop(id, force = false) {
    const r = this.running[id];
    if (!r) return;
    if (force) {
      r.proc.kill('SIGKILL');
      return;
    }
    this.emit('status', { id, status: 'stopping' });
    r.status = 'stopping';
    if (r.proc.stdin.writable) r.proc.stdin.write('stop\n');
    // Fallback hard-kill if it doesn't exit in 15s.
    setTimeout(() => { if (this.running[id]) this.running[id].proc.kill('SIGKILL'); }, 15000);
  }
}

module.exports = { ServerManager };
