import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";
import { armManeuverDie, disarmManeuverDie } from "./maneuver-damage-dice.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Quick Toss": "As a bonus action, you
 * can expend one superiority die and make a ranged attack with a weapon that
 * has the thrown property. You can draw the weapon as part of making this
 * attack. If you hit, add the superiority die to the weapon's damage roll."
 * The bonus-action/draw-the-weapon action economy is cosmetic/table-tracked,
 * same treatment every other maneuver's unenforced action-economy text gets.
 * Mechanically this is Maneuvering Attack's exact shape (attack-roll-message
 * button arming the shared maneuver-damage-dice registry, refundable) with
 * one added eligibility gate: the attack must be RANGED (`rwak`) and made
 * with an equipped-or-not weapon carrying the Thrown property
 * (`item.system.properties.has("thr")`, confirmed in
 * thrown-weapon-fighting.mjs) — not required to be equipped, since RAW's own
 * "draw as part of the attack" clause covers a stowed weapon.
 *
 * `Activity#getActionType(attackMode="")` (dnd5e.mjs:12524) only reclassifies
 * "mwak" to "rwak" when the passed-in `attackMode` string starts with
 * "thrown" or equals "ranged" — called with no argument it just returns the
 * item's base `actionType` ("mwak" for a dagger, always, whether or not that
 * specific attack was actually thrown). The real per-roll attack mode has to
 * be read off the ATTACK message's own flag instead:
 * `message.getFlag("dnd5e", "roll")?.attackMode` — the same flag dnd5e's own
 * native Damage-button handler reads (`AttackActivity.#rollDamage`,
 * dnd5e.mjs:28654: `lastAttack?.getFlag("dnd5e", "roll.attackMode")`) to
 * resolve which mode the just-completed attack used before rolling damage.
 */

const QUICK_TOSS_FLAG = "quickToss"; // attack-roll message flags[MODULE_ID][QUICK_TOSS_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-quick-toss";
const REFUND_BTN_CLASS = "cst-quick-toss-refund";
const CONTROLS_CLASS = "cst-quick-toss-controls";
const SOURCE_TAG = "quick-toss";

/** The actor's "Maneuver: Quick Toss" feat, or null. */
function findQuickTossManeuver(actor) {
  return findFeat(actor, "maneuver: quick toss", "maneuver-quick-toss");
}

/** True when `item` has the Thrown property and this specific roll's attack mode resolves to ranged. */
function isThrownRangedAttack(activity, item, attackMode) {
  if (item?.type !== "weapon") return false;
  if (!item.system?.properties?.has("thr")) return false;
  return activity?.getActionType?.(attackMode) === "rwak";
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleQuickTossUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.QuickToss.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.QuickToss.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-paper-plane",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.QuickToss.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:quick-toss:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no follow-up marker
  dbg("dnd5e:quick-toss:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Build the REFUND RESOURCE button that replaces an armed QUICK TOSS button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onQuickTossRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("quick toss refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) QUICK TOSS button and wire its use-flow click handler. */
function buildFreshQuickTossButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildQuickTossButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleQuickTossUse(maneuver);
      if (!result) { btn.disabled = false; return; }
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${QUICK_TOSS_FLAG}.consumed`, true),
      });
      await message.setFlag(MODULE_ID, QUICK_TOSS_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("quick toss failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * QUICK TOSS button. Cancels the pending damage-die addition too (a no-op if
 * Damage was already rolled — the shared maneuver-damage-dice registry
 * already drained and cleared this tag's entry by then, so only the resource
 * bookkeeping happens in that case).
 */
async function onQuickTossRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, QUICK_TOSS_FLAG);

  const maneuver = findQuickTossManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshQuickTossButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:quick-toss:refunded", actor?.name);
}

/** Build the QUICK TOSS button. */
function buildQuickTossButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-paper-plane" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.QuickToss.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.QuickToss.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the QUICK TOSS button into the
 * ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not the
 * pre-roll usage/activity card — same entry point as Maneuvering Attack.
 * Ranged + Thrown-property only, per RAW.
 */
function onRenderAttackRollMessage(message, html) {
  if (message.getFlag("dnd5e", "roll")?.type !== "attack") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  const attackMode = message.getFlag("dnd5e", "roll")?.attackMode;
  if (!isThrownRangedAttack(activity, item, attackMode)) return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return; // already injected this render

  const armed = message.getFlag(MODULE_ID, QUICK_TOSS_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${QUICK_TOSS_FLAG}.consumed`, true),
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findQuickTossManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshQuickTossButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:quick-toss:button", actor.name);
}

/** Register Quick Toss's activation flow. Call once during setup. */
export function registerQuickTossHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
}
