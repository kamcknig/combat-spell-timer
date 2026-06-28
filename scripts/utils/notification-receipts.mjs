/**
 * Read-receipt store for module notifications.
 *
 * Persists which notifications have been acknowledged, in a hidden world-scoped
 * setting, so a notification keyed off a receipt is only shown until dismissed.
 * Two scopes are supported and each notification picks one:
 *  - "global": one flag per key — once any GM acknowledges, suppressed world-wide.
 *  - "gm" (alias "user"): per-user flag — each GM acknowledges for themselves.
 *
 * World-scoped writes require a GM; the only callers today are GM-gated.
 */

import { MODULE_ID } from "../module.mjs";
import { dbg } from "./debug.mjs";

const SETTING_KEY = "notificationReceipts";

const DEFAULT_STATE = Object.freeze({ global: {}, byUser: {} });

/** Register the hidden world-scoped receipt store. Call once from `init`. */
export function registerNotificationReceiptsSetting() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: foundry.utils.deepClone(DEFAULT_STATE)
  });
}

function _read() {
  const raw = game.settings.get(MODULE_ID, SETTING_KEY);
  return foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_STATE), raw ?? {}, { inplace: false });
}

const _isUserScope = (scope) => scope === "gm" || scope === "user";

/**
 * Has this notification key been acknowledged for the given scope?
 * @param {string} key
 * @param {"global"|"gm"} [scope="global"]
 * @returns {boolean}
 */
export function hasSeen(key, scope = "global") {
  const state = _read();
  return _isUserScope(scope)
    ? !!state.byUser?.[game.user.id]?.[key]
    : !!state.global?.[key];
}

/**
 * Record an acknowledgement. World-scoped write → requires a GM.
 * @param {string} key
 * @param {"global"|"gm"} [scope="global"]
 */
export async function markSeen(key, scope = "global") {
  const state = _read();
  if (_isUserScope(scope)) {
    state.byUser[game.user.id] ??= {};
    state.byUser[game.user.id][key] = true;
  } else {
    state.global[key] = true;
  }
  dbg("receipts:markSeen", `${scope}:${key}`);
  await game.settings.set(MODULE_ID, SETTING_KEY, state);
}
