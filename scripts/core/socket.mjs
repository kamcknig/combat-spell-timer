import { SOCKET, MODULE_ID } from "../module.mjs";
import { gmAddTimer, gmRemoveTimers, gmPruneExpired, gmSetInitiative, gmSetTimerInitiative } from "./store.mjs";
import { getAdapter } from "../adapter/index.mjs";
import { dbg } from "../utils/debug.mjs";

/** True if this client should perform Combat writes (the single active GM). */
export function isWriter() {
  return game.users?.activeGM?.isSelf ?? false;
}

/** Register the GM-side socket listener. Call once on ready. */
export function registerSocket() {
  game.socket.on(SOCKET, (msg) => {
    if (!isWriter()) return; // only the active GM acts
    handle(msg);
  });
}

async function handle(msg) {
  dbg("socket:handle", msg?.action, msg?.combatId);
  switch (msg?.action) {
    case "add":    return gmAddTimer(msg.combatId, msg.record);
    case "remove": return gmRemoveTimers(msg.combatId, msg.query);
    case "initiative": return gmSetInitiative(msg.combatId, msg.combatantId, msg.initiative);
    case "timer-initiative": return gmSetTimerInitiative(msg.combatId, msg.timerId, msg.initiative);
    case "prune": {
      const expired = await gmPruneExpired(msg.combatId);
      for (const t of expired) getAdapter().onTimerExpired(t);
      return;
    }
  }
}

/** Run a write locally if we're the active GM, else ask the GM over the socket. */
export function requestWrite(msg) {
  if (isWriter()) return handle(msg);
  dbg("socket:emit", msg?.action, msg?.combatId);
  game.socket.emit(SOCKET, msg);
}

/** Public helpers used by core. */
export const addTimer     = (combatId, record) => requestWrite({ action: "add", combatId, record });
export const removeTimers = (combatId, query)  => requestWrite({ action: "remove", combatId, query });
export const pruneExpired = (combatId)         => requestWrite({ action: "prune", combatId });
export const setInitiative = (combatId, combatantId, initiative) =>
  requestWrite({ action: "initiative", combatId, combatantId, initiative });
export const setTimerInitiative = (combatId, timerId, initiative) =>
  requestWrite({ action: "timer-initiative", combatId, timerId, initiative });
