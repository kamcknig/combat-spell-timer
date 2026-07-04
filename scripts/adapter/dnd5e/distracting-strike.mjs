import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { addDamageButtonSuffix, removeDamageButtonSuffix, markRefundButton, renderRefundButtonLabels } from "./maneuver-damage-label.mjs";
import { ensureEffectTemplate, injectEffectApplicationTray } from "./effect-application-tray.mjs";
import { DISTRACTED_FLAG, DISTRACTED_STATUS_ID } from "./features/distracting-strike.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Distracting Strike": same shape as
 * Disarming Attack (disarming-attack.mjs) — declared against a specific
 * weapon attack, not standalone — so its entry point is a button injected
 * into that weapon's own usage card. Spends from the same Combat
 * Superiority pool. Unlike Disarming Attack, there is no follow-up save;
 * instead the maneuver's own announcement card carries an apply-effects
 * tray for a pure marker "Distracted" effect (see features/distracting-strike.mjs).
 */

const DISTRACT_FLAG = "distractingStrike"; // weapon-card message flags[MODULE_ID][DISTRACT_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-distracting-strike";
const REFUND_BTN_CLASS = "cst-distracting-strike-refund";
const LABEL_KEY = "distract";
const ANNOUNCE_FLAG = "distractingStrikeAnnounce"; // maneuver-card message flags[MODULE_ID][ANNOUNCE_FLAG] = {actorUuid}

/** The actor's "Maneuver: Distracting Strike" feat, or null. */
function findDistractingStrikeManeuver(actor) {
  return findFeat(actor, "maneuver: distracting strike", "maneuver-distracting-strike");
}

const pendingDistractDamage = new Map(); // activity.uuid -> { dieSize }
const armedDamageHandlers = new WeakMap(); // Damage button -> our click handler, so refund detaches ONLY ours

function relabelDamageButton(container) {
  addDamageButtonSuffix(container, LABEL_KEY, game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.DamageLabelSuffix"));
}

function unrelabelDamageButton(container) {
  removeDamageButtonSuffix(container, LABEL_KEY);
  const btn = container.querySelector('button[data-action="rollDamage"]');
  const handler = btn && armedDamageHandlers.get(btn);
  if (btn && handler) {
    btn.removeEventListener("click", handler);
    armedDamageHandlers.delete(btn);
    delete btn.dataset.cstDistractArmed;
  }
}

function armDamageButton(container, message, activity, dieSize) {
  const btn = container.querySelector('button[data-action="rollDamage"]');
  if (!btn || btn.dataset.cstDistractArmed) return;
  btn.dataset.cstDistractArmed = "true";
  const handler = () => {
    pendingDistractDamage.set(activity.uuid, { dieSize });
    message.update({ [`flags.${MODULE_ID}.${DISTRACT_FLAG}.consumed`]: true });
  };
  armedDamageHandlers.set(btn, handler);
  btn.addEventListener("click", handler, { once: true });
}

/**
 * dnd5e.preRollDamageV2: append the pending Distracting Strike die. Fires
 * independently of Disarming Attack's own handler for the same hook — both
 * mutate the same shared `config`/`roll` object in sequence (Hooks.call,
 * not callAll, but neither handler returns `false`, so both run), so both
 * dice compose correctly when both maneuvers are armed on one card.
 */
export function onDistractingStrikePreRollDamage(config) {
  const activity = config?.subject;
  if (!activity || !pendingDistractDamage.has(activity.uuid)) return;
  const { dieSize } = pendingDistractDamage.get(activity.uuid);
  pendingDistractDamage.delete(activity.uuid);
  const roll = config.rolls?.[0];
  if (!roll) return;
  roll.parts = [...(roll.parts ?? []), `1${dieSize}`];
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

  const flags = { [MODULE_ID]: {} };
  if (action === "use") flags[MODULE_ID][ANNOUNCE_FLAG] = { actorUuid: actor.uuid };
  await maneuverItem.displayCard({ flags });
  dbg("dnd5e:distracting-strike:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Replace the DISTRACTING STRIKE button with REFUND RESOURCE and relabel the Damage button — the visible "armed" state. */
function decorateArmed(container, message, activity, armed) {
  const existingBtn = container.querySelector(`.${BTN_CLASS}`);
  if (existingBtn) {
    const refundBtn = buildRefundButton(message, container, activity, armed);
    existingBtn.replaceWith(refundBtn);
    markRefundButton(container, refundBtn, game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.DamageLabelSuffix"));
  } else if (!container.querySelector(`.${REFUND_BTN_CLASS}`)) {
    const refundBtn = buildRefundButton(message, container, activity, armed);
    container.appendChild(refundBtn);
    markRefundButton(container, refundBtn, game.i18n.localize("COMBAT_SPELL_TIMER.DistractingStrike.DamageLabelSuffix"));
  }
  relabelDamageButton(container);
  if (!armed.consumed) armDamageButton(container, message, activity, armed.dieSize);
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
      const newArmed = { dieSize: result.dieSize, actorUuid: result.actorUuid };
      await message.setFlag(MODULE_ID, DISTRACT_FLAG, newArmed);
      decorateArmed(container, message, activity, newArmed);
    } catch (err) {
      warn("distracting strike failed", err);
      btn.disabled = false;
    }
  });
  return btn;
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

/** Refund the spent Combat Superiority die and swap back to a fresh DISTRACTING STRIKE button. */
async function onDistractRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  if (!armed.consumed) {
    pendingDistractDamage.delete(activity.uuid);
    unrelabelDamageButton(container);
  }

  await message.unsetFlag(MODULE_ID, DISTRACT_FLAG);

  const maneuver = findDistractingStrikeManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) {
    refundBtn.replaceWith(buildFreshDistractButton(container, message, activity, actor, maneuver));
    renderRefundButtonLabels(container); // any sibling maneuver's refund button reverts to the plain label if it's now the only one armed
  }
  dbg("dnd5e:distracting-strike:refunded", actor?.name);
}

/** dnd5e.renderChatMessage handler: inject the DISTRACTING STRIKE button into a weapon's usage card. */
function onRenderWeaponUsageCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container || !container.querySelector('button[data-action="rollDamage"]')) return;

  const armed = message.getFlag(MODULE_ID, DISTRACT_FLAG);
  if (armed) {
    decorateArmed(container, message, activity, armed);
    return;
  }

  if (container.querySelector(`.${BTN_CLASS}`)) return; // already injected this render
  const maneuver = findDistractingStrikeManeuver(actor);
  if (!maneuver) return;

  container.appendChild(buildFreshDistractButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:distracting-strike:button", actor.name);
}

/** Build the DISTRACTING STRIKE button (native .card-buttons styling — no wrapper/custom CSS needed). */
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

/** dnd5e.renderChatMessage: offer the Distracted apply-effects tray on the maneuver's own announcement card. */
async function onRenderAnnounceMessage(message, html) {
  const data = message.getFlag(MODULE_ID, ANNOUNCE_FLAG);
  if (!data) return;
  const actor = fromUuidSync(data.actorUuid);
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

/** Register Distracting Strike's usage-card button + activation flow. Call once during setup. */
export function registerDistractingStrikeHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderWeaponUsageCard);
  Hooks.on("dnd5e.renderChatMessage", onRenderAnnounceMessage);
  Hooks.on("dnd5e.preRollDamageV2", onDistractingStrikePreRollDamage);
}
