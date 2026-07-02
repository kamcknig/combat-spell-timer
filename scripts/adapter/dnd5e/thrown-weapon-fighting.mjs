import { dbg } from "../../utils/debug.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Thrown Weapon Fighting" — "When you hit with a
 * ranged attack roll using a weapon that has the Thrown property, you gain a
 * +2 bonus to the damage roll." Applied at roll time (dnd5e.preRollDamageV2)
 * like Dueling/Archery, because the trigger depends on HOW the attack was
 * made, not just what's equipped: a thrown melee weapon (dagger, handaxe)
 * only qualifies when the attack was rolled with the "thrown" /
 * "thrown-offhand" attack mode — a melee stab with the same weapon gets
 * nothing. dnd5e's own Activity#getActionType(attackMode) encodes exactly
 * that mwak→rwak reclassification (it's what dnd5e uses to pick the
 * bonuses.rwak.damage actor bonus), so we test it directly. The 2014
 * (Tasha's) edition additionally allows drawing the weapon as part of the
 * attack — pure action economy dnd5e doesn't model, and the +2 benefit is
 * identical in both editions, so there is no edition branch. See
 * thoughts/shared/plans/2026-07-02-fighter-thrown-weapon-fighting.md.
 */

const TWF_NAME = "fighting style: thrown weapon fighting";
const TWF_IDENTIFIER = "fighting-style-thrown-weapon-fighting";

/** The actor's "Fighting Style: Thrown Weapon Fighting" feat item, or null. */
function thrownWeaponFightingFeat(actor) {
  return findFeat(actor, TWF_NAME, TWF_IDENTIFIER);
}

/**
 * True when this damage roll is a ranged attack with an equipped
 * Thrown-property weapon: a native ranged thrown weapon (dart), or a melee
 * thrown weapon whose attack was rolled with a "thrown" attack mode —
 * both resolve to "rwak" through the activity's own getActionType.
 */
function isThrownRangedAttack(activity, item, attackMode) {
  if (!item?.system?.equipped) return false;
  if (item.type !== "weapon") return false;
  if (!item.system.properties?.has("thr")) return false;
  return activity?.getActionType?.(attackMode) === "rwak";
}

/**
 * dnd5e.preRollDamageV2 dispatch: add +2 to the pending damage roll when the
 * actor has Thrown Weapon Fighting and this specific attack was a ranged
 * attack with an equipped Thrown-property weapon. Workflow-local hook —
 * fires only on the rolling client, so no cross-client gating is needed.
 * @param {object} config  The pending damage roll process config.
 */
export function onThrownWeaponFightingPreRollDamage(config) {
  const activity = config?.subject;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor || !item) return;
  if (!thrownWeaponFightingFeat(actor)) return;
  if (!isThrownRangedAttack(activity, item, config.attackMode)) return;
  const roll = config.rolls?.[0];
  if (!roll) return;
  dbg("dnd5e:twf:bonus", actor.name, item.name, config.attackMode);
  roll.parts = [...(roll.parts ?? []), "2"];
}

/** Register the Thrown Weapon Fighting roll-time bonus. Call once during setup. */
export function registerThrownWeaponFightingHooks() {
  Hooks.on("dnd5e.preRollDamageV2", onThrownWeaponFightingPreRollDamage);
}
