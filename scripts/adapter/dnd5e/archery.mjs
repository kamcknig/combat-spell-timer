import { dbg } from "../../utils/debug.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Archery" — "You gain a +2 bonus to attack rolls you
 * make with ranged weapons." Applied at roll time (dnd5e.preRollAttackV2)
 * rather than as a standing ActiveEffect, so the bonus only applies when the
 * attack is actually made with an EQUIPPED ranged weapon — not merely
 * whenever any ranged weapon happens to be equipped somewhere. See
 * thoughts/shared/plans/2026-07-01-remove-strict-mode-and-dynamic-archery.md.
 *
 * A two-handed ranged weapon (e.g. a longbow) occupies both hands, so it only
 * qualifies when it's the actor's ONLY equipped weapon — mirrors Dueling's
 * "no other weapons" check (dueling.mjs). A one-handed ranged weapon (e.g. a
 * hand crossbow) has no such restriction.
 */

const ARCHERY_NAME = "fighting style: archery";
const ARCHERY_IDENTIFIER = "fighting-style-archery";

/** The actor's "Fighting Style: Archery" feat item, or null. */
function archeryFeat(actor) {
  return findFeat(actor, ARCHERY_NAME, ARCHERY_IDENTIFIER);
}

/**
 * True when `item` is an equipped ranged weapon eligible for the Archery
 * bonus. A two-handed ranged weapon additionally requires that it's the
 * actor's only equipped weapon (both hands are occupied holding it).
 */
function isArcheryWeapon(actor, item) {
  if (!item?.system?.equipped) return false;
  if (item.system?.attackType !== "ranged") return false;
  if (!item.system?.properties?.has("two")) return true;
  const equipped = (actor?.itemTypes?.weapon ?? []).filter((w) => w.system?.equipped);
  return equipped.length === 1 && equipped[0].id === item.id;
}

/**
 * dnd5e.preRollAttackV2 dispatch: add +2 to the pending attack roll when the
 * actor has Archery and the weapon behind this specific activity is an
 * equipped ranged weapon (see isArcheryWeapon for the two-handed nuance).
 * Workflow-local hook — fires only on the rolling client, so no cross-client
 * gating is needed.
 * @param {object} config  The pending attack roll process config.
 */
export function onArcheryPreRollAttack(config) {
  const activity = config?.subject;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor || !item) return;
  if (!archeryFeat(actor)) return;
  if (!isArcheryWeapon(actor, item)) return;
  const roll = config.rolls?.[0];
  if (!roll) return;
  dbg("dnd5e:archery:bonus", actor.name, item.name);
  roll.parts = [...(roll.parts ?? []), "2"];
}

/** Register the Archery roll-time bonus. Call once during setup. */
export function registerArcheryHooks() {
  Hooks.on("dnd5e.preRollAttackV2", onArcheryPreRollAttack);
}
