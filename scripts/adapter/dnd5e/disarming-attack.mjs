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
 * dnd5e Fighter (Battle Master, 2014) "Disarming Attack": unlike Commander's
 * Strike (declared standalone, directs an ally), this maneuver is declared
 * against a SPECIFIC weapon attack ("when you hit a creature with a weapon
 * attack") — its entry point is a button on the ATTACK ROLL result message
 * (flags.dnd5e.roll.type === "attack"), NOT the pre-roll usage/activity card.
 * dnd5e posts these as two entirely separate chat messages: the usage card
 * (activity-card.hbs) carries the native Attack/Damage buttons in its own
 * .card-buttons row, while the attack roll itself is posted as its own later
 * message with no .card-buttons at all — just the d20 roll display
 * (confirmed against the installed dnd5e 5.x source: AttackActivity#rollAttack
 * always creates a new ChatMessage via D20Roll.buildPost). Because the native
 * Damage button lives only on that OTHER, earlier message, this maneuver
 * does NOT attach a listener to it — instead, USE arms this attack's die
 * against the shared maneuver-damage-dice registry (maneuver-damage-dice.mjs)
 * immediately, and that registry's single dnd5e.preRollDamageV2 listener adds
 * the die (and any other maneuver's die armed on the same activity) whenever
 * Damage is next rolled for that activity, from wherever the Damage button
 * actually is. No Damage-button relabeling — goading-attack.mjs established
 * this exact shape first; see its own doc comment for the full reasoning.
 * Spends from the same Combat Superiority pool as Commander's Strike. The
 * "Maneuver: Disarming Attack" item itself is NOT intercepted — clicking it
 * directly stays inert/cosmetic; all mechanics live behind this button.
 */

const DISARM_FLAG = "disarmingAttack"; // attack-roll message flags[MODULE_ID][DISARM_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-disarming-attack";
const REFUND_BTN_CLASS = "cst-disarming-attack-refund";
const CONTROLS_CLASS = "cst-disarming-attack-controls";

/** The actor's "Maneuver: Disarming Attack" feat, or null. */
function findDisarmingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: disarming attack", "maneuver-disarming-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleDisarmingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.DisarmingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-hand",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0.
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:disarming-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:disarming-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

export const pendingDisarmApplied = new Map(); // activity.uuid -> { dieSize, actorUuid } — consumed by onRenderDisarmDamageMessage

/** Build the REFUND RESOURCE button that replaces an armed DISARMING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onDisarmRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("disarming attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) DISARMING ATTACK button and wire its use-flow click handler. */
function buildFreshDisarmButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildDisarmButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleDisarmingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, "disarm", {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingDisarmApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${DISARM_FLAG}.consumed`, true);
        },
      });
      await message.setFlag(MODULE_ID, DISARM_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("disarming attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * DISARMING ATTACK button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — the shared maneuver-damage-dice
 * registry already drained and cleared this tag's entry by then, so only the
 * resource bookkeeping happens in that case).
 */
async function onDisarmRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, "disarm");
  await message.unsetFlag(MODULE_ID, DISARM_FLAG);

  const maneuver = findDisarmingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshDisarmButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:disarming-attack:refunded", actor?.name);
}

/** Build the DISARMING ATTACK button. */
function buildDisarmButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-hand" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the DISARMING ATTACK button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card. Wrapped in the shared
 * `.cst-<feature>-controls` flex-row shape (see CLAUDE.md's "Chat-card
 * action buttons" convention) since this message has no native
 * `.card-buttons` row to inherit styling from. If this specific roll
 * message is already armed (e.g. after a reload), re-decorate instead of
 * re-prompting — and only re-arm the shared maneuver-damage-dice registry
 * if the die hasn't already been consumed into a damage roll.
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

  const armed = message.getFlag(MODULE_ID, DISARM_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, "disarm", {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingDisarmApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${DISARM_FLAG}.consumed`, true);
        },
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findDisarmingAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshDisarmButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:disarming-attack:button", actor.name);
}

const SAVE_BTN_CLASS = "cst-disarming-attack-save";

/** 8 + the ability modifier used for the attack + the attacker's proficiency bonus (same shape as Topple's DC). */
function disarmingAttackDc(activity, actor) {
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
  const dc = disarmingAttackDc(activity, attacker);
  const targets = resolveSaveTargets();
  if (!targets.length) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoTargets"));
    return;
  }
  for (const target of targets) {
    await target.rollSavingThrow({ ability: "str", target: dc }, { configure: true }, {});
  }
  dbg("dnd5e:disarming-attack:saves", targets.map((t) => t.name), dc);
}

/**
 * dnd5e.renderChatMessage: append a Strength Save button to the damage
 * message an armed Disarming Attack die was just added to. The pending
 * activity->die/actor mapping (pendingDisarmApplied, set by the arm step's
 * onApplied callback once the shared maneuver-damage-dice registry drains
 * the die into a damage roll) is transferred onto the message's own flags on
 * first render so later re-renders (scroll, reload) still show the button
 * after the in-memory map entry is gone.
 */
function onRenderDisarmDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "disarmingAttackApplied");
  if (!applied) {
    const pending = pendingDisarmApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingDisarmApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "disarmingAttackApplied", applied);
  }

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${SAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-disarming-attack-save-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = SAVE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.SaveButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onStrengthSaveClick(activity, applied.actorUuid);
    } catch (err) {
      warn("disarming attack save failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  const damageApplication = container.querySelector("damage-application");
  if (damageApplication) container.insertBefore(wrap, damageApplication);
  else container.appendChild(wrap);
  dbg("dnd5e:disarming-attack:save-button", activity.item?.name);
}

/** Register Disarming Attack's activation flow. Call once during setup. */
export function registerDisarmingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderDisarmDamageMessage);
}
