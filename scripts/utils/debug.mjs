const MODULE_ID = "combat-spell-timer";

/**
 * Write a debug log when the debugLogging module setting is enabled.
 * Safe to call before the setting is registered — silently suppressed if so.
 * Tag convention: "subsystem:action".
 * @param {string} tag
 * @param {...any} args
 */
export function dbg(tag, ...args) {
  if (!game.settings?.settings?.has(`${MODULE_ID}.debugLogging`)) return;
  if (!game.settings.get(MODULE_ID, "debugLogging")) return;
  console.log(`[${MODULE_ID}] ${tag}`, ...args);
}
