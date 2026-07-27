# 🟩 Zen Host

A desktop app to create, host, and manage your own Minecraft **Java Edition** servers with a friendly visual UI — a dashboard with a copyable connect address, drag-and-drop mods, visual world/operator settings, and a live console. No command line required.

![Electron desktop app](https://img.shields.io/badge/Electron-desktop-3ddc84)
![Windows | macOS | Linux](https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-x64%20%2B%20arm64-4fc3ff)

## Features

- **One-click server creation** — pick a type, a version, and how much RAM to give it. The right server (or mod-loader installer) is fetched automatically with a progress bar.
- **Five server types:**
  - **Vanilla** — pure Minecraft from Mojang.
  - **Paper** — high-performance, plugin-ready.
  - **Fabric** — lightweight modding, with drag-and-drop mods.
  - **Forge / NeoForge** — modded (installer is run automatically; drag-and-drop mods).
- **Drag-and-drop mods** — drop `.jar` mod files straight into the Mods tab. Enable/disable with a toggle or delete them.
- **Visual settings editor** — `server.properties` shown as toggles, dropdowns, and sliders grouped by category (Gameplay, World, Network, Performance…). No hand-editing text files.
- **Public tunnel** — expose a server to the internet through `bore.pub` with no router config, implemented as a pure-Node client (no bundled binary).
- **Live console** — real-time server output with command input (`say`, `op`, `weather clear`, `stop`, etc.).
- **Operators** — grant admin by username; the UUID is resolved and `ops.json` written for you.
- **EULA handling** — prompts you to accept Mojang's EULA on first start.

## Downloads

Grab a build from the [Releases page](https://github.com/voxelocity/Zen-Host/releases).

| Platform | Architectures | Formats |
| --- | --- | --- |
| Windows 10/11 | x64, arm64 | `.exe` installer (NSIS), `.zip` portable |
| macOS 11+ | Apple Silicon (arm64), Intel (x64) | `.dmg`, `.zip` |
| Linux | x64, arm64 | `.AppImage`, `.deb`, `.tar.gz` |

### Platform notes

**macOS** — builds are not code-signed or notarized, so the first launch is blocked by
Gatekeeper. Right-click the app → **Open** → **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Zen Host.app"
```

**Linux** — make the AppImage executable before running it:

```bash
chmod +x "Zen Host-0.1.0-linux-x86_64.AppImage"
```

The `.deb` pulls in the usual Electron runtime libraries. For the `.tar.gz`, extract
it and run the `zen-host` binary directly.

## Requirements

Zen Host bundles everything it needs to run **except Java**, which actually hosts the
Minecraft server. Install a JDK **21** (Minecraft 1.20.5+ requires 21; older versions
are happy with 17):

| Platform | Install |
| --- | --- |
| Windows | [adoptium.net](https://adoptium.net) |
| macOS | `brew install --cask temurin` |
| Debian/Ubuntu | `sudo apt install openjdk-21-jre-headless` |
| Fedora | `sudo dnf install java-21-openjdk-headless` |
| Arch | `sudo pacman -S jre21-openjdk-headless` |

Zen Host finds Java via `JAVA_HOME`, `/usr/libexec/java_home` (macOS), your `PATH`, and
the standard install directories — so it works even when launched from Finder or a
desktop launcher, which don't inherit your shell's `PATH`.

## Running it (development)

```bash
npm install
npm start
```

## Building

```bash
npm run dist:win     # Windows   x64 + arm64
npm run dist:mac     # macOS     x64 + arm64
npm run dist:linux   # Linux     x64 + arm64
```

Output lands in `dist/`. The app icon is generated from `build/zenlogo.png` by
`npm run icons` (writes `build/icon.ico` and a 512×512 `build/icon.png`, from which
electron-builder derives the macOS `.icns` and the Linux icon set).

> **Cross-compiling has hard limits.** macOS `.dmg` builds require macOS. Linux
> `.deb` requires `fpm`, and `.AppImage` requires symlink privileges — neither is
> available on Windows. From Windows you can build all Windows targets plus the
> Linux `.tar.gz`. The [GitHub Actions workflow](.github/workflows/build.yml) builds
> every target on native runners, including real arm64 Linux hardware; pushing a
> `v*` tag publishes them all to a GitHub Release.

## How servers are stored

Each server lives in its own folder under the app's user-data directory:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\zen-host\servers\<id>\` |
| macOS | `~/Library/Application Support/zen-host/servers/<id>/` |
| Linux | `~/.config/zen-host/servers/<id>/` |

That folder contains the server jar, `server.properties`, the `world`, and (for modded
types) a `mods` folder — exactly like a normal Minecraft server, so you can back it up
or move it anywhere.

## Connecting to your server

Once a server shows **running**, connect from Minecraft with `localhost` (same machine)
or your LAN IP. Leaving a server **public** gives you a `bore.pub:<port>` address that
friends can join from anywhere without port-forwarding.

## Project layout

```
main.js              Electron main process + IPC wiring
preload.js           Secure bridge (api.invoke / api.on / pathForFile)
src/java.js          Cross-platform Java runtime discovery
src/downloads.js     Mojang / Paper / Fabric APIs + streamed jar download
src/serverManager.js Server store, java process lifecycle, mods, properties
src/properties.js    server.properties metadata + parser
src/tunnel.js        Pure-Node bore tunnel client
src/players.js       Username → UUID resolution for ops
src/modrinth.js      Modrinth lookups for the far-render mods
renderer/            UI (index.html, styles.css, renderer.js)
```

## License

MIT — see [LICENSE](LICENSE).
