'use strict';

// Tells the user when this copy of Zen Host is probably out of date. Two signals
// raise the warning in the UI:
//   - GitHub has a newer release than the running version (checked at launch), or
//   - a Minecraft download service answered in a way this build doesn't
//     understand (see http.js) — usually an API change that a newer Zen Host
//     already handles.

const { getJson } = require('./http');
const { compareVersions } = require('./versions');

const DOWNLOAD_PAGE = 'https://voxelocity.github.io/Zen-Host/';
const OUTDATED_MESSAGE = `This version of Zen Host is most likely out of date. Download the latest version at: ${DOWNLOAD_PAGE}`;
const LATEST_RELEASE = 'https://api.github.com/repos/voxelocity/Zen-Host/releases/latest';

// Resolves to { current, latest, outdated }. Never rejects: being offline or
// rate-limited by GitHub just means no warning.
async function checkForUpdate(current) {
  try {
    const release = await getJson(LATEST_RELEASE, 'GitHub');
    const latest = String((release && release.tag_name) || '').replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(latest)) return { current, latest: null, outdated: false };
    return { current, latest, outdated: compareVersions(latest, current) > 0 };
  } catch {
    return { current, latest: null, outdated: false };
  }
}

module.exports = { DOWNLOAD_PAGE, OUTDATED_MESSAGE, checkForUpdate };
