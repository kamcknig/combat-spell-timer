/**
 * Generic "a module-owned passive effect was added to/removed from an actor"
 * notification. Any current or future effect-sync code can call this instead
 * of hand-rolling its own ui.notifications call, so wording stays consistent
 * as more such effects are added. Fires only on the calling client — callers
 * that gate their mutation to a single authoritative client (e.g. isWriter())
 * naturally get a single notification, not one per connected client.
 * @param {object} opts
 * @param {string} opts.effectName  e.g. "Fighting Style: Dueling"
 * @param {string} opts.actorName
 * @param {boolean} opts.added      true = added, false = removed
 */
export function notifyEffectSync({ effectName, actorName, added }) {
  const key = added ? "COMBAT_SPELL_TIMER.EffectSync.Added" : "COMBAT_SPELL_TIMER.EffectSync.Removed";
  ui.notifications?.info(game.i18n.format(key, { effect: effectName, actor: actorName }));
}
