import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct, weaponDamageType } from "./weapon-mastery.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Sweeping Attack": "When you hit a
 * creature with a melee weapon attack, you can expend one superiority die to
 * attempt to damage another creature with the same attack. Choose another
 * creature within 5 feet of the original target and within your reach. If
 * the original attack roll would hit the second creature, it takes damage
 * equal to the number you roll on your superiority die. The damage is of the
 * same type dealt by the original attack." Button lives on the ATTACK ROLL
 * result message (per CLAUDE.md's "usage card vs attack-roll message" note
 * — hit-contingent RAW belongs here, same family as Disarming/Menacing/
 * Pushing/Goading/Maneuvering/Riposte Attack). Unlike all of those, this
 * maneuver does NOT add its die to the SAME attack's damage roll — it deals
 * a wholly separate instance of damage to a different creature, so it does
 * not touch the shared maneuver-damage-dice.mjs registry at all. Instead it
 * borrows Weapon Mastery Graze's roll shape (weapon-mastery.mjs#onGrazeDamageClick):
 * roll a flat `1<superiority die>` typed via the already-exported
 * weaponDamageType(item), and post it immediately as its own native-styled
 * damage chat message via CONFIG.Dice.DamageRoll. Melee-only per RAW: gated
 * on activity.getActionType() === "mwak" at attack-roll-message time, where
 * the mode actually used is already resolved (exact, unlike Lunging Attack's
 * own pre-roll usage-card caveat). Choosing/validating the second creature
 * is not automated — matches every other maneuver's scope.
 */

const SWEEP_FLAG = "sweepingAttack"; // attack-roll message flags[MODULE_ID][SWEEP_FLAG] = {actorUuid}
const BTN_CLASS = "cst-sweeping-attack";
const REFUND_BTN_CLASS = "cst-sweeping-attack-refund";
const CONTROLS_CLASS = "cst-sweeping-attack-controls";

/** The actor's "Maneuver: Sweeping Attack" feat, or null. */
function findSweepingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: sweeping attack", "maneuver-sweeping-attack");
}

/** Roll 1<superiority die>, typed as the weapon's own damage type, and post it as its own damage chat message. */
async function rollSweepDamage(actor, weaponItem, dieSize) {
  const type = weaponDamageType(weaponItem);
  const roll = new CONFIG.Dice.DamageRoll(`1${dieSize}`, actor.getRollData(), { type });
  await roll.evaluate();
  await CONFIG.Dice.DamageRoll.toMessage([roll], {
    flavor: `${weaponItem.name} - ${game.i18n.localize("COMBAT_SPELL_TIMER.SweepingAttack.RollFlavor")}`,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { dnd5e: { messageType: "roll", roll: { type: "damage" } } },
  });
  dbg("dnd5e:sweeping-attack:rolled", actor.name, weaponItem.name, dieSize, type);
}

/** Prompt USE/CHAT. USE consumes one Combat Superiority die AND immediately rolls+posts the sweep damage. CHAT posts a plain announcement only. */
async function handleSweepingAttackUse(maneuverItem, weaponItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.SweepingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.SweepingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-wind",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.SweepingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:sweeping-attack:consumed", actor.name, remaining - 1);
    await rollSweepDamage(actor, weaponItem, dieSize);
    return { actorUuid: actor.uuid, action };
  }

  await maneuverItem.displayCard(); // plain native item card; CHAT-only, no roll, no cost
  dbg("dnd5e:sweeping-attack:announced", actor.name, action);
  return { action };
}

/** Build the REFUND RESOURCE button that replaces an armed SWEEPING ATTACK button. */
function buildRefundButton(message, container, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onSweepRefundClick(message, container, armed);
    } catch (err) {
      warn("sweeping attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) SWEEPING ATTACK button and wire its use-flow click handler. */
function buildFreshSweepButton(container, message, weaponItem, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildSweepButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleSweepingAttackUse(maneuver, weaponItem);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { actorUuid: result.actorUuid };
      await message.setFlag(MODULE_ID, SWEEP_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, armed));
    } catch (err) {
      warn("sweeping attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh SWEEPING
 * ATTACK button. Bookkeeping only — the already-posted sweep damage message
 * is never retracted, matching how every other roll-then-refund toggle in
 * this codebase (Commander's Strike, Goading Attack's bare-item entry) works.
 */
async function onSweepRefundClick(message, container, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }
  await message.unsetFlag(MODULE_ID, SWEEP_FLAG);

  const weaponItem = message.getAssociatedItem?.();
  const maneuver = findSweepingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && weaponItem && refundBtn) refundBtn.replaceWith(buildFreshSweepButton(container, message, weaponItem, actor, maneuver));
  dbg("dnd5e:sweeping-attack:refunded", actor?.name);
}

/** Build the SWEEPING ATTACK button. */
function buildSweepButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-wind" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.SweepingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.SweepingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the SWEEPING ATTACK button into
 * the ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not
 * the pre-roll usage/activity card. Melee-only per RAW — activity.getActionType()
 * is already resolved at this point, so the gate here is exact. Wrapped in
 * the shared `.cst-<feature>-controls` flex-row shape since this message has
 * no native `.card-buttons` row to inherit styling from.
 */
function onRenderAttackRollMessage(message, html) {
  if (message.getFlag("dnd5e", "roll")?.type !== "attack") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (activity.getActionType?.() !== "mwak") return; // melee only, per RAW
  if (!canAct(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return; // already injected this render

  const armed = message.getFlag(MODULE_ID, SWEEP_FLAG);
  if (armed) {
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findSweepingAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshSweepButton(container, message, item, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:sweeping-attack:button", actor.name);
}

/** Register Sweeping Attack's activation flow. Call once during setup. */
export function registerSweepingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
}
