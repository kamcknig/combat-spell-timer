import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Ambush": "When you make a Dexterity
 * (Stealth) check or an initiative roll, you can expend one superiority die
 * and add the die to the roll, provided you aren't incapacitated." Unlike
 * every other maneuver, this is declared on the native d20
 * roll-configuration dialog itself (renderD20RollConfigurationDialog fires
 * for both the base dialog used by Actor5e#rollInitiativeDialog and the
 * SkillToolRollConfigurationDialog subclass used by Actor5e#rollSkill,
 * since Foundry's ApplicationV2 fires a render hook for every class in the
 * instance's inheritance chain) — not on a chat message, so there's no
 * persisted flag to restore across reloads; the whole activation/roll
 * lifecycle happens within one dialog instance. The armed die is applied by
 * mutating the dialog's own live BasicRollProcessConfiguration
 * (`app.config.rolls[0].parts`) and calling the dialog's own public
 * `rebuild()`, then removed the same way on refund. A dialog closed/
 * cancelled while armed (no Advantage/Normal/Disadvantage click) triggers an
 * automatic refund via dnd5e.postAbilityCheckRollConfiguration, since
 * "abilityCheck" is common to both initiative and skill hookNames and there
 * is no longer a button to click once the dialog is gone.
 */

const BTN_CLASS = "cst-ambush";
const REFUND_BTN_CLASS = "cst-ambush-refund";
const CONTROLS_CLASS = "cst-ambush-controls";

/** config (BasicRollProcessConfiguration) -> { dieSize, actorUuid, partStr } for a dialog currently armed by Ambush. */
const pendingAmbush = new WeakMap();

/** The actor's "Maneuver: Ambush" feat, or null. */
function findAmbushManeuver(actor) {
  return findFeat(actor, "maneuver: ambush", "maneuver-ambush");
}

/** True when `config` is a Dexterity (Stealth) check or an initiative roll — Ambush's only two RAW triggers. */
function isAmbushEligible(config) {
  const hookNames = config?.hookNames ?? [];
  if (hookNames.includes("initiativeDialog")) return true;
  return hookNames.includes("skill") && config.skill === "ste";
}

/** Append `partStr` (e.g. "1d8") to the pending roll's parts, then rebuild the dialog from the mutated config. */
function addAmbushDie(app, partStr) {
  const roll = app.config?.rolls?.[0];
  if (!roll) return;
  roll.parts = [...(roll.parts ?? []), partStr];
  app.rebuild();
}

/** Remove `partStr` from the pending roll's parts (no-op if already gone), then rebuild. */
function removeAmbushDie(app, partStr) {
  const roll = app.config?.rolls?.[0];
  const idx = roll?.parts?.lastIndexOf(partStr) ?? -1;
  if (idx === -1) return;
  roll.parts = [...roll.parts.slice(0, idx), ...roll.parts.slice(idx + 1)];
  app.rebuild();
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleAmbushUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Ambush.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.Ambush.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-user-ninja",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — button stays fresh

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Ambush.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:ambush:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception for this item
  dbg("dnd5e:ambush:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Refund one Combat Superiority die (bookkeeping only — callers handle button/config state). */
async function refundAmbushPool(actorUuid) {
  const actor = fromUuidSync(actorUuid);
  const pool = findCombatSuperiority(actor);
  if (!pool) return;
  const spent = Number(pool.system?.uses?.spent) || 0;
  await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  dbg("dnd5e:ambush:refunded", actor?.name);
}

/** Build the fresh (unarmed) AMBUSH button and wire its use-flow click handler. */
function buildFreshButton(app, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-user-ninja" inert></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.Ambush.Button")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.Ambush.NoDice");
  }
  btn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    btn.disabled = true;
    try {
      const result = await handleAmbushUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only

      const partStr = `1${result.dieSize}`;
      pendingAmbush.set(app.config, { dieSize: result.dieSize, actorUuid: result.actorUuid, partStr });
      addAmbushDie(app, partStr);
      btn.replaceWith(buildRefundButton(app, actor, maneuver));
    } catch (err) {
      warn("ambush failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the REFUND RESOURCE button that replaces an armed AMBUSH button. */
function buildRefundButton(app, actor, maneuver) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}`;
  btn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    btn.disabled = true;
    try {
      const armed = pendingAmbush.get(app.config);
      if (!armed) return;
      pendingAmbush.delete(app.config);
      removeAmbushDie(app, armed.partStr);
      await refundAmbushPool(armed.actorUuid);
      btn.replaceWith(buildFreshButton(app, actor, maneuver));
    } catch (err) {
      warn("ambush refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * renderD20RollConfigurationDialog: inject the AMBUSH button as its own
 * full-width row directly below the dialog's native buttons row
 * (`[data-application-part="buttons"]`, the `<nav class="dialog-buttons
 * flexrow">` holding the native Advantage/Normal/Disadvantage buttons) —
 * inserted as a sibling `<div class="cst-ambush-controls">` right after that
 * nav, rather than into it, so it reads as a second row rather than a fourth
 * cramped button. This hook fires for the base dialog (initiative) and for
 * SkillToolRollConfigurationDialog (skill/tool checks) alike, and again on
 * every partial re-render (e.g. after `app.rebuild()`'s formulas-only
 * refresh) — guard against re-injecting a duplicate row.
 */
function onRenderRollDialog(app, html) {
  const config = app.config;
  if (!isAmbushEligible(config)) return;
  const actor = config?.subject;
  if (!actor || !canAct(actor)) return;
  if (actor.statuses?.has?.("incapacitated")) return;

  const nav = html.querySelector('[data-application-part="buttons"]');
  if (!nav || html.querySelector(`.${BTN_CLASS}, .${REFUND_BTN_CLASS}`)) return;

  const maneuver = findAmbushManeuver(actor);
  if (!maneuver) return;

  const row = document.createElement("div");
  row.className = CONTROLS_CLASS;
  row.appendChild(buildFreshButton(app, actor, maneuver));
  nav.insertAdjacentElement("afterend", row);
  dbg("dnd5e:ambush:button", actor.name);
}

/**
 * dnd5e.postAbilityCheckRollConfiguration: fires for both initiative rolls
 * and skill checks (both include "abilityCheck" in config.hookNames) right
 * after the roll-configuration dialog resolves. Empty `rolls` means the
 * dialog was closed/cancelled without rolling — if Ambush was armed for
 * that dialog's config, silently refund the die (there's no longer a button
 * to click) and notify the player.
 */
async function onPostAbilityCheckRollConfiguration(rolls, config) {
  if (rolls?.length) { pendingAmbush.delete(config); return; } // committed — resource correctly stays spent
  const armed = pendingAmbush.get(config);
  if (!armed) return;
  pendingAmbush.delete(config);
  await refundAmbushPool(armed.actorUuid);
  ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Ambush.AutoRefunded"));
  dbg("dnd5e:ambush:auto-refunded", armed.actorUuid);
}

/** Register Ambush's activation flow. Call once during setup. */
export function registerAmbushHooks() {
  Hooks.on("renderD20RollConfigurationDialog", onRenderRollDialog);
  Hooks.on("dnd5e.postAbilityCheckRollConfiguration", onPostAbilityCheckRollConfiguration);
}
