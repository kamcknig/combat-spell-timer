import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct } from "./weapon-mastery.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Goading Attack" has two independent
 * activation entry points, spending from the same Combat Superiority pool:
 *
 *  1. Declared against a SPECIFIC weapon attack ("when you hit a creature
 *     with a weapon attack") — a button on the ATTACK ROLL result message
 *     (flags.dnd5e.roll.type === "attack"), NOT the pre-roll usage/activity
 *     card. dnd5e posts these as two entirely separate chat messages: the
 *     usage card (activity-card.hbs) carries the native Attack/Damage
 *     buttons in its own .card-buttons row, while the attack roll itself is
 *     posted as its own later message with no .card-buttons at all — just
 *     the d20 roll display (confirmed against the installed dnd5e 5.x
 *     source: AttackActivity#rollAttack always creates a new ChatMessage via
 *     D20Roll.buildPost). Because the native Damage button lives only on
 *     that OTHER, earlier message, this maneuver does NOT attach a listener
 *     to it (unlike Disarming Attack/Distracting Strike) — instead, USE arms
 *     a pending-damage map entry for the activity immediately, and
 *     onGoadingAttackPreRollDamage (a dnd5e.preRollDamageV2 hook) adds the
 *     die whenever Damage is next rolled for that activity, from wherever
 *     the Damage button actually is. No Damage-button relabeling — that
 *     would require locating a different message's rendered DOM and was
 *     deliberately skipped for simplicity.
 *  2. The bare "Maneuver: Goading Attack" item itself, clicked directly —
 *     mirrors Feinting Attack's (feinting-attack.mjs) bare-item shape: a
 *     dnd5e.preDisplayCard interception, USE/CHAT dialog, and (on USE) an
 *     announcement card carrying a ROLL SUPERIORITY DIE button that posts
 *     the roll as its own chat message. No apply-effects tray — no target
 *     marker was requested for this maneuver.
 *
 * The two entries are fully independent: separate message-flag keys
 * (GOAD_FLAG vs GOAD_ANNOUNCE_FLAG), separate button classes, no shared
 * "armed" state.
 */

const GOAD_FLAG = "goadingAttack"; // attack-roll message flags[MODULE_ID][GOAD_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-goading-attack";
const REFUND_BTN_CLASS = "cst-goading-attack-refund";
const CONTROLS_CLASS = "cst-goading-attack-controls";

/** The actor's "Maneuver: Goading Attack" feat, or null. */
function findGoadingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: goading attack", "maneuver-goading-attack");
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleGoadingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.GoadingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-bullhorn",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:goading-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; entry 2's own preDisplayCard interception is a separate item click, not this one
  dbg("dnd5e:goading-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

const pendingGoadDamage = new Map(); // activity.uuid -> { dieSize, messageId } — armed immediately on USE, no Damage-button listener needed

/**
 * dnd5e.preRollDamageV2: append the pending Goading Attack die to the first
 * damage roll's parts — the die is rolled together WITH the weapon damage
 * roll itself, not pre-rolled separately (same shape as Disarming Attack /
 * Distracting Strike). Also flips the originating attack-roll message's
 * `consumed` flag (fire-and-forget) so a later reload doesn't re-arm an
 * already-spent die — see onRenderAttackRollMessage's re-arm branch.
 */
export function onGoadingAttackPreRollDamage(config) {
  const activity = config?.subject;
  if (!activity || !pendingGoadDamage.has(activity.uuid)) return;
  const { dieSize, messageId } = pendingGoadDamage.get(activity.uuid);
  pendingGoadDamage.delete(activity.uuid);
  const roll = config.rolls?.[0];
  if (roll) roll.parts = [...(roll.parts ?? []), `1${dieSize}`];
  const message = messageId ? game.messages.get(messageId) : null;
  message?.setFlag(MODULE_ID, `${GOAD_FLAG}.consumed`, true);
  dbg("dnd5e:goading-attack:die-added", activity.item?.name, dieSize);
}

/** Build the REFUND RESOURCE button that replaces an armed GOADING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onGoadRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("goading attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the fresh (unarmed) GOADING ATTACK button and wire its use-flow click handler. */
function buildFreshGoadButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildGoadButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleGoadingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only
      const armed = { dieSize: result.dieSize, actorUuid: result.actorUuid, consumed: false };
      pendingGoadDamage.set(activity.uuid, { dieSize: armed.dieSize, messageId: message.id });
      await message.setFlag(MODULE_ID, GOAD_FLAG, armed);
      btn.replaceWith(buildRefundButton(message, container, activity, armed));
    } catch (err) {
      warn("goading attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh GOADING
 * ATTACK button. Cancels the pending damage-die addition too (a no-op if
 * Damage was already rolled — onGoadingAttackPreRollDamage already consumed
 * it by then, so only the resource bookkeeping happens in that case).
 */
async function onGoadRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  pendingGoadDamage.delete(activity.uuid);
  await message.unsetFlag(MODULE_ID, GOAD_FLAG);

  const maneuver = findGoadingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshGoadButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:goading-attack:refunded", actor?.name);
}

/** Build the GOADING ATTACK button. */
function buildGoadButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-bullhorn" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: inject the GOADING ATTACK button into the
 * ATTACK ROLL result message (flags.dnd5e.roll.type === "attack"), not the
 * pre-roll usage/activity card. Wrapped in the shared `.cst-<feature>-controls`
 * flex-row shape (see CLAUDE.md's "Chat-card action buttons" convention) since
 * this message has no native `.card-buttons` row to inherit styling from. If
 * this specific roll message is already armed (e.g. after a reload),
 * re-decorate instead of re-prompting — and only re-arm the in-memory
 * pending-damage map if the die hasn't already been consumed into a damage
 * roll.
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

  const armed = message.getFlag(MODULE_ID, GOAD_FLAG);
  if (armed) {
    if (!armed.consumed) pendingGoadDamage.set(activity.uuid, { dieSize: armed.dieSize, messageId: message.id });
    const wrap = document.createElement("div");
    wrap.className = CONTROLS_CLASS;
    wrap.appendChild(buildRefundButton(message, container, activity, armed));
    insertBeforeTrailingCardElements(container, wrap);
    return;
  }

  const maneuver = findGoadingAttackManeuver(actor);
  if (!maneuver) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildFreshGoadButton(container, message, activity, actor, maneuver));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:goading-attack:button", actor.name);
}

/** Register Goading Attack's activation flow. Call once during setup. Phase 2 extends this. */
export function registerGoadingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.preRollDamageV2", onGoadingAttackPreRollDamage);
}
