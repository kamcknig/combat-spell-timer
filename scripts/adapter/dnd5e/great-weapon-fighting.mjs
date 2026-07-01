import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Great Weapon Fighting" — "When you roll a 1 or 2 on a
 * damage die for an attack you make with a melee weapon that you are wielding
 * with two hands, you can reroll the die and must use the new roll, even if
 * the new roll is a 1 or a 2." Unlike Archery/Dueling (a flat bonus folded
 * into the roll formula before it's evaluated), this is the player's OPTIONAL
 * choice made only after seeing which dice came up 1 or 2 — there is no
 * pre-roll signal for that. Implemented as a button on the already-rendered
 * damage-roll chat message: enabled when the roll contains a rerollable 1/2,
 * and on click, rerolls just those dice (via Foundry's own
 * Die.prototype.reroll(), the same mechanism behind the "r<=2" formula
 * modifier) and posts a new chat message in the same card format. See
 * thoughts/shared/plans/2026-07-01-fighter-great-weapon-fighting.md for the
 * full source-verified rationale.
 */

const GWF_NAME = "fighting style: great weapon fighting";
const GWF_IDENTIFIER = "fighting-style-great-weapon-fighting";
const GWF_REROLLED_FLAG = "gwfRerolled";
const BTN_CLASS = "cst-gwf-reroll";

/** The actor's "Fighting Style: Great Weapon Fighting" feat item, or null. */
function greatWeaponFightingFeat(actor) {
  return findFeat(actor, GWF_NAME, GWF_IDENTIFIER);
}

/**
 * True when `item` is the actor's Great-Weapon-Fighting-eligible weapon:
 * equipped, melee, two-handed or versatile ("two"/"ver" property — a
 * versatile weapon still counts even when actually gripped one-handed, since
 * dnd5e has no persisted grip state, same simplification already accepted for
 * Dueling/Archery), and the actor's ONLY equipped weapon (nothing else could
 * occupy the second hand).
 */
function isGreatWeaponFightingWeapon(actor, item) {
  if (!item?.system?.equipped) return false;
  if (item.system.attackType !== "melee") return false;
  const props = item.system.properties;
  if (!props?.has("two") && !props?.has("ver")) return false;
  const equipped = (actor?.itemTypes?.weapon ?? []).filter((w) => w.system?.equipped);
  return equipped.length === 1 && equipped[0].id === item.id;
}

/** True when any active die result across every roll is currently a 1 or 2. */
function hasRerollableDice(rolls) {
  const { DiceTerm } = foundry.dice.terms;
  return rolls.some((roll) => roll.terms.some((t) =>
    t instanceof DiceTerm && t.results.some((r) => r.active && r.result <= 2)
  ));
}

/** Independent clones of every roll (round-tripped through JSON), so the original message's live Roll instances are never mutated. */
function cloneRolls(rolls) {
  return rolls.map((r) => Roll.fromData(r.toJSON()));
}

/**
 * Reroll every active 1/2 die result on every DiceTerm across `rolls`, once
 * each — Die#reroll's default recursive:false matches "must use the new
 * roll, even if it's a 1 or 2" exactly — then fix each roll's cached total
 * (Roll#total is not a live getter; DiceTerm#total is, but Roll#_total is
 * only set during evaluate()).
 */
async function rerollLowDice(rolls) {
  const { DiceTerm } = foundry.dice.terms;
  for (const roll of rolls) {
    for (const term of roll.terms) {
      if (term instanceof DiceTerm && typeof term.reroll === "function") {
        await term.reroll("r<=2");
      }
    }
    roll._total = roll._evaluateTotal();
  }
  return rolls;
}

/**
 * Reroll a clone of the message's rolls and post the result as a new
 * damage-roll chat message, mirroring the same flags/flavor/speaker shape
 * Activity#rollDamage itself uses so it renders with an identical card look.
 * The original message is left untouched except for a flag marking it
 * "already rerolled."
 */
async function onRerollClick(message, activity, item, actor) {
  const rerolled = await rerollLowDice(cloneRolls(message.rolls ?? []));
  await CONFIG.Dice.DamageRoll.toMessage(rerolled, {
    flavor: `${item.name} - ${game.i18n.localize("COMBAT_SPELL_TIMER.GreatWeaponFighting.RerollFlavor")}`,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: {
      dnd5e: {
        ...activity.messageFlags,
        messageType: "roll",
        roll: { type: "damage" },
        originatingMessage: message.id,
      },
    },
  });
  dbg("dnd5e:gwf:reroll", actor.name, item.name);
  await message.update({ flags: { [MODULE_ID]: { [GWF_REROLLED_FLAG]: true } } });
}

/** True when the current user may act on this message's actor (owner or GM). */
function canReroll(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/**
 * dnd5e.renderChatMessage handler: append a Great Weapon Fighting reroll
 * button to an eligible damage-roll message. Fires AFTER dnd5e's own card
 * decoration (unlike core's renderChatMessageHTML, which fires before
 * _enrichChatCard/_enrichDamageTooltip build .dice-roll/.dice-total/the
 * .chat-card header) — see the implementation plan for the full
 * source-verified rationale — so .message-content already contains the
 * rendered dice card to append after.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderDamageMessage(message, html) {
  if (message.getFlag(MODULE_ID, GWF_REROLLED_FLAG)) return;
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;

  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (!greatWeaponFightingFeat(actor)) return;
  if (!isGreatWeaponFightingWeapon(actor, item)) return;
  if (!canReroll(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const rolls = message.rolls ?? [];
  const wrap = document.createElement("div");
  wrap.className = "cst-gwf-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.disabled = !hasRerollableDice(rolls);
  btn.innerHTML = `<i class="fa-solid fa-dice"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.GreatWeaponFighting.RerollButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRerollClick(message, activity, item, actor);
      // Remove immediately rather than waiting on the message re-render the
      // "already rerolled" flag update triggers — deterministic, and doesn't
      // depend on this client's chat log fully re-rendering that message.
      wrap.remove();
    } catch (err) {
      warn("great weapon fighting reroll failed", err);
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  // dnd5e appends its GM-only <damage-application> ("Apply") widget last in
  // .message-content — insert before it so the reroll button reads above the
  // Apply section rather than below it. Players (no damage-application) fall
  // back to appending at the end.
  const damageApplication = container.querySelector("damage-application");
  if (damageApplication) container.insertBefore(wrap, damageApplication);
  else container.appendChild(wrap);
  dbg("dnd5e:gwf:button", actor.name, item.name, btn.disabled ? "no-rerollable-dice" : "enabled");
}

/** Register the Great Weapon Fighting reroll button. Call once during setup. */
export function registerGreatWeaponFightingHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderDamageMessage);
}
