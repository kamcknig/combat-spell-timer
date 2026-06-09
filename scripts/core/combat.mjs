import { pruneExpired, isWriter } from "./socket.mjs";

/**
 * On combat update, the active GM prunes any of THIS combat's timers whose
 * remaining <= 0. Inherently per-combat: the hook fires once per combat, so a
 * caster in several combats has each pruned independently by its own update.
 * Display countdown itself needs no write — the tracker re-renders on every
 * combat update and recomputes remaining from combat.round.
 * @param {Combat} combat
 * @param {object} changed  The update diff.
 */
export function onUpdateCombat(combat, changed) {
  if (!isWriter()) return;
  if (!("round" in changed) && !("turn" in changed)) return; // only on progression
  pruneExpired(combat.id);
}
