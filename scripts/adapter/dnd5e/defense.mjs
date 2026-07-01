import { MODULE_ID } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { isWriter } from "../../core/socket.mjs";
import { notifyEffectSync } from "../../utils/effect-notify.mjs";
import { findFeat, isModernRules } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Defense" — "While you are wearing armor, you gain a
 * +1 bonus to AC." Originally shipped as a static, unconditional transfer
 * effect (see import/effects.mjs's history and the original Defense plan),
 * mirroring dnd5e's own simplified compendium implementation. This module
 * replaces that with the real, armor-gated condition, using dnd5e's own
 * Actor#armor getter (system.attributes.ac.equippedArmor) — already excludes
 * shields, since dnd5e itself buckets them separately when computing AC.
 *
 * Not gated by Strict Mode (scripts/utils/settings.mjs) — always enforced.
 * Under 2024 ("modern") rules, additionally requires the equipped armor be
 * Light/Medium/Heavy (see isDefenseEligible / features/shared.mjs's
 * isModernRules) — 2014 rules keep the original unconditional "wearing any
 * armor" check.
 */

const DEFENSE_NAME = "fighting style: defense";
const DEFENSE_IDENTIFIER = "fighting-style-defense";
const DEFENSE_EFFECT_FLAG = "defense";

/** The actor's "Fighting Style: Defense" feat item, or null. */
function defenseFeat(actor) {
  return findFeat(actor, DEFENSE_NAME, DEFENSE_IDENTIFIER);
}

/** The actor's module-owned Defense ActiveEffect, or null. */
function defenseEffect(actor) {
  return actor?.effects?.find((e) => e.getFlag(MODULE_ID, DEFENSE_EFFECT_FLAG)) ?? null;
}

/**
 * True when the actor has at least one piece of body armor equipped (shields
 * don't count — Actor#armor already excludes them). Under 2024 ("modern")
 * rules, additionally require the armor be Light/Medium/Heavy — dnd5e's
 * armorTypes enum also has a "natural" category (e.g. some species/feature-
 * granted natural-armor equipment items) that Actor#armor does NOT exclude
 * the way it excludes shields; the 2024 PHB Defense text explicitly says
 * "Light, Medium, or Heavy armor," closing that gap. 2014 rules keep the
 * original unconditional "wearing armor" check.
 */
function isDefenseEligible(actor) {
  const armor = actor?.armor;
  if (!armor) return false;
  if (!isModernRules()) return true;
  return ["light", "medium", "heavy"].includes(armor.system?.type?.value);
}

/**
 * Bring the actor's Defense ActiveEffect in line with current state: create
 * it when the actor has the feat and is wearing armor and doesn't already
 * have one; remove it when present but no longer eligible (or the feat is
 * gone). No-op on every client except the active GM.
 * @param {Actor} actor
 */
async function syncDefenseEffect(actor) {
  if (!actor || !isWriter()) return;
  const feat = defenseFeat(actor);
  const existing = defenseEffect(actor);
  if (!feat) {
    if (existing) {
      dbg("dnd5e:defense", "removing — feat no longer present", actor.name);
      await existing.delete();
      notifyEffectSync({ effectName: existing.name, actorName: actor.name, added: false });
    }
    return;
  }
  const eligible = isDefenseEligible(actor);
  if (eligible && !existing) {
    dbg("dnd5e:defense", "adding — eligible", actor.name);
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: feat.name,
      img: feat.img,
      origin: feat.uuid,
      disabled: false,
      changes: [
        { key: "system.attributes.ac.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "+1", priority: 20 },
      ],
      flags: { [MODULE_ID]: { [DEFENSE_EFFECT_FLAG]: true } },
    }]);
    notifyEffectSync({ effectName: feat.name, actorName: actor.name, added: true });
  } else if (!eligible && existing) {
    dbg("dnd5e:defense", "removing — no longer eligible", actor.name);
    await existing.delete();
    notifyEffectSync({ effectName: existing.name, actorName: actor.name, added: false });
  }
}

/** True for the actor's "Fighting Style: Defense" feat item specifically. */
function isDefenseFeatItem(item) {
  return item?.type === "feat" && item.name?.toLowerCase() === DEFENSE_NAME;
}

/**
 * Keep every actor's passive Defense effect in sync with their equipped
 * armor and their possession of the feat itself:
 *  - updateItem: an equipment item's system.equipped flag changed → recompute
 *    (armor items are dnd5e type "equipment", not a distinct "armor" type).
 *    Also recompute on a system.type.value change — under 2024 rules,
 *    isDefenseEligible reads the equipped armor's type (light/medium/heavy
 *    vs. e.g. natural), so editing an already-equipped item's Armor Type on
 *    its sheet must re-trigger the same sync an equip toggle would.
 *  - createItem / deleteItem: the Defense feat itself was granted/removed →
 *    recompute immediately rather than waiting for the next equip toggle.
 * Call once during setup.
 */
export function registerDefenseHooks() {
  Hooks.on("updateItem", (item, changes) => {
    if (item?.type !== "equipment" || !item.actor) return;
    const sys = changes.system ?? {};
    if (!("equipped" in sys) && !("type" in sys)) return;
    dbg("dnd5e:defense:updateItem", item.actor.name, sys.equipped, sys.type?.value);
    syncDefenseEffect(item.actor);
  });
  Hooks.on("createItem", (item) => {
    if (!isDefenseFeatItem(item) || !item.actor) return;
    dbg("dnd5e:defense:createItem", item.actor.name);
    syncDefenseEffect(item.actor);
  });
  Hooks.on("deleteItem", (item) => {
    if (!isDefenseFeatItem(item) || !item.actor) return;
    dbg("dnd5e:defense:deleteItem", item.actor.name);
    syncDefenseEffect(item.actor);
  });
}
