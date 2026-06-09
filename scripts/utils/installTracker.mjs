/**
 * Install tracking utility for combat-spell-timer.
 *
 * Posts a one-time install record to the public install-tracker API when the
 * module loads in a Foundry world. The record is re-sent when the module
 * version changes (treating an upgrade as a new install). Failed sends are
 * retried up to MAX_ATTEMPTS times across world loads, then silently abandoned.
 *
 * NOTE: The API key below is NOT a security boundary. It is visible to anyone
 * who reads this source and exists solely to let the public endpoint reject
 * obvious unauthenticated spam. Do not treat it as a secret.
 */

import { dbg } from "./debug.mjs";

const MODULE_ID = "combat-spell-timer";
const SETTING_KEY = "installTracker";
const ENDPOINT = "https://foundry.turkeysunite-local.org/module-install";
// Not a security boundary — anyone reading module source can extract this.
// It exists only to let the public endpoint reject obvious unauthenticated spam.
const API_KEY = "1d1075fcabbb5e3e6757f7cc80c229cf4234b1dc226acd91c5d284d3380e0295";
const MAX_ATTEMPTS = 3;

const DEFAULT_STATE = Object.freeze({
  sent: false,
  version: null,
  attempts: 0,
  lastError: null
});

/**
 * Register the hidden world-scoped setting that persists install-tracker state.
 * Call once from the module's `init` hook alongside other settings registrations.
 */
export function registerInstallTrackerSetting() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: { ...DEFAULT_STATE }
  });
}

/**
 * Send the install record if the current world+version hasn't been recorded
 * yet (and we haven't exhausted retry attempts). No-op for non-active-GM
 * sessions. Call once from the module's `ready` hook.
 */
export async function maybeSendInstallRecord() {
  if (!game.user.isActiveGM) {
    dbg("install:maybeSend", "skipping — not active GM");
    return;
  }

  const state = _readState();
  const currentVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";

  if (!_shouldSendInstallRecord(state, currentVersion)) {
    dbg("install:maybeSend", "skipping — already recorded or retries exhausted", {
      sent: state.sent, storedVersion: state.version,
      currentVersion, attempts: state.attempts
    });
    return;
  }

  // Version differs from the stored version → reset attempt counter so an
  // upgrade always gets a fresh 3 tries regardless of prior failure history.
  const attemptsForThisVersion = state.version === currentVersion ? state.attempts : 0;
  // updated = true only when a prior version was recorded and the version has changed.
  // A completely fresh install (state.version === null) sends updated: false.
  const updated = state.version !== null && state.version !== currentVersion;
  const payload = _buildPayload(currentVersion, updated);
  dbg("install:maybeSend", "posting install record", {
    endpoint: ENDPOINT, payload, attempt: attemptsForThisVersion + 1
  });

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-install-tracker-key": API_KEY
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    await _writeState({ sent: true, version: currentVersion, attempts: attemptsForThisVersion + 1, lastError: null });
    dbg("install:maybeSend", "install record posted successfully");
  } catch (err) {
    const newAttempts = attemptsForThisVersion + 1;
    const message = err?.message ?? String(err);
    await _writeState({ sent: false, version: currentVersion, attempts: newAttempts, lastError: message });
    dbg("install:maybeSend", "install record post failed", { error: message, attempts: newAttempts, max: MAX_ATTEMPTS });
    if (newAttempts >= MAX_ATTEMPTS) {
      console.warn(`${MODULE_ID} | Install tracking gave up after ${MAX_ATTEMPTS} failed attempts: ${message}`);
    }
  }
}

function _shouldSendInstallRecord(state, currentVersion) {
  if (state.sent && state.version === currentVersion) return false;
  if (!state.sent && state.version === currentVersion && state.attempts >= MAX_ATTEMPTS) return false;
  return true;
}

function _buildPayload(moduleVersion, updated) {
  return {
    moduleId: MODULE_ID,
    system: game.system.id,
    systemVersion: game.system.version,
    foundryVersion: game.version,
    worldId: game.world.id,
    moduleVersion,
    updated
  };
}

function _readState() {
  const raw = game.settings.get(MODULE_ID, SETTING_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...raw };
}

async function _writeState(state) {
  await game.settings.set(MODULE_ID, SETTING_KEY, state);
}
