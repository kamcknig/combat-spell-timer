import { MODULE_ID } from "../module.mjs";
import { getTimers, remainingRounds } from "./store.mjs";

/**
 * Actor-sheet effect-row duration override.
 *
 * Feature AEs carry a large sentinel duration (see features/shared.mjs) so
 * Foundry's v14 expiry registry never suppresses them while the module timer
 * owns expiry. The downside is the dnd5e effects tab would show that sentinel
 * (e.g. "99999 Rounds"). This hook rewrites those rows' duration to the live
 * remaining rounds from the module timer (falling back to the stored real round
 * count when no combat timer exists).
 */

/**
 * Live remaining rounds for a feature effect from its module timer, or null if
 * the effect isn't tracked by any current combat.
 * @param {ActiveEffect} effect
 * @returns {number|null}
 */
function timerRemaining(effect) {
  for (const combat of game.combats ?? []) {
    const t = getTimers(combat).find(t => t.effectUuid === effect.uuid);
    if (t) return remainingRounds(t, combat);
  }
  return null;
}

/**
 * Live remaining rounds of the actor's feature timer of a given type, for AEs
 * whose lifetime mirrors a feature (flags[MODULE_ID].boundFeature, e.g. a Wild
 * Surge marker bound to "rage"). Null when no such timer is running.
 * @param {Actor} actor
 * @param {string} featureType
 * @returns {number|null}
 */
function boundTimerRemaining(actor, featureType) {
  for (const combat of game.combats ?? []) {
    const t = getTimers(combat).find(t => t.type === featureType && t.casterActorUuid === actor.uuid);
    if (t) return remainingRounds(t, combat);
  }
  return null;
}

/**
 * renderActorSheetV2 handler: replace the duration shown on each module-feature
 * effect row (and each feature-bound marker row) with the true remaining rounds.
 * @param {Application} app
 * @param {HTMLElement} element
 */
export function onRenderActorSheetEffects(app, element) {
  const el = element instanceof HTMLElement ? element : element?.[0];
  const actor = app?.document ?? app?.actor;
  if (!el || !actor?.effects) return;

  for (const effect of actor.effects) {
    const flags = effect.flags?.[MODULE_ID];
    if (!flags) continue;
    let rounds = null;
    if (flags.feature != null) rounds = timerRemaining(effect) ?? flags.durationRounds;
    else if (flags.boundFeature) rounds = boundTimerRemaining(actor, flags.boundFeature);
    if (rounds == null) continue;

    const row = el.querySelector(`[data-effect-id="${effect.id}"]`);
    if (!row) continue;
    const host = row.querySelector(".effect-name") ?? row.querySelector(".item-name") ?? row;

    let dur = host.querySelector(".duration");
    if (!dur) {
      dur = document.createElement("div");
      dur.className = "duration";
      host.appendChild(dur);
    }
    const unit = game.i18n.localize("COMBAT_SPELL_TIMER.RoundsUnit");
    dur.innerHTML = `<i class="fa-solid fa-clock" inert></i><span class="most-significant">${rounds} ${unit}</span>`;
  }
}
