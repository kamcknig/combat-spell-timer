import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Commanding Presence": "When you make
 * a Charisma (Intimidation), a Charisma (Performance), or a Charisma
 * (Persuasion) check, you can expend one superiority die and add the
 * superiority die to the ability check." Same shape as Ambush (Dex
 * (Stealth)/initiative) — declared on the native d20 roll-configuration
 * dialog itself (renderD20RollConfigurationDialog, which fires for
 * SkillToolRollConfigurationDialog instances since Foundry's ApplicationV2
 * fires a render hook for every class in the instance's inheritance chain),
 * not on a chat message, so there's no persisted flag to restore across
 * reloads — the whole activation/roll lifecycle happens within one dialog
 * instance. The armed die is applied by mutating the dialog's own live
 * BasicRollProcessConfiguration (`app.config.rolls[0].parts`) and calling
 * the dialog's own public `rebuild()`, then removed the same way on refund.
 * A dialog closed/cancelled while armed (no Advantage/Normal/Disadvantage
 * click) triggers an automatic refund via
 * dnd5e.postAbilityCheckRollConfiguration. Unlike Ambush, this maneuver's
 * RAW carries no "provided you aren't incapacitated" clause, so no status
 * gate is applied, and there is no initiative-roll eligibility at all — only
 * the three named Charisma skill checks.
 */

const BTN_CLASS = "cst-commanding-presence";
const REFUND_BTN_CLASS = "cst-commanding-presence-refund";
const CONTROLS_CLASS = "cst-commanding-presence-controls";
const ELIGIBLE_SKILLS = new Set(["itm", "prf", "per"]); // Intimidation, Performance, Persuasion

/** config (BasicRollProcessConfiguration) -> { dieSize, actorUuid, partStr } for a dialog currently armed by Commanding Presence. */
const pendingCommandingPresence = new WeakMap();

/** The actor's "Maneuver: Commanding Presence" feat, or null. */
function findCommandingPresenceManeuver(actor) {
  return findFeat(actor, "maneuver: commanding presence", "maneuver-commanding-presence");
}

/** True when `config` is a Charisma (Intimidation/Performance/Persuasion) check — Commanding Presence's only RAW triggers. */
function isCommandingPresenceEligible(config) {
  const hookNames = config?.hookNames ?? [];
  return hookNames.includes("skill") && ELIGIBLE_SKILLS.has(config.skill);
}

/** Append `partStr` (e.g. "1d8") to the pending roll's parts, then rebuild the dialog from the mutated config. */
function addCommandingPresenceDie(app, partStr) {
  const roll = app.config?.rolls?.[0];
  if (!roll) return;
  roll.parts = [...(roll.parts ?? []), partStr];
  app.rebuild();
}

/** Remove `partStr` from the pending roll's parts (no-op if already gone), then rebuild. */
function removeCommandingPresenceDie(app, partStr) {
  const roll = app.config?.rolls?.[0];
  const idx = roll?.parts?.lastIndexOf(partStr) ?? -1;
  if (idx === -1) return;
  roll.parts = [...roll.parts.slice(0, idx), ...roll.parts.slice(idx + 1)];
  app.rebuild();
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleCommandingPresenceUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.CommandingPresence.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.CommandingPresence.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-crown",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — button stays fresh

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.CommandingPresence.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:commanding-presence:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception for this item
  dbg("dnd5e:commanding-presence:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/** Refund one Combat Superiority die (bookkeeping only — callers handle button/config state). */
async function refundCommandingPresencePool(actorUuid) {
  const actor = fromUuidSync(actorUuid);
  const pool = findCombatSuperiority(actor);
  if (!pool) return;
  const spent = Number(pool.system?.uses?.spent) || 0;
  await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  dbg("dnd5e:commanding-presence:refunded", actor?.name);
}

/** Build the fresh (unarmed) COMMANDING PRESENCE button and wire its use-flow click handler. */
function buildFreshButton(app, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-crown" inert></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.CommandingPresence.Button")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.CommandingPresence.NoDice");
  }
  btn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    btn.disabled = true;
    try {
      const result = await handleCommandingPresenceUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only

      const partStr = `1${result.dieSize}`;
      pendingCommandingPresence.set(app.config, { dieSize: result.dieSize, actorUuid: result.actorUuid, partStr });
      addCommandingPresenceDie(app, partStr);
      btn.replaceWith(buildRefundButton(app, actor, maneuver));
    } catch (err) {
      warn("commanding presence failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the REFUND RESOURCE button that replaces an armed COMMANDING PRESENCE button. */
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
      const armed = pendingCommandingPresence.get(app.config);
      if (!armed) return;
      pendingCommandingPresence.delete(app.config);
      removeCommandingPresenceDie(app, armed.partStr);
      await refundCommandingPresencePool(armed.actorUuid);
      btn.replaceWith(buildFreshButton(app, actor, maneuver));
    } catch (err) {
      warn("commanding presence refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * renderD20RollConfigurationDialog: inject the COMMANDING PRESENCE button as
 * its own full-width row directly below the dialog's native buttons row
 * (`[data-application-part="buttons"]`, the `<nav class="dialog-buttons
 * flexrow">` holding the native Advantage/Normal/Disadvantage buttons) —
 * inserted as a sibling `<div class="cst-commanding-presence-controls">`
 * right after that nav (same placement Ambush uses). Fires again on every
 * partial re-render (e.g. after `app.rebuild()`'s formulas-only refresh) —
 * guard against re-injecting a duplicate row.
 */
function onRenderRollDialog(app, html) {
  const config = app.config;
  if (!isCommandingPresenceEligible(config)) return;
  const actor = config?.subject;
  if (!actor || !canAct(actor)) return;

  const nav = html.querySelector('[data-application-part="buttons"]');
  if (!nav || html.querySelector(`.${BTN_CLASS}, .${REFUND_BTN_CLASS}`)) return;

  const maneuver = findCommandingPresenceManeuver(actor);
  if (!maneuver) return;

  const row = document.createElement("div");
  row.className = CONTROLS_CLASS;
  row.appendChild(buildFreshButton(app, actor, maneuver));
  nav.insertAdjacentElement("afterend", row);
  dbg("dnd5e:commanding-presence:button", actor.name);
}

/**
 * dnd5e.postAbilityCheckRollConfiguration: fires for every skill/ability
 * check (all include "abilityCheck" in config.hookNames) right after the
 * roll-configuration dialog resolves. Empty `rolls` means the dialog was
 * closed/cancelled without rolling — if Commanding Presence was armed for
 * that dialog's config, silently refund the die (there's no longer a button
 * to click) and notify the player.
 */
async function onPostAbilityCheckRollConfiguration(rolls, config) {
  if (rolls?.length) { pendingCommandingPresence.delete(config); return; } // committed — resource correctly stays spent
  const armed = pendingCommandingPresence.get(config);
  if (!armed) return;
  pendingCommandingPresence.delete(config);
  await refundCommandingPresencePool(armed.actorUuid);
  ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.CommandingPresence.AutoRefunded"));
  dbg("dnd5e:commanding-presence:auto-refunded", armed.actorUuid);
}

/** Register Commanding Presence's activation flow. Call once during setup. */
export function registerCommandingPresenceHooks() {
  Hooks.on("renderD20RollConfigurationDialog", onRenderRollDialog);
  Hooks.on("dnd5e.postAbilityCheckRollConfiguration", onPostAbilityCheckRollConfiguration);
}
