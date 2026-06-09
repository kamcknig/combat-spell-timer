import { MODULE_ID } from "../module.mjs";
import { dbg } from "../utils/debug.mjs";

// Timer record shape (all fields stored in combat flags as plain objects):
//   type:             featureId (e.g. "rage") or omitted/undefined for spells
//   effectUuid:       UUID of the module-owned AE on the actor (feature timers only)
//   anchorToOwner:    true → row is anchored to the owner; no initiative stamping/input

const FLAG = "timers";

/** @returns {object[]} The timer records on a combat (never null). */
export function getTimers(combat) {
  return combat?.getFlag(MODULE_ID, FLAG) ?? [];
}

/**
 * A combatant's initiative as a sortable number, matching Foundry's own turn
 * ordering: a missing/non-numeric initiative sorts last (-Infinity).
 * @param {Combatant} c
 * @returns {number}
 */
export function effInit(c) {
  return Number.isNumeric(c?.initiative) ? c.initiative : -Infinity;
}

/**
 * The turn-order index at which a timer sits — i.e. how many combatants come
 * before its row. Derived from the timer's own initiative: the row is placed
 * above every combatant tied at its initiative, so the slot is the index of the
 * first combatant ranked at or below it.
 *
 * While a timer has no initiative yet (cast before the owner rolled), we fall
 * back to the owner's current turn index so the countdown still tracks them.
 * @param {object} record  Timer record.
 * @param {Combat} combat
 * @returns {number}
 */
function timerSlot(record, combat) {
  const turns = combat?.turns ?? [];
  if (record.initiative != null) {
    const idx = turns.findIndex(c => effInit(c) <= record.initiative);
    return idx === -1 ? turns.length : idx;
  }
  const ownerIdx = turns.findIndex(c => c.id === record.casterCombatantId);
  return ownerIdx === -1 ? 0 : ownerIdx;
}

/**
 * Remaining whole rounds for a timer in a given combat.
 *
 * Countdown is turn-based: one round elapses when, in a later round, the active
 * turn reaches a combatant whose initiative is at or below the timer's (i.e.
 * the turn marker passes the timer's row). Until that slot is reached in a
 * round, one fewer round has elapsed.
 *
 * currentRound is clamped to castRound so a spell cast before combat starts
 * (round 0 → castRound 1) shows full duration until round 1.
 * @returns {number}
 */
export function remainingRounds(record, combat) {
  const currentRound = Math.max(combat?.round ?? record.castRound, record.castRound);
  const currentTurn = combat?.turn ?? 0;
  const slot = timerSlot(record, combat);
  let elapsed = currentRound - record.castRound;
  // In a later round, until the active turn reaches the timer's slot the row's
  // milestone hasn't triggered — one fewer round has elapsed.
  if (currentRound > record.castRound && currentTurn < slot) elapsed -= 1;
  return record.durationRounds - elapsed;
}

/** Persist the full timer array on the combat (GM context only). */
async function writeTimers(combat, timers) {
  // Use {diff:false} so replacing the whole array always propagates a re-render.
  return combat.setFlag(MODULE_ID, FLAG, timers);
}

/** GM-side: append a fully-stamped record. */
export async function gmAddTimer(combatId, record) {
  const combat = game.combats.get(combatId);
  if (!combat) return;
  dbg("store:add", record.name, combatId);
  await writeTimers(combat, [...getTimers(combat), record]);
}

/**
 * GM-side: stamp `initiative` onto every timer for `combatantId` that doesn't
 * already have one. Used to copy the owner's freshly-rolled initiative onto a
 * spell cast before they joined the order. No-op if nothing changes.
 */
export async function gmSetInitiative(combatId, combatantId, initiative) {
  const combat = game.combats.get(combatId);
  if (!combat) return;
  const timers = getTimers(combat);
  let changed = false;
  const next = timers.map(t => {
    if (t.casterCombatantId === combatantId && t.initiative == null && !t.anchorToOwner) {
      changed = true;
      return { ...t, initiative };
    }
    return t;
  });
  if (changed) {
    dbg("store:set-initiative", combatantId, initiative, combatId);
    await writeTimers(combat, next);
  }
}

/**
 * GM-side: set `initiative` on a single timer (by id), overwriting any existing
 * value. Used when the user edits a timer row's initiative input directly. A
 * null value clears it (the row drifts back beneath its owner). No-op if
 * unchanged.
 */
export async function gmSetTimerInitiative(combatId, timerId, initiative) {
  const combat = game.combats.get(combatId);
  if (!combat) return;
  const timers = getTimers(combat);
  let changed = false;
  const next = timers.map(t => {
    if (t.id === timerId && t.initiative !== initiative) {
      changed = true;
      return { ...t, initiative };
    }
    return t;
  });
  if (changed) {
    dbg("store:timer-initiative", timerId, initiative, combatId);
    await writeTimers(combat, next);
  }
}

/**
 * GM-side: set a single timer's remaining rounds (by id) to `rounds`. Adjusts
 * `durationRounds` by the delta between the desired and current remaining so
 * `remainingRounds` returns exactly `rounds` next render. No-op if unchanged.
 * @returns {object|null} The updated timer record, or null if nothing changed.
 */
export async function gmSetTimerRounds(combatId, timerId, rounds) {
  const combat = game.combats.get(combatId);
  if (!combat) return null;
  const timers = getTimers(combat);
  let updated = null;
  const next = timers.map(t => {
    if (t.id !== timerId) return t;
    const durationRounds = t.durationRounds + (rounds - remainingRounds(t, combat));
    if (durationRounds === t.durationRounds) return t;
    updated = { ...t, durationRounds };
    return updated;
  });
  if (updated) {
    dbg("store:timer-rounds", timerId, rounds, combatId);
    await writeTimers(combat, next);
  }
  return updated;
}

/** GM-side: remove records matching every key/value in `query`. */
export async function gmRemoveTimers(combatId, query) {
  const combat = game.combats.get(combatId);
  if (!combat) return;
  const keep = getTimers(combat).filter(t => !Object.entries(query).every(([k, v]) => t[k] === v));
  if (keep.length !== getTimers(combat).length) {
    dbg("store:remove", query, combatId);
    await writeTimers(combat, keep);
  }
}

/**
 * GM-side: drop every record whose remaining <= 0.
 * @returns {object[]} The records that were pruned (for post-expiry cleanup).
 */
export async function gmPruneExpired(combatId) {
  const combat = game.combats.get(combatId);
  if (!combat) return [];
  const all = getTimers(combat);
  const keep = all.filter(t => remainingRounds(t, combat) > 0);
  const expired = all.filter(t => remainingRounds(t, combat) <= 0);
  if (expired.length) {
    dbg("store:prune", expired.map(t => t.name), combatId);
    await writeTimers(combat, keep);
  }
  return expired;
}
