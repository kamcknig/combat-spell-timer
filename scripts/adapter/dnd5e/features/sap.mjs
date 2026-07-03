import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Weapon Mastery "Sap" (2024 PHB): "the creature has Disadvantage on
 * its next attack roll before the start of your next turn." Caster-anchored
 * timer (attacker's combatant row, expires at the start of the attacker's
 * next turn), target-anchored applied effect (the disadvantage marker),
 * removed early the instant the target makes an attack roll.
 *
 * Shape is close to path-to-the-grave.mjs (effect: null on the caster;
 * onRemove sweeps target effects by caster), but with one deliberate
 * difference: matching is done via the module's own `casterActorUuid` flag
 * rather than resolving `effect.origin` through features/shared.mjs's
 * effectOriginActor(). The applied marker on the target originates from a
 * persisted template ActiveEffect on the weapon item
 * (weapon-mastery.mjs#ensureMasteryEffectTemplate — Path to the Grave's
 * ensureCurseTemplate pattern), so origin-walking to the item's actor would
 * actually resolve correctly in the common case. The flag is used anyway
 * because it's a strictly stronger guarantee: it's stamped onto the applied
 * marker itself at the moment it's created (dnd5e's
 * EffectApplicationElement#_applyEffectToActor clones the template via
 * `effect.toObject()`, carrying flags[MODULE_ID] straight through), so it
 * still identifies the correct attacker even if the weapon is later dropped,
 * traded, or its template effect deleted — none of which should silently
 * break Sap's cleanup.
 */
export const SAP_FLAG = "sap"; // flags[MODULE_ID][SAP_FLAG] = true on the marker AE
export const SAP_STATUS_ID = "cst-sap"; // statuses id stamped on the applied marker AE

/** The casterActorUuid stamped on a Sap marker AE, or null. */
function sapCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "sap",
  label: "Sap",
  effect: null, // lives on the TARGET, not the caster — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[SAP_FLAG]) continue;
        if (sapCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:sap-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-hand-fist",
    roundsLeftKey: "COMBAT_SPELL_TIMER.WeaponMastery.SapRoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.WeaponMastery.SapEndLabel",
    turnEnd: { mode: "expire" },
  },
};

/** True when `actor` currently carries a Sap disadvantage marker. */
function isSapped(actor) {
  return (actor?.effects ?? []).some(e => e.flags?.[MODULE_ID]?.[SAP_FLAG]);
}

/**
 * dnd5e.preRollAttackV2 dispatch: a Sapped actor's next attack roll is made
 * with Disadvantage. Pre-roll so D20Roll.applyKeybindings sees
 * config.disadvantage before the dialog/roll is built.
 * @param {object} config
 */
export function onSapPreRollAttack(config) {
  const actor = config?.subject?.actor;
  if (!actor || !isSapped(actor)) return;
  dbg("dnd5e:sap:disadvantage", actor.name);
  config.disadvantage = true;
}

/**
 * dnd5e.rollAttackV2 dispatch: consume the Sap marker the instant the
 * sapped actor makes ANY attack roll ("if the target makes an attack roll,
 * remove the effect"). Returns the early-end query for the caster-anchored
 * timer + sweep, or null. Fires only on the rolling client.
 * @param {object} subject  The AttackActivity ({ subject } hook arg).
 * @returns {{featureId: string, casterActorUuid: string}|null}
 */
export function onSapAttackRolled(subject) {
  const actor = subject?.actor;
  if (!actor) return null;
  const marker = (actor.effects ?? []).find(e => e.flags?.[MODULE_ID]?.[SAP_FLAG]);
  if (!marker) return null;
  const casterActorUuid = sapCaster(marker);
  dbg("dnd5e:sap:consumed-on-attack", actor.name);
  return { featureId: "sap", casterActorUuid };
}

/**
 * createActiveEffect dispatch: a Sap marker was just applied to a target
 * (via the effect-application tray) — start the attacker-anchored timer.
 * Initiating client only (mirrors effect-duration-overrides.mjs). Takes the
 * adapter's bound applyFeatureEffect fn as a parameter (rather than
 * importing getAdapter() here) to avoid a circular import between this file
 * and adapter/dnd5e/index.mjs, which already imports this module.
 *
 * Passes `exceptEffectUuid: effect.uuid` — onFeatureStart's "refresh"
 * semantics (core/features.mjs) sweep any PRIOR Sap marker from this same
 * attacker before adding the new timer, which is correct for a genuine
 * re-application, but Sap's marker already exists by the time this fires
 * (unlike e.g. Rage/Path to the Grave, whose start precedes their applied
 * effect) — without the exception, the sweep would delete the very marker
 * that just triggered this call, immediately undoing the GM's "Apply" click.
 * @param {ActiveEffect} effect
 * @param {string} userId
 * @param {(actor: Actor, featureId: string, opts: object) => Promise<string|null>} applyEffect
 */
export async function onSapEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[SAP_FLAG]) return;
  const casterActorUuid = sapCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:sap:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "sap", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}
