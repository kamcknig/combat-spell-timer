import { MODULE_ID } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { isWriter } from "../../core/socket.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Dueling" — "When you are wielding a melee weapon in
 * one hand and no other weapons, you gain a +2 bonus to damage rolls with
 * that weapon." Unlike Archery/Defense (see import/effects.mjs), this bonus
 * depends on live equipment state, not merely having the feat — dnd5e has no
 * built-in signal for that (see
 * thoughts/shared/research/2026-06-30-dnd5e-single-melee-weapon-wielded-research.md),
 * so this module computes it and owns a separate, non-transfer ActiveEffect
 * that it creates/deletes in response to equip-state changes.
 *
 * Known simplifications (see the implementation plan for the full rationale):
 * uses dnd5e's own system.bonuses.mwak.damage key (all melee-weapon damage,
 * not scoped to the specific weapon); does not check one- vs two-handed grip
 * (dnd5e has no persisted state for that); natural weapons count toward the
 * equipped-weapon count like any other weapon-type item.
 */

const DUELING_NAME = "fighting style: dueling";
const DUELING_IDENTIFIER = "fighting-style-dueling";
const DUELING_EFFECT_FLAG = "dueling";

/** The actor's "Fighting Style: Dueling" feat item, or null. */
function duelingFeat(actor) {
  return findFeat(actor, DUELING_NAME, DUELING_IDENTIFIER);
}

/** The actor's module-owned Dueling ActiveEffect, or null. */
function duelingEffect(actor) {
  return actor?.effects?.find((e) => e.getFlag(MODULE_ID, DUELING_EFFECT_FLAG)) ?? null;
}

/** True when exactly one weapon-type item is equipped and it's a melee weapon. */
function isDuelingEligible(actor) {
  const equipped = (actor?.itemTypes?.weapon ?? []).filter((w) => w.system?.equipped);
  return equipped.length === 1 && equipped[0].system?.attackType === "melee";
}

/**
 * Bring the actor's Dueling ActiveEffect in line with current state: create it
 * when the actor has the feat and is eligible and doesn't already have one;
 * remove it when present but no longer eligible (or the feat is gone).
 * No-op on every client except the active GM, so the mutation happens exactly
 * once no matter which client's action triggered the broadcast hook.
 * @param {Actor} actor
 */
async function syncDuelingEffect(actor) {
  if (!actor || !isWriter()) return;
  const feat = duelingFeat(actor);
  const existing = duelingEffect(actor);
  if (!feat) {
    if (existing) {
      dbg("dnd5e:dueling", "removing — feat no longer present", actor.name);
      await existing.delete();
    }
    return;
  }
  const eligible = isDuelingEligible(actor);
  if (eligible && !existing) {
    dbg("dnd5e:dueling", "adding — eligible", actor.name);
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: feat.name,
      img: feat.img,
      origin: feat.uuid,
      disabled: false,
      changes: [
        { key: "system.bonuses.mwak.damage", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "+2", priority: 20 },
      ],
      flags: { [MODULE_ID]: { [DUELING_EFFECT_FLAG]: true } },
    }]);
  } else if (!eligible && existing) {
    dbg("dnd5e:dueling", "removing — no longer eligible", actor.name);
    await existing.delete();
  }
}

/** True for the actor's "Fighting Style: Dueling" feat item specifically. */
function isDuelingFeatItem(item) {
  return item?.type === "feat" && item.name?.toLowerCase() === DUELING_NAME;
}

/**
 * Keep every actor's passive Dueling effect in sync with their equipped
 * weapons and their possession of the feat itself:
 *  - updateItem: a weapon's system.equipped flag changed → recompute.
 *  - createItem / deleteItem: the Dueling feat itself was granted/removed
 *    (DDB import, manual drag-drop, deletion) → recompute immediately rather
 *    than waiting for the next equip toggle.
 * Call once during setup.
 */
export function registerDuelingHooks() {
  Hooks.on("updateItem", (item, changes) => {
    if (item?.type !== "weapon" || !item.actor) return;
    if (!("equipped" in (changes.system ?? {}))) return;
    dbg("dnd5e:dueling:updateItem", item.actor.name, changes.system.equipped);
    syncDuelingEffect(item.actor);
  });
  Hooks.on("createItem", (item) => {
    if (!isDuelingFeatItem(item) || !item.actor) return;
    dbg("dnd5e:dueling:createItem", item.actor.name);
    syncDuelingEffect(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (!isDuelingFeatItem(item) || !item.actor) return;
    dbg("dnd5e:dueling:deleteItem", item.actor.name);
    syncDuelingEffect(item.actor);
  });
}
