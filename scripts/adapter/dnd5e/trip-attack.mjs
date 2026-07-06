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
 * dnd5e Fighter (Battle Master, 2014) "Trip Attack": "When you hit a
 * creature with a weapon attack, you can expend one superiority die to
 * attempt to knock the target down. You add the superiority die to the
 * attack's damage roll, and the target must make a Strength saving throw.
 * On a failed save, you knock the target prone." Same shape as Pushing
 * Attack — declared against a specific weapon attack, so its entry point is
 * a button on the ATTACK ROLL result message (flags.dnd5e.roll.type ===
 * "attack"), not the pre-roll usage/activity card. Spends from the same
 * Combat Superiority pool. Unlike Pushing Attack (which only prompts the
 * save and leaves the consequence manual), Trip Attack automates its
 * consequence: a failed save applies the core "prone" status effect,
 * mirroring Weapon Mastery's Topple (weapon-mastery.mjs#onToppleSaveClick).
 */

const TRIP_FLAG = "tripAttack"; // attack-roll message flags[MODULE_ID][TRIP_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-trip-attack";
const REFUND_BTN_CLASS = "cst-trip-attack-refund";
const CONTROLS_CLASS = "cst-trip-attack-controls";
const SOURCE_TAG = "trip";

/** The actor's "Maneuver: Trip Attack" feat, or null. */
function findTripAttackManeuver(actor) {
  return findFeat(actor, "maneuver: trip attack", "maneuver-trip-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleTripAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.TripAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-person-falling",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:trip-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:trip-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

export const pendingTripApplied = new Map(); // activity.uuid -> { dieSize, actorUuid } — consumed by onRenderTripDamageMessage (Phase 2)

/** Build the REFUND RESOURCE button that replaces an armed TRIP ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onTripRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("trip attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) TRIP ATTACK button and wire its use-flow click handler. */
function buildFreshTripButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildTripButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleTripAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingTripApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${TRIP_FLAG}.consumed`, true);
        },
      });
      await message.setFlag(MODULE_ID, TRIP_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("trip attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * TRIP ATTACK button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — the shared maneuver-damage-dice
 * registry already drained and cleared this tag's entry by then, so only the
 * resource bookkeeping happens in that case).
 */
async function onTripRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, TRIP_FLAG);

  const maneuver = findTripAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshTripButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:trip-attack:refunded", actor?.name);
}

/** Build the TRIP ATTACK button. */
function buildTripButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-person-falling" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the TRIP ATTACK button into
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

  const armed = message.getFlag(MODULE_ID, TRIP_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => {
          pendingTripApplied.set(activity.uuid, { dieSize: armed.dieSize, actorUuid: armed.actorUuid });
          message.setFlag(MODULE_ID, `${TRIP_FLAG}.consumed`, true);
        },
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findTripAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshTripButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:trip-attack:button", actor.name);
}

const SAVE_BTN_CLASS = "cst-trip-attack-save";

/** 8 + the ability modifier used for the attack + the attacker's proficiency bonus (same DC shape as every Battle Master maneuver). */
function tripAttackDc(activity, actor) {
  return 8 + attackAbilityMod(activity) + (actor?.system?.attributes?.prof ?? 0);
}

/** Every targeted actor, or every controlled actor if nothing is targeted. */
function resolveSaveTargets() {
  const targeted = Array.from(game.user?.targets ?? []).map((t) => t.actor).filter(Boolean);
  if (targeted.length) return targeted;
  return (canvas.tokens?.controlled ?? []).map((t) => t.actor).filter(Boolean);
}

/**
 * Roll a Strength save for every resolved target and knock any that fail
 * prone, mirroring Weapon Mastery's Topple (weapon-mastery.mjs#onToppleSaveClick)
 * but applied per-target instead of to a single creature, matching Pushing
 * Attack's/Menacing Attack's multi-target save-button convention.
 */
async function onStrengthSaveClick(activity, actorUuid) {
  const attacker = fromUuidSync(actorUuid);
  const dc = tripAttackDc(activity, attacker);
  const targets = resolveSaveTargets();
  if (!targets.length) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.NoTargets"));
    return;
  }
  for (const target of targets) {
    const rolls = await target.rollSavingThrow({ ability: "str", target: dc }, {}, {});
    const failed = rolls?.[0] && rolls[0].isSuccess === false;
    dbg("dnd5e:trip-attack:save", target.name, dc, failed ? "failed" : "saved");
    if (failed) await target.toggleStatusEffect("prone", { active: true });
  }
}

/**
 * dnd5e.renderChatMessage: append a Strength Save button to the damage
 * message an armed Trip Attack die was just added to. The pending
 * activity->die/actor mapping (pendingTripApplied, set by the arm step's
 * onApplied callback once the shared maneuver-damage-dice registry drains
 * the die into a damage roll) is transferred onto the message's own flags on
 * first render so later re-renders (scroll, reload) still show the button
 * after the in-memory map entry is gone.
 */
function onRenderTripDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "tripAttackApplied");
  if (!applied) {
    const pending = pendingTripApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingTripApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "tripAttackApplied", applied);
  }

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${SAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-trip-attack-save-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = SAVE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.TripAttack.SaveButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onStrengthSaveClick(activity, applied.actorUuid);
    } catch (err) {
      warn("trip attack save failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:trip-attack:save-button", activity.item?.name);
}

/** Register Trip Attack's activation flow. Call once during setup. */
export function registerTripAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderTripDamageMessage);
}
