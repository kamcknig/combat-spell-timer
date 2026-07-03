import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Weapon Mastery "Slow" (2024 PHB): "reduce its Speed by 10 feet until
 * the start of your next turn. If the creature is hit more than once by
 * weapons that have this property, the Speed reduction doesn't exceed 10
 * feet" — i.e. never stack a second Slow onto an already-slowed target,
 * regardless of which weapon/attacker caused the first (enforced via
 * onSlowPreCreate, not scoped to origin like Sap's disadvantage).
 *
 * Same caster-anchored-timer / target-anchored-effect shape as sap.mjs: the
 * applied marker on the target originates from a persisted template
 * ActiveEffect on the weapon item (weapon-mastery.mjs#ensureMasteryEffectTemplate),
 * and matching for removal is done via the module's own `casterActorUuid`
 * flag stamped onto the applied marker itself (see sap.mjs's doc comment for
 * why the flag is preferred over origin-walking).
 *
 * system.attributes.movement.bonus (dnd5e.mjs:25615) is applied to EVERY
 * movement type in the same prepareMovement() pass dnd5e uses for its own
 * exhaustion penalty (dnd5e.mjs:26171-26212), self-clamping to a floor of 0
 * (:26194) — a single ADD "-10" change, no per-movement-type changes and no
 * manual clamping needed. The change itself lives in weapon-mastery.mjs's
 * buildSlowEffectTemplate (the mechanical payload), not here — this file
 * owns the feature descriptor / timer / anti-stack machinery only.
 */
export const SLOW_FLAG = "slow"; // flags[MODULE_ID][SLOW_FLAG] = true on the marker AE
export const SLOW_STATUS_ID = "cst-slow"; // statuses id stamped on the applied marker AE

/** The casterActorUuid stamped on a Slow marker AE, or null. */
function slowCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "slow",
  label: "Slow",
  effect: null, // lives on the TARGET, not the caster — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[SLOW_FLAG]) continue;
        if (slowCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:slow-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-shoe-prints",
    roundsLeftKey: "COMBAT_SPELL_TIMER.WeaponMastery.SlowRoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.WeaponMastery.SlowEndLabel",
    turnEnd: { mode: "expire" },
  },
};

/**
 * preCreateActiveEffect dispatch: block a second Slow effect from being
 * created on a target that already carries one, from ANY origin — "the
 * Speed reduction doesn't exceed 10 feet" regardless of source. Returning
 * false cancels the create (core Foundry preCreate* contract). Only guards
 * against ANOTHER actor's target-side marker — the item-owned persisted
 * template effect (weapon-mastery.mjs#ensureMasteryEffectTemplate) is parented
 * to the Item, not an Actor, so the `documentName !== "Actor"` guard skips it
 * (mirrors the same guard on the createActiveEffect hook in
 * adapter/dnd5e/index.mjs#registerFeatureEarlyEnd).
 * @param {ActiveEffect} effect
 * @returns {boolean|void}
 */
export function onSlowPreCreate(effect) {
  if (!effect.flags?.[MODULE_ID]?.[SLOW_FLAG]) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  const already = (actor.effects ?? []).some(e => e.flags?.[MODULE_ID]?.[SLOW_FLAG]);
  if (already) {
    dbg("dnd5e:slow:blocked-stack", actor.name);
    return false;
  }
}

/**
 * createActiveEffect dispatch: a Slow marker was just applied to a target
 * (via the effect-application tray) — start the attacker-anchored timer.
 * Initiating client only (mirrors sap.mjs#onSapEffectApplied). Takes the
 * adapter's bound applyFeatureEffect fn as a parameter (rather than
 * importing getAdapter() here) to avoid a circular import between this file
 * and adapter/dnd5e/index.mjs, which already imports this module.
 *
 * Passes `exceptEffectUuid: effect.uuid` — onFeatureStart's "refresh"
 * semantics (core/features.mjs) sweep any PRIOR Slow marker from this same
 * attacker before adding the new timer; without the exception, the sweep
 * would delete the very marker that just triggered this call, immediately
 * undoing the GM's "Apply" click.
 * @param {ActiveEffect} effect
 * @param {string} userId
 * @param {(actor: Actor, featureId: string, opts: object) => Promise<string|null>} applyEffect
 */
export async function onSlowEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[SLOW_FLAG]) return;
  const casterActorUuid = slowCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:slow:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "slow", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}
