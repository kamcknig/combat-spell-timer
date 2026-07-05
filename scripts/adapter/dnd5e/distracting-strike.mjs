import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { ensureEffectTemplate, injectEffectApplicationTray, insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";
import { DISTRACTED_FLAG, DISTRACTED_STATUS_ID } from "./features/distracting-strike.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Distracting Strike": same shape as
 * Disarming Attack (disarming-attack.mjs) — declared against a specific
 * weapon attack, not standalone — so its entry point is a button on the
 * ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), NOT the
 * pre-roll usage/activity card (see disarming-attack.mjs's own doc comment
 * for the full reasoning: dnd5e posts these as two separate chat messages,
 * and the native Damage button lives only on the earlier one, so USE arms a
 * pending-damage map entry immediately rather than via a Damage-button
 * listener — no Damage-button relabeling). Spends from the same Combat
 * Superiority pool. Unlike Disarming Attack, there is no follow-up save;
 * instead the attack's own damage message carries an apply-effects tray for
 * a pure marker "Distracted" effect (see features/distracting-strike.mjs) —
 * placed there rather than on the maneuver's announcement card because the
 * target isn't confirmed until the damage roll, same reasoning as Sap/Slow's
 * own tray placement (weapon-mastery.mjs).
 */

const DISTRACT_FLAG = "distractingStrike"; // attack-roll message flags[MODULE_ID][DISTRACT_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-distracting-strike";
const REFUND_BTN_CLASS = "cst-distracting-strike-refund";
const CONTROLS_CLASS = "cst-distracting-strike-controls";

/** The actor's "Maneuver: Distracting Strike" feat, or null. */
function findDistractingStrikeManeuver(actor) {
  return findFeat(actor, "maneuver: distracting strike", "maneuver-distracting-strike");
}

const pendingDistractDamage = new Map(); // activity.uuid -> { dieSize, messageId } — armed immediately on USE, no Damage-button listener needed
const pendingDistractApplied = new Map(); // activity.uuid -> { actorUuid } — consumed by onRenderDistractDamageMessage

/**
 * dnd5e.preRollDamageV2: append the pending Distracting Strike die. Fires
 * independently of Disarming Attack's own handler for the same hook — both
 * mutate the same shared `config`/`roll` object in sequence (Hooks.call,
 * not callAll, but neither handler returns `false`, so both run), so both
 * dice compose correctly when both maneuvers are armed on one card. Also
 * stashes the caster for onRenderDistractDamageMessage below — the
 * apply-effects tray lives on this activity's damage message (the target
 * isn't confirmed until the damage roll — same reasoning as Sap/Slow's own
 * tray placement), not the maneuver's announcement card. Also flips the
 * originating attack-roll message's `consumed` flag (fire-and-forget) so a
 * later reload doesn't re-arm an already-spent die.
 */
export function onDistractingStrikePreRollDamage(config) {
  const activity = config?.subject;
  if (!activity || !pendingDistractDamage.has(activity.uuid)) return;
  const { dieSize, messageId } = pendingDistractDamage.get(activity.uuid);
  pendingDistractDamage.delete(activity.uuid);
  const roll = config.rolls?.[0];
  if (roll) roll.parts = [...(roll.parts ?? []), `1${dieSize}`];
  pendingDistractApplied.set(activity.uuid, { actorUuid: activity.actor?.uuid });
  const message = messageId ? game.messages.get(messageId) : null;
  message?.setFlag(MODULE_ID, `${DISTRACT_FLAG}.consumed`, true);
  dbg("dnd5e:distracting-strike:die-added", activity.item?.name, dieSize);
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleDistractingStrikeUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.DistractingStrike.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-bullseye",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:distracting-strike:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; the apply-effects tray lives on the damage message instead
  dbg("dnd5e:distracting-strike:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Build the REFUND RESOURCE button that replaces an armed DISTRACTING STRIKE button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onDistractRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("distracting strike refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) DISTRACTING STRIKE button and wire its use-flow click handler. */
function buildFreshDistractButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildDistractButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleDistractingStrikeUse(maneuver);
      if (!result) { btn.disabled = false; return; }
      if (result.action !== "use") { btn.disabled = false; return; }
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      pendingDistractDamage.set(activity.uuid, { dieSize: armed.dieSize, messageId: message.id });
      await message.setFlag(MODULE_ID, DISTRACT_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("distracting strike failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * DISTRACTING STRIKE button. Cancels the pending damage-die addition too (a
 * no-op if Damage was already rolled — onDistractingStrikePreRollDamage
 * already consumed it by then, so only the resource bookkeeping happens in
 * that case).
 */
async function onDistractRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  pendingDistractDamage.delete(activity.uuid);
  await message.unsetFlag(MODULE_ID, DISTRACT_FLAG);

  const maneuver = findDistractingStrikeManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshDistractButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:distracting-strike:refunded", actor?.name);
}

/** Build the DISTRACTING STRIKE button. */
function buildDistractButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-bullseye" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the DISTRACTING STRIKE button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card. Wrapped in the shared
 * `.cst-<feature>-controls` flex-row shape (see CLAUDE.md's "Chat-card
 * action buttons" convention) since this message has no native
 * `.card-buttons` row to inherit styling from. If this specific roll
 * message is already armed (e.g. after a reload), re-decorate instead of
 * re-prompting — and only re-arm the in-memory pending-damage map if the
 * die hasn't already been consumed into a damage roll.
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

  const armed = message.getFlag(MODULE_ID, DISTRACT_FLAG);
  if (armed) {
    if (!armed.consumed) pendingDistractDamage.set(activity.uuid, { dieSize: armed.dieSize, messageId: message.id });
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findDistractingStrikeManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshDistractButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:distracting-strike:button", actor.name);
}

/**
 * dnd5e.renderChatMessage: offer the Distracted apply-effects tray on the
 * damage message for the attack an armed Distracting Strike die was just
 * added to (mirrors Sap/Slow's own placement, and Disarming Attack's
 * pendingDisarmApplied -> message-flags transfer shape, so a later
 * re-render — scroll, reload — still shows the tray after the in-memory map
 * entry is gone).
 */
async function onRenderDistractDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "distractingStrikeApplied");
  if (!applied) {
    const pending = pendingDistractApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingDistractApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "distractingStrikeApplied", applied);
  }

  const actor = fromUuidSync(applied.actorUuid);
  if (!actor) return;
  const maneuver = findDistractingStrikeManeuver(actor);
  if (!maneuver) return;
  const effectDoc = await ensureEffectTemplate(maneuver, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.EffectName"),
    statusId: DISTRACTED_STATUS_ID, flagKey: DISTRACTED_FLAG,
  });
  injectEffectApplicationTray(html, effectDoc);
  dbg("dnd5e:distracting-strike:tray", actor.name);
}

/** Register Distracting Strike's activation flow. Call once during setup. */
export function registerDistractingStrikeHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderDistractDamageMessage);
  Hooks.on("dnd5e.preRollDamageV2", onDistractingStrikePreRollDamage);
}
