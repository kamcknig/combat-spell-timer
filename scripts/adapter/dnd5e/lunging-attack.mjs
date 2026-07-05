import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { armManeuverDie, disarmManeuverDie } from "./maneuver-damage-dice.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Lunging Attack": "When you make a
 * melee weapon attack on your turn, you can expend one superiority die to
 * increase your reach for that attack by 5 feet. If you hit, you add the
 * superiority die to the attack's damage roll." The reach increase is
 * table-tracked/cosmetic (same rigor Disarming Attack's disarm and
 * Distracting Strike's distraction get) — this module implements the die.
 * Unlike Disarming/Distracting/Goading (declared reactively against a
 * landed hit, so their button lives on the ATTACK ROLL result message),
 * Lunging Attack is declared BEFORE the attack roll — it changes the
 * attack's own reach — so its button lives on the weapon's own pre-roll
 * usage card (.card-buttons, the same row as the native Attack/Damage
 * buttons; see weapon-mastery.mjs's Graze/Topple and commanders-strike.mjs's
 * own usage-card button for the established pattern — native styling, no
 * wrapper/custom CSS needed). Melee-only per RAW: gated on
 * activity.getActionType() === "mwak" at button-render time (no attack mode
 * has been chosen yet at usage-card time, so a thrown weapon later attacked
 * at range is an undetectable, acceptable edge case here — see
 * thrown-weapon-fighting.mjs, which applies its own melee/ranged check at
 * roll time instead, where the mode is known). Damage-die arming/draining
 * goes through the shared maneuver-damage-dice registry so it compounds
 * correctly alongside Disarming Attack / Distracting Strike / Goading
 * Attack on the same attack. Spends from the same Combat Superiority pool.
 * The "Maneuver: Lunging Attack" item itself is NOT intercepted — clicking
 * it directly stays inert/cosmetic; all mechanics live behind this button.
 */

const LUNGE_FLAG = "lungingAttack"; // usage-card message flags[MODULE_ID][LUNGE_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-lunging-attack";
const REFUND_BTN_CLASS = "cst-lunging-attack-refund";
const SOURCE_TAG = "lunge";

/** The actor's "Maneuver: Lunging Attack" feat, or null. */
function findLungingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: lunging attack", "maneuver-lunging-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleLungingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.LungingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.LungingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-person-running",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.LungingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:lunging-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no dnd5e.preDisplayCard interception for this item
  dbg("dnd5e:lunging-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Build the REFUND RESOURCE button that replaces an armed LUNGING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onLungeRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("lunging attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) LUNGING ATTACK button and wire its use-flow click handler. */
function buildFreshLungeButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildLungeButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleLungingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${LUNGE_FLAG}.consumed`, true),
      });
      await message.setFlag(MODULE_ID, LUNGE_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("lunging attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Refund the spent Combat Superiority die and swap back to a fresh LUNGING ATTACK button. */
async function onLungeRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, LUNGE_FLAG);

  const maneuver = findLungingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshLungeButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:lunging-attack:refunded", actor?.name);
}

/** Build the LUNGING ATTACK button. */
function buildLungeButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-person-running"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.LungingAttack.Button")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.LungingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage: append a LUNGING ATTACK button directly into a
 * melee weapon's own pre-roll usage card (Activity#use()'s
 * _createUsageMessage, template chat/activity-card.hbs) — inserted into
 * dnd5e's own .card-buttons flex column alongside the native Attack/Damage
 * buttons (native styling, no wrapper/custom CSS needed — same placement
 * Weapon Mastery's Graze/Topple and Commander's Strike's own button use). If
 * this specific card is already armed (e.g. after a reload), re-decorate
 * instead of re-prompting — and only re-arm the shared registry if the die
 * hasn't already been consumed into a damage roll.
 */
function onRenderUsageCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (activity.getActionType?.() !== "mwak") return; // melee only, per RAW
  if (!canAct(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container) return;

  const armed = message.getFlag(MODULE_ID, LUNGE_FLAG);
  if (armed) {
    if (container.querySelector(`.${REFUND_BTN_CLASS}`)) return; // already injected this render
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${LUNGE_FLAG}.consumed`, true),
      });
    }
    container.appendChild(buildRefundButton(message, container, activity, armed));
    return;
  }

  if (container.querySelector(`.${BTN_CLASS}`)) return; // already injected this render
  const maneuver = findLungingAttackManeuver(actor);
  if (!maneuver) return;

  container.appendChild(buildFreshLungeButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:lunging-attack:button", actor.name);
}

/** Register Lunging Attack's activation flow. Call once during setup. */
export function registerLungingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderUsageCard);
}
