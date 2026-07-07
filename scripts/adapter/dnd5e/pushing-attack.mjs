import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct, attackAbilityMod } from "./weapon-mastery.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";
import { armManeuverDie, disarmManeuverDie } from "./maneuver-damage-dice.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Pushing Attack": "When you hit a
 * creature with a weapon attack, you can expend one superiority die to
 * attempt to drive the target back. You add the superiority die to the
 * attack's damage roll, and if the target is Large or smaller, it must make
 * a Strength saving throw. On a failed save, you push the target up to 15
 * feet away from you." Same shape as Disarming Attack / Menacing Attack —
 * declared against a specific weapon attack, so its entry point is a button
 * on the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"),
 * not the pre-roll usage/activity card (see disarming-attack.mjs's own doc
 * comment for the full reasoning: the native Damage button lives on a
 * different, earlier message, so USE arms this attack's die against the
 * shared maneuver-damage-dice registry immediately rather than via a
 * Damage-button listener). Spends from the same Combat Superiority pool.
 * This module implements the die and a Strength-save prompt button on the
 * resulting damage message — not the push itself, nor the "Large or
 * smaller" size gate (not requested; matches Disarming Attack's own scope
 * of not automating the disarm).
 */

const PUSH_FLAG = "pushingAttack"; // attack-roll message flags[MODULE_ID][PUSH_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-pushing-attack";
const REFUND_BTN_CLASS = "cst-pushing-attack-refund";
const CONTROLS_CLASS = "cst-pushing-attack-controls";
const SOURCE_TAG = "push";

/** The actor's "Maneuver: Pushing Attack" feat, or null. */
function findPushingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: pushing attack", "maneuver-pushing-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handlePushingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.PushingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-hand-fist",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:pushing-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:pushing-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

export const pendingPushApplied = new Map(); // activity.uuid -> { dieSize, actorUuid } — consumed by onRenderPushDamageMessage (Phase 2)

/** Build the REFUND RESOURCE button that replaces an armed PUSHING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onPushRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("pushing attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) PUSHING ATTACK button and wire its use-flow click handler. */
function buildFreshPushButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildPushButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handlePushingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingPushApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${PUSH_FLAG}.consumed`, true);
        },
      });
      await message.setFlag(MODULE_ID, PUSH_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("pushing attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * PUSHING ATTACK button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — the shared maneuver-damage-dice
 * registry already drained and cleared this tag's entry by then, so only the
 * resource bookkeeping happens in that case).
 */
async function onPushRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, PUSH_FLAG);

  const maneuver = findPushingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshPushButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:pushing-attack:refunded", actor?.name);
}

/** Build the PUSHING ATTACK button. */
function buildPushButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-hand-fist" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the PUSHING ATTACK button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card. Wrapped in the shared
 * `.cst-<feature>-controls` flex-row shape since this message has no native
 * `.card-buttons` row to inherit styling from. If this specific roll message
 * is already armed (e.g. after a reload), re-decorate instead of
 * re-prompting — and only re-arm the shared maneuver-damage-dice registry if
 * the die hasn't already been consumed into a damage roll.
 */
function onRenderAttackRollMessage(message, html) {
  if (message.getFlag("dnd5e", "roll")?.type !== "attack") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return; // already injected this render

  const armed = message.getFlag(MODULE_ID, PUSH_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingPushApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${PUSH_FLAG}.consumed`, true);
        },
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findPushingAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshPushButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:pushing-attack:button", actor.name);
}

const SAVE_BTN_CLASS = "cst-pushing-attack-save";

/** 8 + the ability modifier used for the attack + the attacker's proficiency bonus (same DC shape as every Battle Master maneuver). */
function pushingAttackDc(activity, actor) {
  return 8 + attackAbilityMod(activity) + (actor?.system?.attributes?.prof ?? 0);
}

/** Every targeted actor, or every controlled actor if nothing is targeted. */
function resolveSaveTargets() {
  const targeted = Array.from(game.user?.targets ?? []).map((t) => t.actor).filter(Boolean);
  if (targeted.length) return targeted;
  return (canvas.tokens?.controlled ?? []).map((t) => t.actor).filter(Boolean);
}

async function onStrengthSaveClick(activity, actorUuid) {
  const attacker = fromUuidSync(actorUuid);
  const dc = pushingAttackDc(activity, attacker);
  const targets = resolveSaveTargets();
  if (!targets.length) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.NoTargets"));
    return;
  }
  for (const target of targets) {
    await target.rollSavingThrow({ ability: "str", target: dc }, { configure: true }, {});
  }
  dbg("dnd5e:pushing-attack:saves", targets.map((t) => t.name), dc);
}

/**
 * dnd5e.renderChatMessage: append a Strength Save button to the damage
 * message an armed Pushing Attack die was just added to. The pending
 * activity->die/actor mapping (pendingPushApplied, set by the arm step's
 * onApplied callback once the shared maneuver-damage-dice registry drains
 * the die into a damage roll) is transferred onto the message's own flags on
 * first render so later re-renders (scroll, reload) still show the button
 * after the in-memory map entry is gone.
 */
function onRenderPushDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "pushingAttackApplied");
  if (!applied) {
    const pending = pendingPushApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingPushApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "pushingAttackApplied", applied);
  }

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${SAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-pushing-attack-save-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = SAVE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.PushingAttack.SaveButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onStrengthSaveClick(activity, applied.actorUuid);
    } catch (err) {
      warn("pushing attack save failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:pushing-attack:save-button", activity.item?.name);
}

/** Register Pushing Attack's activation flow. Call once during setup. */
export function registerPushingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderPushDamageMessage);
}
