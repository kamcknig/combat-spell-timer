import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { armManeuverDie, disarmManeuverDie } from "./maneuver-damage-dice.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Riposte": "When a creature misses you
 * with a melee attack, you can use your reaction and expend one superiority
 * die to make a melee weapon attack against the creature. If you hit, you
 * add the superiority die to the attack's damage roll." Same shape as
 * Lunging Attack / Precision Attack — a button on the weapon's own pre-roll
 * USAGE CARD (.card-buttons, the same row as the native Attack/Damage
 * buttons — NOT the later ATTACK ROLL result message, which has no
 * .card-buttons of its own; see CLAUDE.md's "usage card vs attack-roll
 * message" note for the terminology), arming the shared maneuver-damage-dice
 * registry so the die lands on that attack's next Damage roll. Melee-only
 * per RAW: gated on activity.getActionType() === "mwak" at usage-card
 * render time — same acceptable edge case Lunging Attack's own gate has (no
 * attack mode has been chosen yet at usage-card time, so a thrown weapon
 * later attacked at range is undetectable here). The reaction trigger itself
 * ("when a creature misses you") is not automated — matches every other
 * maneuver's scope of not enforcing full RAW trigger/action-economy
 * conditions.
 */

const RIPOSTE_FLAG = "riposte"; // usage-card message flags[MODULE_ID][RIPOSTE_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-riposte";
const REFUND_BTN_CLASS = "cst-riposte-refund";
const SOURCE_TAG = "riposte";

/** The actor's "Maneuver: Riposte" feat, or null. */
function findRiposteManeuver(actor) {
  return findFeat(actor, "maneuver: riposte", "maneuver-riposte");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleRiposteUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Riposte.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.Riposte.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-shield",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Riposte.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:riposte:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:riposte:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Build the REFUND RESOURCE button that replaces an armed RIPOSTE button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRiposteRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("riposte refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) RIPOSTE button and wire its use-flow click handler. */
function buildFreshRiposteButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildRiposteButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleRiposteUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${RIPOSTE_FLAG}.consumed`, true),
      });
      await message.setFlag(MODULE_ID, RIPOSTE_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("riposte failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh RIPOSTE
 * button. Cancels the pending damage-die addition too (a no-op if Damage
 * was already rolled — the shared maneuver-damage-dice registry already
 * drained and cleared this tag's entry by then, so only the resource
 * bookkeeping happens in that case).
 */
async function onRiposteRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, RIPOSTE_FLAG);

  const maneuver = findRiposteManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshRiposteButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:riposte:refunded", actor?.name);
}

/** Build the RIPOSTE button. */
function buildRiposteButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.Riposte.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.Riposte.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage: append a RIPOSTE button directly into a melee
 * weapon's own pre-roll usage card (Activity#use()'s _createUsageMessage,
 * template chat/activity-card.hbs) — inserted into dnd5e's own
 * .card-buttons flex column alongside the native Attack/Damage buttons
 * (native styling, no wrapper/custom CSS needed — same placement Weapon
 * Mastery's Graze/Topple, Commander's Strike's own button, and Lunging
 * Attack use). If this specific card is already armed (e.g. after a
 * reload), re-decorate instead of re-prompting — and only re-arm the shared
 * registry if the die hasn't already been consumed into a damage roll.
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

  const armed = message.getFlag(MODULE_ID, RIPOSTE_FLAG);
  if (armed) {
    if (container.querySelector(`.${REFUND_BTN_CLASS}`)) return; // already injected this render
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${RIPOSTE_FLAG}.consumed`, true),
      });
    }
    container.appendChild(buildRefundButton(message, container, activity, armed));
    return;
  }

  if (container.querySelector(`.${BTN_CLASS}`)) return; // already injected this render
  const maneuver = findRiposteManeuver(actor);
  if (!maneuver) return;

  container.appendChild(buildFreshRiposteButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:riposte:button", actor.name);
}

/** Register Riposte's activation flow. Call once during setup. */
export function registerRiposteHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderUsageCard);
}
