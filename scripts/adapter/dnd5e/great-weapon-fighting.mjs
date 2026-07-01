import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { findFeat, isModernRules } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Great Weapon Fighting":
 *  - 2014 PHB: "When you roll a 1 or 2 on a damage die for an attack you make
 *    with a melee weapon that you are wielding with two hands, you can
 *    reroll the die and must use the new roll, even if the new roll is a 1
 *    or a 2."
 *  - 2024 PHB: same trigger and weapon condition, but "you can treat the
 *    roll as a 3" instead of rerolling — the die itself is never re-rolled.
 * Both editions keep the same two-handed/versatile + only-equipped-weapon
 * condition, and the same "player's optional choice, decided after seeing
 * the dice" shape — so both are served by the one button, branching only on
 * isModernRules() for which dice mechanic to apply. Unlike Archery/Dueling (a
 * flat bonus folded into the roll formula before it's evaluated), this can't
 * be a pre-roll hook in either edition — there is no pre-roll signal for
 * "will this roll contain a 1 or 2." Implemented as a button on the
 * already-rendered damage-roll chat message: enabled when the roll contains
 * a qualifying 1/2, and on click, applies the edition-correct benefit to
 * just those dice (2014: Die.prototype.reroll("r<=2"); 2024:
 * Die.prototype.minimum("min3") — both public Foundry core DiceTerm methods,
 * safe to call post-hoc) and posts a new chat message in the same card
 * format. See thoughts/shared/plans/2026-07-01-fighter-great-weapon-fighting.md
 * and thoughts/shared/plans/2026-07-01-fighting-style-2024-rules.md for the
 * full source-verified rationale.
 */

const GWF_NAME = "fighting style: great weapon fighting";
const GWF_IDENTIFIER = "fighting-style-great-weapon-fighting";
const GWF_APPLIED_FLAG = "gwfApplied";
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

/** True when any active die result across every roll is currently a 1 or 2 — the trigger condition in both editions. */
function hasQualifyingDice(rolls) {
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
 * Apply the Great Weapon Fighting benefit to every active 1/2 die result on
 * every DiceTerm across `rolls`, once each, then fix each roll's cached
 * total (Roll#total is not a live getter; DiceTerm#total is, but Roll#_total
 * is only set during evaluate()).
 *  - 2014 (legacy): Die#reroll("r<=2") — recursive:false by default matches
 *    "must use the new roll, even if it's a 1 or 2" exactly.
 *  - 2024 (modern): Die#minimum("min3") — synchronous; sets result.count = 3
 *    without discarding the original rolled value (result.result), matching
 *    "treat the roll as a 3" rather than an actual reroll. (The tooltip
 *    still shows the original rolled number, dimmed via the same .rerolled
 *    CSS class reroll() benefits from — the counted 3 is reflected in the
 *    total; see the plan's Decision on not annotating it inline.)
 * @param {DamageRoll[]} rolls
 * @returns {Promise<{rolls: DamageRoll[], mode: "reroll"|"clamp"}>}
 */
async function applyGreatWeaponFightingBenefit(rolls) {
  const { DiceTerm } = foundry.dice.terms;
  const modern = isModernRules();
  for (const roll of rolls) {
    for (const term of roll.terms) {
      if (!(term instanceof DiceTerm)) continue;
      if (modern) {
        if (typeof term.minimum === "function") term.minimum("min3");
      } else if (typeof term.reroll === "function") {
        await term.reroll("r<=2");
      }
    }
    roll._total = roll._evaluateTotal();
  }
  return { rolls, mode: modern ? "clamp" : "reroll" };
}

/**
 * Apply the edition-correct benefit to a clone of the message's rolls and
 * post the result as a new damage-roll chat message, mirroring the same
 * flags/flavor/speaker shape Activity#rollDamage itself uses so it renders
 * with an identical card look. BOTH the original message and the NEW message
 * are flagged "already applied" — the new message needs it too, since a 2014
 * reroll can itself land on another 1 or 2 (the rule explicitly allows this),
 * which would otherwise make onRenderDamageMessage show a second button on
 * the follow-up message. No further benefit is allowed in either edition.
 */
async function onRerollClick(message, activity, item, actor) {
  const { rolls: applied, mode } = await applyGreatWeaponFightingBenefit(cloneRolls(message.rolls ?? []));
  const flavorKey = mode === "clamp"
    ? "COMBAT_SPELL_TIMER.GreatWeaponFighting.ClampFlavor"
    : "COMBAT_SPELL_TIMER.GreatWeaponFighting.RerollFlavor";
  await CONFIG.Dice.DamageRoll.toMessage(applied, {
    flavor: `${item.name} - ${game.i18n.localize(flavorKey)}`,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: {
      dnd5e: {
        ...activity.messageFlags,
        messageType: "roll",
        roll: { type: "damage" },
        originatingMessage: message.id,
      },
      [MODULE_ID]: { [GWF_APPLIED_FLAG]: true },
    },
  });
  dbg("dnd5e:gwf:apply", actor.name, item.name, mode);
  await message.update({ flags: { [MODULE_ID]: { [GWF_APPLIED_FLAG]: true } } });
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
  if (message.getFlag(MODULE_ID, GWF_APPLIED_FLAG)) return;
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
  btn.disabled = !hasQualifyingDice(rolls);
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
