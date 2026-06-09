import { addTimer, removeTimers } from "./socket.mjs";
import { getTimers } from "./store.mjs";
import { dbg } from "../utils/debug.mjs";

/**
 * All combats the actor is currently a combatant in, paired with that combat's
 * combatant for the actor. Includes combats that haven't started yet (round 0).
 * Uses Combat#getCombatantsByActor (token-aware; the singular
 * getCombatantByActor is deprecated in v14).
 * @param {Actor} actor
 * @returns {{combat: Combat, combatant: Combatant}[]}
 */
function getActorCombats(actor) {
  const out = [];
  for (const combat of game.combats) {
    const [combatant] = combat.getCombatantsByActor(actor); // [] if actor not in this combat
    if (combatant) out.push({ combat, combatant });
  }
  return out;
}

/**
 * Turn a NormalizedCast into ONE stored timer record PER combat the caster is
 * in, stamping each with that combat's round/turn and combatant id, then persist
 * them via the GM. Runs on the casting client (which has the actor in memory),
 * so fromUuidSync resolves the live (possibly synthetic token) Actor.
 * @param {import("../adapter/SystemAdapter.mjs").NormalizedCast} record
 */
export function onSpellCast(record) {
  const actor = fromUuidSync(record.casterActorUuid);
  if (!actor) return;
  dbg("cast", record.name, `${record.durationRounds}r`, record.concentration ? "conc" : "");

  for (const { combat, combatant } of getActorCombats(actor)) {
    addTimer(combat.id, {
      id: foundry.utils.randomID(),       // unique id per combat record
      name: record.name,
      img: record.img,
      casterActorUuid: record.casterActorUuid,
      casterCombatantId: combatant.id,    // combatant id WITHIN this combat
      castRound: Math.max(combat.round, 1), // treat pre-start (round 0) as round 1
      // Hidden initiative for the timer's row: the active combatant's at cast
      // time; or the caster's own initiative if they've already rolled but
      // combat hasn't started yet. Null otherwise — filled on the owner's
      // first roll via gmSetInitiative.
      initiative: combat.combatant?.initiative ?? (Number.isNumeric(combatant.initiative) ? combatant.initiative : null),
      durationRounds: record.durationRounds,
      concentration: record.concentration,
      spellUuid: record.spellUuid ?? null,
      spellLevel: record.spellLevel ?? null,
      concentrationEffectUuid: record.concentrationEffectUuid ?? null
    });
  }
}

/**
 * Remove matching timers from EVERY combat that holds one. Concentration ending
 * is not combat-specific — the same spell may be tracked in multiple combats, so
 * we clear it from all of them. Only emits for combats that actually have a
 * match, to avoid needless socket traffic.
 * @param {object} query  Partial record match, e.g. { concentrationEffectUuid }.
 */
export function onEarlyRemove(query) {
  dbg("early-remove", query);
  const matches = (t) => Object.entries(query).every(([k, v]) => t[k] === v);
  for (const combat of game.combats) {
    if (getTimers(combat).some(matches)) removeTimers(combat.id, query);
  }
}
