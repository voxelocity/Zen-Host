'use strict';

// Finding a Java runtime is the one genuinely platform-specific part of Zen Host.
// A GUI app launched from Finder, a .desktop launcher or an AppImage does not
// inherit the user's login-shell PATH, so spawning a bare `java` works when the
// app is started from a terminal and mysteriously fails when it isn't. This
// module finds every installed runtime and picks one new enough for the
// Minecraft version being run (Minecraft 26.x needs Java 25, 1.20.5+ needs 21…).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

// The Java that the newest Minecraft releases need. Used in install hints.
const LATEST_JAVA = 25;

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A JDK/JRE directory exposes its launcher in one of a few standard layouts.
function launcherIn(home) {
  const candidates = [
    path.join(home, 'bin', EXE),               // normal JDK layout
    path.join(home, 'Contents', 'Home', 'bin', EXE), // macOS .jdk bundle
    path.join(home, 'jre', 'bin', EXE),        // old JDKs with a bundled JRE
  ];
  return candidates.find(isExecutableFile) || null;
}

function fromJavaHome() {
  return process.env.JAVA_HOME ? [launcherIn(process.env.JAVA_HOME)] : [];
}

function fromPath() {
  const found = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, EXE);
    // macOS's /usr/bin/java is a stub that pops an "install Java" dialog; the
    // real JDKs behind it are found through java_home instead.
    if (process.platform === 'darwin' && p === '/usr/bin/java') continue;
    if (isExecutableFile(p)) found.push(p);
  }
  return found;
}

// macOS ships a helper that reports the newest installed JDK, and it works even
// when PATH is bare. /usr/bin/java itself is only a stub that pops a dialog.
function fromMacJavaHomeTool() {
  if (process.platform !== 'darwin') return [];
  try {
    const home = execFileSync('/usr/libexec/java_home', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return home ? [launcherIn(home)] : [];
  } catch {
    return [];
  }
}

// Install roots a GUI app can't reach through PATH.
function wellKnownRoots() {
  if (process.platform === 'darwin') {
    return [
      '/Library/Java/JavaVirtualMachines',
      path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
      '/opt/homebrew/opt',          // brew on Apple Silicon
      '/usr/local/opt',             // brew on Intel
      '/Applications/Zulu',
    ];
  }
  if (process.platform === 'linux') {
    return ['/usr/lib/jvm', '/usr/lib64/jvm', '/opt/java', '/opt/jdk', '/snap'];
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  return [
    path.join(pf, 'Java'),
    path.join(pf, 'Eclipse Adoptium'),
    path.join(pf, 'Microsoft'),           // Microsoft Build of OpenJDK: jdk-21.0.x…
    path.join(pf, 'Zulu'),
    path.join(pf, 'Amazon Corretto'),
    path.join(pf, 'BellSoft'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Java'),
    path.join(os.homedir(), '.jdks'),     // IntelliJ-downloaded JDKs
  ];
}

function fromWellKnownDirs() {
  const found = [];
  for (const root of wellKnownRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
        .filter((n) => /jdk|jre|java|zulu|temurin|corretto|graal|openjdk|liberica/i.test(n));
    } catch {
      continue;
    }
    for (const name of entries) {
      const bin = launcherIn(path.join(root, name));
      if (bin) found.push(bin);
    }
  }
  return found;
}

// Every distinct java launcher on this machine, in preference order.
function discover() {
  const seen = new Set();
  const out = [];
  for (const p of [...fromJavaHome(), ...fromMacJavaHomeTool(), ...fromPath(), ...fromWellKnownDirs()]) {
    if (!p) continue;
    let key = p;
    try { key = fs.realpathSync(p); } catch {}
    if (process.platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// "1.8.0_402" -> 8, "21.0.5" -> 21, "25" -> 25
function majorOf(versionString) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(versionString || '');
  if (!m) return null;
  return m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
}

// A JDK's `release` file states its version without having to start a JVM.
function majorFromReleaseFile(bin) {
  const home = path.dirname(path.dirname(bin));
  try {
    const text = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const m = /^JAVA_VERSION="([^"]+)"/m.exec(text);
    return m ? majorOf(m[1]) : null;
  } catch {
    return null;
  }
}

// `java -version` reports on stderr, not stdout, so both streams are captured.
function runVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stderr || ''}${stdout || ''}`.trim();
      resolve(err && !text ? null : text);
    });
  });
}

const _versions = new Map(); // launcher path -> { major, line }

async function describe(bin) {
  if (_versions.has(bin)) return _versions.get(bin);
  let major = majorFromReleaseFile(bin);
  let line = null;
  if (!major) {
    const text = await runVersion(bin);
    line = text ? text.split('\n')[0].trim() : null;
    const m = text && /version "([^"]+)"/.exec(text);
    major = m ? majorOf(m[1]) : null;
  }
  const info = { path: bin, major, line: line || (major ? `Java ${major}` : null) };
  _versions.set(bin, info);
  return info;
}

// All runtimes with their major versions. Re-scanned on every call, so a Java
// installed while Zen Host is open is picked up without a restart.
async function listJavas() {
  return Promise.all(discover().map(describe));
}

// Path to the java to run a server with. Picks the oldest runtime that is new
// enough — that is what the official launcher does, and old Forge versions break
// on much newer Java. Throws a readable, platform-specific error otherwise.
async function javaFor(minMajor, mcVersion) {
  const javas = await listJavas();
  const label = mcVersion ? `Minecraft ${mcVersion}` : 'This server';
  if (!javas.length) {
    throw new Error(`No Java runtime found. ${label} needs Java ${minMajor || LATEST_JAVA}. ${installHint(minMajor)}`);
  }
  const need = minMajor || 0;
  const fits = javas.filter((j) => j.major && j.major >= need).sort((a, b) => a.major - b.major);
  if (fits.length) return fits[0].path;

  // A runtime whose version couldn't be read may still work; let it try.
  const unknown = javas.find((j) => !j.major);
  if (unknown) return unknown.path;

  const newest = javas.reduce((a, b) => (b.major > a.major ? b : a));
  throw new Error(`${label} needs Java ${need} or newer, but the newest Java on this computer is Java ${newest.major}. ${installHint(need)}`);
}

function installHint(major = LATEST_JAVA) {
  if (process.platform === 'darwin') {
    return `Install a JDK ${major} (for example: brew install --cask temurin@${major}), then try again.`;
  }
  if (process.platform === 'linux') {
    return `Install a JDK ${major} from your package manager (for example: sudo apt install openjdk-${major}-jre-headless), then try again.`;
  }
  return `Install a JDK ${major} from adoptium.net, then try again.`;
}

module.exports = { listJavas, javaFor, installHint, LATEST_JAVA };
