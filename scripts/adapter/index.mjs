/** @type {import("./SystemAdapter.mjs").default|null} */
let _adapter = null;

/**
 * Resolve the adapter for the active Foundry system. Idempotent. Dynamically
 * imports `./<systemId>/index.mjs` so only the active system's code loads.
 * Throws if no adapter exists for the system (today: dnd5e only).
 * @returns {Promise<import("./SystemAdapter.mjs").default>}
 */
export async function loadAdapter() {
  if (_adapter) return _adapter;
  const systemId = game.system?.id;
  if (!systemId) throw new Error("combat-spell-timer: game.system unavailable at load time");
  const mod = await import(`./${systemId}/index.mjs`); // no generic fallback yet — dnd5e only
  _adapter = new mod.default();
  return _adapter;
}

/**
 * Synchronous accessor; throws if called before loadAdapter() resolved.
 * @returns {import("./SystemAdapter.mjs").default}
 */
export function getAdapter() {
  if (!_adapter) throw new Error("combat-spell-timer: getAdapter() called before loadAdapter() resolved");
  return _adapter;
}
