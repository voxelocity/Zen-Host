'use strict';

// Finding a Java runtime is the one genuinely platform-specific part of Zen Host.
// A GUI app launched from Finder, a .desktop launcher or an AppImage does not
// inherit the user's login-shell PATH, so spawning a bare `java` works when the
// app is started from a terminal and mysteriously fails when it isn't. This
// module resolves a real java executable up front and caches it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

let cached;

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
  return process.env.JAVA_HOME ? launcherIn(process.env.JAVA_HOME) : null;
}

function fromPath() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, EXE);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

// macOS ships a helper that reports the newest installed JDK, and it works even
// when PATH is bare. /usr/bin/java itself is only a stub that pops a dialog.
function fromMacJavaHomeTool() {
  if (process.platform !== 'darwin') return null;
  try {
    const home = execFileSync('/usr/libexec/java_home', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return home ? launcherIn(home) : null;
  } catch {
    return null;
  }
}

// Install roots a GUI app can't reach through PATH. Newest-looking entries are
// tried first so a modern Minecraft gets a modern JVM.
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
  return [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'jdk'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Zulu'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Java'),
  ];
}

// Sort so that higher version numbers come first: jdk-21 beats jdk-8.
function byVersionDesc(a, b) {
  const num = (s) => Number((s.match(/(\d+)/) || [0, 0])[1]);
  return num(b) - num(a) || b.localeCompare(a);
}

function fromWellKnownDirs() {
  for (const root of wellKnownRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
        .filter((n) => /jdk|jre|java|zulu|temurin|corretto|graal|openjdk/i.test(n))
        .sort(byVersionDesc);
    } catch {
      continue;
    }
    for (const name of entries) {
      const found = launcherIn(path.join(root, name));
      if (found) return found;
    }
  }
  return null;
}

// The resolved java executable, or null when there is no usable runtime.
function findJava() {
  if (cached !== undefined) return cached;
  cached = fromJavaHome()
    || fromMacJavaHomeTool()
    || fromPath()
    || fromWellKnownDirs()
    || null;
  return cached;
}

// Path to spawn. Throws with a platform-appropriate hint when Java is missing,
// which is far more useful than the raw ENOENT the spawn would produce.
function javaBin() {
  const found = findJava();
  if (found) return found;
  throw new Error(`No Java runtime found. ${installHint()}`);
}

function installHint() {
  if (process.platform === 'darwin') {
    return 'Install a JDK 21 (for example: brew install --cask temurin) and reopen Zen Host.';
  }
  if (process.platform === 'linux') {
    return 'Install a JDK 21 from your package manager (for example: sudo apt install openjdk-21-jre-headless).';
  }
  return 'Install a JDK 21 from adoptium.net and reopen Zen Host.';
}

// `java -version` reports on stderr, not stdout, so both streams are captured.
// Used only for the diagnostics readout.
function javaVersion() {
  const bin = findJava();
  if (!bin) return null;
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10000 });
  if (res.error) return null;
  const text = `${res.stderr || ''}${res.stdout || ''}`.trim();
  return text.split('\n')[0].trim() || null;
}

function resetCache() { cached = undefined; }

module.exports = { findJava, javaBin, javaVersion, installHint, resetCache };
