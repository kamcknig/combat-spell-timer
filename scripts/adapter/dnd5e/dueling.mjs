import { dbg } from "../../utils/debug.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Dueling" — "When you are wielding a melee weapon in
 * one hand and no other weapons, you gain a +2 bonus to damage rolls with
 * that weapon." Applied at roll time (dnd5e.preRollDamageV2) rather than as a
 * standing ActiveEffect, because the bonus must be scoped to the SPECIFIC
 * weapon used in a given attack — a blanket system.bonuses.mwak.damage change
 * would also (incorrectly) buff an unarmed strike or any other melee damage
 * roll once "eligible," with no way to restrict it to one weapon. See
 * thoughts/shared/plans/2026-07-01-remove-strict-mode-and-dynamic-archery.md
 * for the full rationale and dnd5e source references.
 */

const DUELING_NAME = "fighting style: dueling";
const DUELING_IDENTIFIER = "fighting-style-dueling";

/** The actor's "Fighting Style: Dueling" feat item, or null. */
function duelingFeat(actor) {
  return findFeat(actor, DUELING_NAME, DUELING_IDENTIFIER);
}

/**
 * True when `item` is the actor's Dueling-eligible weapon: equipped, melee,
 * not two-handed-only ("two" property — can never be held in one hand; a
 * versatile "ver" weapon still counts, since it CAN be one-handed even though
 * dnd5e has no persisted grip state), and the actor's ONLY equipped weapon
 * ("no other weapons").
 */
function isDuelingWeapon(actor, item) {
  if (!item?.system?.equipped) return false;
  if (item.system.attackType !== "melee") return false;
  if (item.system.properties?.has("two")) return false;
  const equipped = (actor?.itemTypes?.weapon ?? []).filter((w) => w.system?.equipped);
  return equipped.length === 1 && equipped[0].id === item.id;
}

/**
 * dnd5e.preRollDamageV2 dispatch: add +2 to the pending damage roll when the
 * actor has Dueling and the weapon behind this specific activity satisfies
 * the condition. Workflow-local hook — fires only on the rolling client, so
 * no cross-client gating is needed.
 * @param {object} config  The pending damage roll process config.
 */
export function onDuelingPreRollDamage(config) {
  const activity = config?.subject;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor || !item) return;
  if (!duelingFeat(actor)) return;
  if (!isDuelingWeapon(actor, item)) return;
  const roll = config.rolls?.[0];
  if (!roll) return;
  dbg("dnd5e:dueling:bonus", actor.name, item.name);
  roll.parts = [...(roll.parts ?? []), "2"];
}

/** Register the Dueling roll-time bonus. Call once during setup. */
export function registerDuelingHooks() {
  Hooks.on("dnd5e.preRollDamageV2", onDuelingPreRollDamage);
}
