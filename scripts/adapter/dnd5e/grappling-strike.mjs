import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Grappling Strike": "Immediately after
 * you hit a creature with a melee attack on your turn, you can expend one
 * superiority die and then try to grapple the target as a bonus action...
 * Add the superiority die to your Strength (Athletics) check." Melee-only
 * per RAW's own wording ("melee attack") — gated the same way Brace/Riposte
 * gate their melee-only maneuvers, unlike Trip/Pushing/Menacing/Maneuvering
 * Attack's unrestricted "weapon attack" siblings. Its entry point is a
 * button on the ATTACK ROLL result message (flags.dnd5e.roll.type ===
 * "attack"), same as those siblings — which means, unlike Brace/Riposte's
 * pre-roll usage-card gate, the attack has already happened by render time.
 * `getActionType()` only reclassifies "mwak" to "rwak" when given the
 * attack mode actually used (dnd5e.mjs:12524) — called with no argument it
 * returns the weapon's base type, which for a Thrown-property weapon stays
 * "mwak" even when that specific attack was thrown at range. The real
 * per-roll mode is read off this ATTACK message's own flag (`roll.attackMode`,
 * the same one dnd5e's own native Damage-button handler reads — see
 * quick-toss.mjs's doc comment) so a thrown dagger/handaxe correctly
 * excludes this melee-only button.
 *
 * Unlike every damage-die maneuver, this one never touches the attack's own
 * damage roll or the shared maneuver-damage-dice registry — using it
 * immediately triggers the ATTACKER's own Strength (Athletics) check via
 * `Actor5e#rollSkill`, with the superiority die pre-seeded into
 * `config.rolls[0].parts` so it's part of the formula from the roll-
 * configuration dialog's first paint (dnd5e's `_buildSkillToolConfig`
 * appends mod/prof/bonus terms onto that same array afterward — see
 * dnd5e.mjs:37360-37374). No render-hook/WeakMap arming (Ambush/Commanding
 * Presence's technique) is needed since we're the ones triggering the check,
 * not reacting to the player triggering it independently.
 *
 * Because the resource spend and the check trigger both happen synchronously
 * in the button's click handler, there's no "armed, pending a later roll"
 * state to track — the button commits straight from fresh to REFUND
 * RESOURCE on USE (available any time afterward, whether or not the
 * Athletics check was ever completed), matching Trip Attack/Maneuvering
 * Attack's refund convention rather than Ambush's auto-refund-on-cancel.
 */

const GRAPPLE_FLAG = "grapplingStrike"; // attack-roll message flags[MODULE_ID][GRAPPLE_FLAG] = {dieSize, actorUuid}
const BTN_CLASS = "cst-grappling-strike";
const REFUND_BTN_CLASS = "cst-grappling-strike-refund";
const CONTROLS_CLASS = "cst-grappling-strike-controls";

/** The actor's "Maneuver: Grappling Strike" feat, or null. */
function findGrapplingStrikeManeuver(actor) {
  return findFeat(actor, "maneuver: grappling strike", "maneuver-grappling-strike");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the maneuver's own announcement card. */
async function handleGrapplingStrikeUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.GrapplingStrike.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.GrapplingStrike.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-hands-bound",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — button stays fresh

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.GrapplingStrike.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:grappling-strike:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception for this item
  dbg("dnd5e:grappling-strike:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

/**
 * Trigger the attacker's own Strength (Athletics) check with the superiority
 * die pre-seeded into the roll's formula. Deliberately not awaited by the
 * caller — the returned promise doesn't resolve until the player finishes or
 * cancels the roll-configuration dialog, and the REFUND RESOURCE option must
 * already be available before that happens.
 */
function rollGrapplingAthletics(actor, dieSize) {
  actor.rollSkill?.({ skill: "ath", rolls: [{ parts: [`1${dieSize}`] }] })
    ?.catch((err) => warn("grappling strike athletics roll failed", err));
}

/** Build the REFUND RESOURCE button that replaces an armed GRAPPLING STRIKE button. */
function buildRefundButton(message, container, actorUuid) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onGrapplingRefundClick(message, container, actorUuid);
    } catch (err) {
      warn("grappling strike refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) GRAPPLING STRIKE button and wire its use-flow click handler. */
function buildFreshButton(container, message, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-hands-bound" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.GrapplingStrike.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.GrapplingStrike.NoDice");
  }
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      const result = await handleGrapplingStrikeUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only

      rollGrapplingAthletics(actor, result.dieSize);
      await message.setFlag(MODULE_ID, GRAPPLE_FLAG, { dieSize: result.dieSize, actorUuid: result.actorUuid });
      btn.replaceWith(buildRefundButton(message, container, result.actorUuid));
    } catch (err) {
      warn("grappling strike failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Refund the spent Combat Superiority die and swap back to a fresh GRAPPLING STRIKE button. */
async function onGrapplingRefundClick(message, container, actorUuid) {
  const actor = fromUuidSync(actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }
  await message.unsetFlag(MODULE_ID, GRAPPLE_FLAG);

  const maneuver = findGrapplingStrikeManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshButton(container, message, actor, maneuver));
  dbg("dnd5e:grappling-strike:refunded", actor?.name);
}

/**
 * dnd5e.renderChatMessage handler: inject the GRAPPLING STRIKE button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card — same entry point as Trip Attack /
 * Maneuvering Attack. Melee-only per RAW, unlike those two siblings.
 */
function onRenderAttackRollMessage(message, html) {
  if (message.getFlag("dnd5e", "roll")?.type !== "attack") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  const attackMode = message.getFlag("dnd5e", "roll")?.attackMode;
  if (activity.getActionType?.(attackMode) !== "mwak") return; // melee only, per RAW
  if (!canAct(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return; // already injected this render

  const armed = message.getFlag(MODULE_ID, GRAPPLE_FLAG);
  if (armed) {
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, armed.actorUuid));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findGrapplingStrikeManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshButton(container, message, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:grappling-strike:button", actor.name);
}

/** Register Grappling Strike's activation flow. Call once during setup. */
export function registerGrapplingStrikeHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
}
