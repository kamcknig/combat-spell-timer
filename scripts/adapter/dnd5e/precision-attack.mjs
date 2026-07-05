import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Precision Attack": "When you make a
 * weapon attack roll against a creature, you can expend one superiority die
 * to add it to the roll. You can use this maneuver before or after making
 * the attack roll, but before any effects of the attack are applied." Unlike
 * Disarming/Goading/Maneuvering/Menacing Attack (declared reactively against
 * a landed hit, so their button lives on the ATTACK ROLL result message),
 * Precision Attack boosts the attack roll itself and is declared before it
 * resolves — so its button lives on the weapon's own pre-roll usage card
 * (.card-buttons, the same row as the native Attack/Damage buttons; see
 * lunging-attack.mjs's own doc comment and commanders-strike.mjs's usage-card
 * button for the established pattern — native styling, no wrapper/custom CSS
 * needed). No melee-only restriction (unlike Lunging Attack) — RAW says "a
 * weapon attack roll," not "a melee weapon attack."
 *
 * Because this is the only Battle Master maneuver that boosts the ATTACK
 * roll rather than the damage roll, it does not reuse the shared
 * maneuver-damage-dice.mjs registry (damage-roll-specific, and a one-consumer
 * abstraction isn't worth generalizing yet). Instead it keeps its own small
 * pending-die Map, drained via the attack-roll equivalent of that registry's
 * two-hook split: dnd5e.preRollAttackV2 appends the die to the pending
 * roll's parts non-destructively (fires before the roll-configuration dialog
 * even shows — the roll can still be cancelled or retried), and
 * dnd5e.postAttackRollConfiguration (confirmed against the installed dnd5e
 * source, BasicRoll.buildConfigure: hookNames includes "attack" for
 * Activity#rollAttack, producing dnd5e.preRollAttackV2 / dnd5e.postAttackRollConfiguration
 * exactly like the damage-roll pair dnd5e.preRollDamageV2 /
 * dnd5e.postDamageRollConfiguration) is the real commit point — rolls is
 * empty if the dialog was cancelled, so nothing commits then.
 */

const PRECISION_FLAG = "precisionAttack"; // usage-card message flags[MODULE_ID][PRECISION_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-precision-attack";
const REFUND_BTN_CLASS = "cst-precision-attack-refund";

/** The actor's "Maneuver: Precision Attack" feat, or null. */
function findPrecisionAttackManeuver(actor) {
  return findFeat(actor, "maneuver: precision attack", "maneuver-precision-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handlePrecisionAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.PrecisionAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.PrecisionAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-bullseye",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.PrecisionAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:precision-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no dnd5e.preDisplayCard interception for this item
  dbg("dnd5e:precision-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

const pendingPrecisionAttack = new Map(); // activity.uuid -> { dieSize, onApplied }

/** Arm `activity`'s die (overwrites any existing entry for the same activity). */
function armPrecisionDie(activity, { dieSize, onApplied }) {
  if (!activity) return;
  pendingPrecisionAttack.set(activity.uuid, { dieSize, onApplied });
}

/** Remove `activity`'s armed die. No-op if already consumed or never armed. */
function disarmPrecisionDie(activity) {
  pendingPrecisionAttack.delete(activity?.uuid);
}

/**
 * dnd5e.preRollAttackV2: append the pending Precision Attack die to the
 * attack roll's parts — non-destructive, so a cancelled/retried roll simply
 * re-appends the same armed die again next time.
 */
function onPrecisionPreRollAttack(config) {
  const activity = config?.subject;
  const armed = activity && pendingPrecisionAttack.get(activity.uuid);
  if (!armed) return;
  const roll = config.rolls?.[0];
  if (roll) roll.parts = [...(roll.parts ?? []), `1${armed.dieSize}`];
  dbg("dnd5e:precision-attack:die-appended", activity.item?.name, armed.dieSize);
}

/**
 * dnd5e.postAttackRollConfiguration: the real commit point — fires right
 * after the attack roll-configuration dialog resolves, with the built (but
 * not yet evaluated) rolls. Empty `rolls` means the dialog was cancelled, so
 * nothing commits. Deletes the pending entry and fires its `onApplied`
 * callback (flips the originating usage card's `consumed` flag).
 */
function onPrecisionPostRollAttackConfiguration(rolls, config) {
  if (!rolls?.length) return; // dialog was cancelled — nothing to commit
  const activity = config?.subject;
  const armed = activity && pendingPrecisionAttack.get(activity.uuid);
  if (!armed) return;
  pendingPrecisionAttack.delete(activity.uuid);
  armed.onApplied?.(activity);
  dbg("dnd5e:precision-attack:die-applied", activity.item?.name, armed.dieSize);
}

/** Build the REFUND RESOURCE button that replaces an armed PRECISION ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onPrecisionRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("precision attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) PRECISION ATTACK button and wire its use-flow click handler. */
function buildFreshPrecisionButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildPrecisionButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handlePrecisionAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      armPrecisionDie(activity, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${PRECISION_FLAG}.consumed`, true),
      });
      await message.setFlag(MODULE_ID, PRECISION_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("precision attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Refund the spent Combat Superiority die and swap back to a fresh PRECISION ATTACK button. */
async function onPrecisionRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  disarmPrecisionDie(activity);
  await message.unsetFlag(MODULE_ID, PRECISION_FLAG);

  const maneuver = findPrecisionAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshPrecisionButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:precision-attack:refunded", actor?.name);
}

/** Build the PRECISION ATTACK button. */
function buildPrecisionButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-bullseye"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.PrecisionAttack.Button")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.PrecisionAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage: append a PRECISION ATTACK button directly into a
 * weapon's own pre-roll usage card (Activity#use()'s _createUsageMessage,
 * template chat/activity-card.hbs) — inserted into dnd5e's own .card-buttons
 * flex column alongside the native Attack/Damage buttons (native styling, no
 * wrapper/custom CSS needed). If this specific card is already armed (e.g.
 * after a reload), re-decorate instead of re-prompting — and only re-arm the
 * pending-die map if the die hasn't already been consumed into an attack
 * roll.
 */
function onRenderUsageCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container) return;

  const armed = message.getFlag(MODULE_ID, PRECISION_FLAG);
  if (armed) {
    if (container.querySelector(`.${REFUND_BTN_CLASS}`)) return; // already injected this render
    if (!armed.consumed) {
      armPrecisionDie(activity, {
        dieSize: armed.dieSize,
        onApplied: () => message.setFlag(MODULE_ID, `${PRECISION_FLAG}.consumed`, true),
      });
    }
    container.appendChild(buildRefundButton(message, container, activity, armed));
    return;
  }

  if (container.querySelector(`.${BTN_CLASS}`)) return; // already injected this render
  const maneuver = findPrecisionAttackManeuver(actor);
  if (!maneuver) return;

  container.appendChild(buildFreshPrecisionButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:precision-attack:button", actor.name);
}

/** Register Precision Attack's activation flow. Call once during setup. */
export function registerPrecisionAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderUsageCard);
  Hooks.on("dnd5e.preRollAttackV2", onPrecisionPreRollAttack);
  Hooks.on("dnd5e.postAttackRollConfiguration", onPrecisionPostRollAttackConfiguration);
}
