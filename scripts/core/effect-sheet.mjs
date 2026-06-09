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
 * renderActorSheetV2 handler: replace the duration shown on each module-feature
 * effect row with the true remaining round count.
 * @param {Application} app
 * @param {HTMLElement} element
 */
export function onRenderActorSheetEffects(app, element) {
  const el = element instanceof HTMLElement ? element : element?.[0];
  const actor = app?.document ?? app?.actor;
  if (!el || !actor?.effects) return;

  for (const effect of actor.effects) {
    if (effect.flags?.[MODULE_ID]?.feature == null) continue;
    const rounds = timerRemaining(effect) ?? effect.flags[MODULE_ID].durationRounds;
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
