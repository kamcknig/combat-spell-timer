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
 * dnd5e Fighter (Battle Master, 2014) "Maneuvering Attack": "When you hit a
 * creature with a weapon attack, you can expend one superiority die to
 * maneuver one of your comrades into a more advantageous position. You add
 * the superiority die to the attack's damage roll, and you choose a friendly
 * creature who can see or hear you. That creature can use its reaction to
 * move up to half its speed without provoking opportunity attacks from the
 * target of your attack." The ally reaction-move is table-tracked/cosmetic
 * (same rigor Lunging Attack's reach increase and Disarming Attack's disarm
 * get) — this module implements only the die. Same shape as Disarming
 * Attack / Distracting Strike / Goading Attack's weapon-card entry: declared
 * against a specific weapon attack, so its entry point is a button on the
 * ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not the
 * pre-roll usage/activity card (see disarming-attack.mjs's own doc comment
 * for the full reasoning — the native Damage button lives on a different,
 * earlier message, so USE arms this attack's die against the shared
 * maneuver-damage-dice registry immediately rather than via a Damage-button
 * listener). Spends from the same Combat Superiority pool. Unlike Distracting
 * Attack/Goading Attack, there is no follow-up marker or apply-effects tray
 * — nothing to track beyond the die itself.
 */

const MANEUVER_FLAG = "maneuveringAttack"; // attack-roll message flags[MODULE_ID][MANEUVER_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-maneuvering-attack";
const REFUND_BTN_CLASS = "cst-maneuvering-attack-refund";
const CONTROLS_CLASS = "cst-maneuvering-attack-controls";
const SOURCE_TAG = "maneuver-attack";

/** The actor's "Maneuver: Maneuvering Attack" feat, or null. */
function findManeuveringAttackManeuver(actor) {
  return findFeat(actor, "maneuver: maneuvering attack", "maneuver-maneuvering-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleManeuveringAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.ManeuveringAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.ManeuveringAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-route",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.ManeuveringAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:maneuvering-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no follow-up marker
  dbg("dnd5e:maneuvering-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Build the REFUND RESOURCE button that replaces an armed MANEUVERING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onManeuverRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("maneuvering attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) MANEUVERING ATTACK button and wire its use-flow click handler. */
function buildFreshManeuverButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildManeuverButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleManeuveringAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; }
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${MANEUVER_FLAG}.consumed`, true),
      });
      await message.setFlag(MODULE_ID, MANEUVER_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("maneuvering attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * MANEUVERING ATTACK button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — the shared maneuver-damage-dice
 * registry already drained and cleared this tag's entry by then, so only the
 * resource bookkeeping happens in that case).
 */
async function onManeuverRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmManeuverDie(activity, SOURCE_TAG);
  await message.unsetFlag(MODULE_ID, MANEUVER_FLAG);

  const maneuver = findManeuveringAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshManeuverButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:maneuvering-attack:refunded", actor?.name);
}

/** Build the MANEUVERING ATTACK button. */
function buildManeuverButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-route" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.ManeuveringAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.ManeuveringAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the MANEUVERING ATTACK button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card. Wrapped in the shared
 * `.cst-<feature>-controls` flex-row shape (see CLAUDE.md's "Chat-card
 * action buttons" convention) since this message has no native
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

  const armed = message.getFlag(MODULE_ID, MANEUVER_FLAG);
  if (armed) {
    if (!armed.consumed) {
      armManeuverDie(activity, SOURCE_TAG, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${MANEUVER_FLAG}.consumed`, true),
      });
    }
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findManeuveringAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshManeuverButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:maneuvering-attack:button", actor.name);
}

/** Register Maneuvering Attack's activation flow. Call once during setup. */
export function registerManeuveringAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
}
