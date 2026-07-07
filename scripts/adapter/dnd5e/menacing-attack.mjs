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
 * dnd5e Fighter (Battle Master, 2014) "Menacing Attack": "When you hit a
 * creature with a weapon attack, you can expend one superiority die to
 * attempt to frighten the target. You add the superiority die to the
 * attack's damage roll, and the target must make a Wisdom saving throw. On
 * a failed save, it is frightened of you until the end of your next turn."
 * Same shape as Disarming Attack — declared against a specific weapon
 * attack, so its entry point is a button on the ATTACK ROLL result message
 * (flags.dnd5e.roll.type === "attack"), not the pre-roll usage/activity card
 * (see disarming-attack.mjs's own doc comment for the full reasoning: the
 * native Damage button lives on a different, earlier message, so USE arms
 * this attack's die against the shared maneuver-damage-dice registry
 * immediately rather than via a Damage-button listener). Spends from the
 * same Combat Superiority pool. This module implements the die and a
 * Wisdom-save prompt button on the resulting damage message — not the
 * frightened condition itself (not requested; matches Disarming Attack's own
 * scope of not automating the disarm).
 */

const MENACE_FLAG = "menacingAttack"; // attack-roll message flags[MODULE_ID][MENACE_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-menacing-attack";
const REFUND_BTN_CLASS = "cst-menacing-attack-refund";
const CONTROLS_CLASS = "cst-menacing-attack-controls";
const SOURCE_TAG = "menace";

/** The actor's "Maneuver: Menacing Attack" feat, or null. */
function findMenacingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: menacing attack", "maneuver-menacing-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleMenacingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.MenacingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-ghost",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:menacing-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:menacing-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

export const pendingMenaceApplied = new Map(); // activity.uuid -> { dieSize, actorUuid } — consumed by onRenderMenaceDamageMessage (Phase 2)

/** Build the REFUND RESOURCE button that replaces an armed MENACING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onMenaceRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("menacing attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) MENACING ATTACK button and wire its use-flow click handler. */
function buildFreshMenaceButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildMenaceButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleMenacingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingMenaceApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${MENACE_FLAG}.consumed`, true);
        },
      });
      await message.setFlag(MODULE_ID, MENACE_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("menacing attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * MENACING ATTACK button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — the shared maneuver-damage-dice
 * registry already drained and cleared this tag's entry by then, so only the
 * resource bookkeeping happens in that case).
 */
async function onMenaceRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, MENACE_FLAG);

  const maneuver = findMenacingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshMenaceButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:menacing-attack:refunded", actor?.name);
}

/** Build the MENACING ATTACK button. */
function buildMenaceButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-ghost" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the MENACING ATTACK button into
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

  const armed = message.getFlag(MODULE_ID, MENACE_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingMenaceApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${MENACE_FLAG}.consumed`, true);
        },
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findMenacingAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshMenaceButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:menacing-attack:button", actor.name);
}

const SAVE_BTN_CLASS = "cst-menacing-attack-save";

/** 8 + the ability modifier used for the attack + the attacker's proficiency bonus (same DC shape as every Battle Master maneuver). */
function menacingAttackDc(activity, actor) {
  return 8 + attackAbilityMod(activity) + (actor?.system?.attributes?.prof ?? 0);
}

/** Every targeted actor, or every controlled actor if nothing is targeted. */
function resolveSaveTargets() {
  const targeted = Array.from(game.user?.targets ?? []).map((t) => t.actor).filter(Boolean);
  if (targeted.length) return targeted;
  return (canvas.tokens?.controlled ?? []).map((t) => t.actor).filter(Boolean);
}

async function onWisdomSaveClick(activity, actorUuid) {
  const attacker = fromUuidSync(actorUuid);
  const dc = menacingAttackDc(activity, attacker);
  const targets = resolveSaveTargets();
  if (!targets.length) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.NoTargets"));
    return;
  }
  for (const target of targets) {
    await target.rollSavingThrow({ ability: "wis", target: dc }, { configure: true }, {});
  }
  dbg("dnd5e:menacing-attack:saves", targets.map((t) => t.name), dc);
}

/**
 * dnd5e.renderChatMessage: append a Wisdom Save button to the damage message
 * an armed Menacing Attack die was just added to. The pending
 * activity->die/actor mapping (pendingMenaceApplied, set by the arm step's
 * onApplied callback once the shared maneuver-damage-dice registry drains
 * the die into a damage roll) is transferred onto the message's own flags on
 * first render so later re-renders (scroll, reload) still show the button
 * after the in-memory map entry is gone.
 */
function onRenderMenaceDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "menacingAttackApplied");
  if (!applied) {
    const pending = pendingMenaceApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingMenaceApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "menacingAttackApplied", applied);
  }

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${SAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-menacing-attack-save-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = SAVE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.MenacingAttack.SaveButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onWisdomSaveClick(activity, applied.actorUuid);
    } catch (err) {
      warn("menacing attack save failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:menacing-attack:save-button", activity.item?.name);
}

/** Register Menacing Attack's activation flow. Call once during setup. */
export function registerMenacingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderMenaceDamageMessage);
}
