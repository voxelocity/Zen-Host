'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const { ServerManager } = require('./src/serverManager');
const downloads = require('./src/downloads');
const { findJava, javaVersion, installHint } = require('./src/java');

const isMac = process.platform === 'darwin';

let win;
let splash;
let manager;

// A lightweight branded splash shown immediately so the user gets instant feedback
// while Electron and the main window finish loading.
function createSplash() {
  splash = new BrowserWindow({
    width: 440,
    height: 300,
    frame: false,
    resizable: false,
    movable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#0a0c12',
    title: 'Zen Host',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,                 // stay hidden until the UI has painted
    backgroundColor: '#0a0c12',
    title: 'Zen Host',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Windows/Linux get a chrome-free window. macOS keeps its application menu —
  // removing it would take Cmd+Q, Cmd+W and clipboard shortcuts with it.
  if (!isMac) win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Reveal the main window only once it's ready to paint, then drop the splash.
  // Hold the splash a minimum time so it registers instead of flashing past.
  const startedAt = Date.now();
  const MIN_SPLASH_MS = 900;
  const reveal = () => {
    if (!win || win.isDestroyed() || win.isVisible()) return;
    const wait = Math.max(0, MIN_SPLASH_MS - (Date.now() - startedAt));
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.isVisible()) return;
      win.show();
      win.focus();
      closeSplash();
    }, wait);
  };
  win.once('ready-to-show', reveal);
  // Safety net: never leave the user stuck on the splash if ready-to-show is missed.
  setTimeout(reveal, 12000);
}

// macOS shows an application menu whether or not the app defines one, so give it
// a real menu with the standard edit shortcuts wired up.
function buildMacMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Server Folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ]));
}

app.whenReady().then(() => {
  const serversRoot = path.join(app.getPath('userData'), 'servers');
  manager = new ServerManager(serversRoot);
  manager.emit = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('event', { channel, payload });
  };

  if (isMac) buildMacMenu();
  createSplash();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On macOS closing the window doesn't quit the app, so leave servers running.
  if (!isMac) app.quit();
});

// Never leave orphaned java processes behind, whichever way the app is quit.
app.on('before-quit', () => {
  if (!manager) return;
  for (const s of manager.list()) {
    if (s.status !== 'stopped') manager.stop(s.id, true);
  }
});

// ---- IPC -------------------------------------------------------------------

const handlers = {
  'servers:list': () => manager.list(),
  'servers:get': (id) => manager.get(id),
  'servers:create': (opts) => manager.create(opts),
  'servers:delete': (id) => manager.delete(id),
  'servers:rename': ({ id, name }) => manager.rename(id, name),
  'servers:start': (id) => manager.start(id),
  'servers:stop': (id) => manager.stop(id),
  'servers:command': ({ id, command }) => manager.sendCommand(id, command),
  'servers:acceptEula': (id) => manager.acceptEula(id),
  'servers:openFolder': (id) => shell.openPath(manager.dir(id)),

  'props:read': (id) => manager.readProperties(id),
  'props:write': ({ id, props }) => manager.writeProperties(id, props),

  'net:info': (id) => manager.connectionInfo(id),
  'servers:setPublic': ({ id, enabled }) => manager.setPublic(id, enabled),
  'clipboard:write': (text) => { clipboard.writeText(String(text)); return true; },

  'farrender:installed': (id) => manager.farRenderInstalled(id),
  'farrender:install': (id) => manager.installFarRender(id),
  'farrender:pregen': ({ id, radius }) => manager.pregenerate(id, radius),
  'farrender:cancel': (id) => manager.cancelPregen(id),

  'ops:list': (id) => manager.listOps(id),
  'ops:add': ({ id, name, level }) => manager.addOp(id, name, level),
  'ops:remove': ({ id, uuid }) => manager.removeOp(id, uuid),

  'mods:list': (id) => manager.listMods(id),
  'mods:add': ({ id, paths }) => manager.addMods(id, paths),
  'mods:toggle': ({ id, file }) => manager.toggleMod(id, file),
  'mods:delete': ({ id, file }) => manager.deleteMod(id, file),

  'versions:list': (type) => downloads.listVersions(type),

  'java:check': () => {
    const bin = findJava();
    return { found: !!bin, path: bin, version: bin ? javaVersion() : null, hint: installHint() };
  },

  'dialog:pickMods': async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Select mod .jar files',
      filters: [{ name: 'Mod jars', extensions: ['jar'] }],
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  },
};

ipcMain.handle('invoke', async (_evt, { channel, payload }) => {
  const fn = handlers[channel];
  if (!fn) throw new Error(`Unknown channel: ${channel}`);
  try {
    return { ok: true, data: await fn(payload) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
