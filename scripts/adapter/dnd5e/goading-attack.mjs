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

  // Item#displayCard() fires the SAME dnd5e.preDisplayCard hook entry 2 listens
  // on for a real bare-item click — without this flag, entry 2's own handler
  // would intercept THIS call too and pop a second FeatureUseDialog. Stamping
  // SUPPRESS_ANNOUNCE_FLAG lets onPreDisplayGoadingAttackCard recognize "this
  // is entry 1's own plain announcement" and let it through untouched.
  await maneuverItem.displayCard({ flags: { [MODULE_ID]: { [SUPPRESS_ANNOUNCE_FLAG]: true } } });
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

const GOAD_ANNOUNCE_FLAG = "goadingAttackAnnounce"; // bare-item message flags[MODULE_ID][GOAD_ANNOUNCE_FLAG] = {actorUuid, dieSize, consumed, rolled}
const SUPPRESS_ANNOUNCE_FLAG = "goadingAttackSuppressAnnounce"; // set on entry 1's own displayCard() call so entry 2 doesn't re-intercept it
const ANNOUNCE_CONTROLS_CLASS = "cst-goading-attack-announce-controls";
const ANNOUNCE_BTN_CLASS = "cst-goading-attack-announce-roll";
const ANNOUNCE_REFUND_BTN_CLASS = "cst-goading-attack-announce-refund";

export const isGoadingAttackItem = (i) => i?.type === "feat" && i?.name?.toLowerCase() === "maneuver: goading attack";

/** True when the current user may act on this message's actor (owner or GM). */
function canActAnnounce(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/**
 * dnd5e.preDisplayCard: intercept the bare maneuver item's own card, run our
 * standalone flow instead — UNLESS this call originated from entry 1's own
 * handleGoadingAttackUse() posting its plain announcement (that also goes
 * through Item#displayCard(), which fires this same hook); see
 * SUPPRESS_ANNOUNCE_FLAG.
 */
export function onPreDisplayGoadingAttackCard(item, messageConfig) {
  if (!isGoadingAttackItem(item)) return true;
  if (messageConfig?.data?.flags?.[MODULE_ID]?.[SUPPRESS_ANNOUNCE_FLAG]) return true;
  handleGoadingAttackItemUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | goading attack failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleGoadingAttackItemUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.GoadingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-bullhorn",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  let consumed = false;
  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    consumed = true;
    dbg("dnd5e:goading-attack:item-consumed", actor.name, remaining - 1);
  }

  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [GOAD_ANNOUNCE_FLAG]: { actorUuid: actor.uuid, dieSize, consumed, rolled: false } },
    }),
  });
  dbg("dnd5e:goading-attack:item-announced", actor.name, message?.id, consumed);
}

/**
 * Roll the superiority die, persist the result onto the announcement
 * message, post the roll as its own chat message, and swap the roll button
 * for REFUND RESOURCE (same toggle shape as Commander's Strike's own
 * roll-or-refund card) — no apply-effects tray, since no target marker was
 * requested for this maneuver.
 */
async function onAnnounceRollClick(message, container, actor, data) {
  const roll = await new Roll(`1${data.dieSize}`).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.RollFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  const next = { ...data, rolled: true, total: roll.total };
  await message.setFlag(MODULE_ID, GOAD_ANNOUNCE_FLAG, next);
  const btn = container.querySelector(`.${ANNOUNCE_BTN_CLASS}`);
  if (btn) btn.replaceWith(buildAnnounceRefundButton(message, container, actor, next));
  dbg("dnd5e:goading-attack:item-rolled", actor.name, roll.total);
}

/** Build the "ROLL SUPERIORITY DIE" icon button for entry 2's announcement card. */
function buildAnnounceRollButton(message, container, actor, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = ANNOUNCE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.GoadingAttack.RollButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onAnnounceRollClick(message, container, actor, data);
    } catch (err) {
      warn("goading attack roll failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the REFUND RESOURCE button that replaces a rolled ROLL SUPERIORITY DIE button. */
function buildAnnounceRefundButton(message, container, actor, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = ANNOUNCE_REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onAnnounceRefundClick(message, container, actor, data);
    } catch (err) {
      warn("goading attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh ROLL
 * SUPERIORITY DIE button — only `rolled` flips back to false; `consumed`
 * stays true (this card DID spend a die at USE time — a permanent fact
 * about it), same as Commander's Strike's own refund shape. Nothing about
 * the already-posted roll message is retracted.
 */
async function onAnnounceRefundClick(message, container, actor, data) {
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }
  const next = { ...data, rolled: false };
  await message.setFlag(MODULE_ID, GOAD_ANNOUNCE_FLAG, next);
  const btn = container.querySelector(`.${ANNOUNCE_REFUND_BTN_CLASS}`);
  if (btn) btn.replaceWith(buildAnnounceRollButton(message, container, actor, next));
  dbg("dnd5e:goading-attack:item-refunded", actor?.name);
}

/**
 * dnd5e.renderChatMessage: on Goading Attack's own bare-item announcement
 * card, show the roll button (not yet rolled) or the REFUND RESOURCE button
 * (already rolled) for any card that actually spent a die. A CHAT-only card
 * (no die spent) gets neither.
 */
async function onRenderGoadingAttackAnnounceMessage(message, html) {
  const data = message.getFlag(MODULE_ID, GOAD_ANNOUNCE_FLAG);
  if (!data || !data.consumed) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor || !canActAnnounce(actor)) return;
  if (!findGoadingAttackManeuver(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${ANNOUNCE_CONTROLS_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = ANNOUNCE_CONTROLS_CLASS;
  wrap.appendChild(data.rolled
    ? buildAnnounceRefundButton(message, container, actor, data)
    : buildAnnounceRollButton(message, container, actor, data));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:goading-attack:item-card", actor.name, data.rolled);
}

/** Register Goading Attack's activation flow. Call once during setup. */
export function registerGoadingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackRollMessage);
  Hooks.on("dnd5e.preRollDamageV2", onGoadingAttackPreRollDamage);
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayGoadingAttackCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderGoadingAttackAnnounceMessage);
}
