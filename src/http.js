'use strict';

// Shared HTTP helpers for every outside service Zen Host talks to (Mojang,
// PaperMC, Fabric, Forge, NeoForge, Modrinth, GitHub).
//
// Failures are sorted into two kinds so the UI can react sensibly:
//   - the service couldn't be reached, or is down / rate limiting  -> plain error
//   - the service answered, but not in a way this build understands  -> "outdated"
// The second kind almost always means the service changed its API after this
// version of Zen Host was released, so the UI tells the user to update.

const { version } = require('../package.json');

const USER_AGENT = `Zen-Host/${version} (+https://github.com/voxelocity/Zen-Host)`;

// An error that most likely means this build of Zen Host is out of date.
function outdatedError(message) {
  const err = new Error(message);
  err.outdated = true;
  return err;
}

// fetch() that throws a readable error instead of a bare "fetch failed".
// `allow` lists non-2xx statuses the caller wants to handle itself (e.g. 404).
async function request(url, service, { allow = [] } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch {
    throw new Error(`Couldn't reach ${service}. Check your internet connection and try again.`);
  }
  if (res.ok || allow.includes(res.status)) return res;
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`${service} is having problems right now (HTTP ${res.status}). Try again in a few minutes.`);
  }
  throw outdatedError(`${service} rejected the request (HTTP ${res.status}).`);
}

async function getJson(url, service, opts) {
  const res = await request(url, service, opts);
  if (!res.ok) return null; // an allowed status
  try {
    return await res.json();
  } catch {
    throw outdatedError(`${service} sent a response Zen Host doesn't understand.`);
  }
}

async function getText(url, service, opts) {
  const res = await request(url, service, opts);
  return res.ok ? res.text() : null;
}

// Runs `fn(data)` to pull fields out of an API response. If the response no
// longer has the shape this build expects, the TypeError becomes an
// "outdated" error rather than a confusing "cannot read properties of undefined".
function parse(service, data, fn) {
  try {
    return fn(data);
  } catch (err) {
    if (err.outdated) throw err;
    throw outdatedError(`${service} sent a response Zen Host doesn't understand.`);
  }
}

module.exports = { USER_AGENT, outdatedError, request, getJson, getText, parse };
