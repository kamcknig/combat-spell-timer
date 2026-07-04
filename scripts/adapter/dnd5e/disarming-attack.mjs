import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { canAct, attackAbilityMod } from "./weapon-mastery.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Disarming Attack": unlike Commander's
 * Strike (declared standalone, directs an ally), this maneuver is declared
 * against a SPECIFIC weapon attack ("when you hit a creature with a weapon
 * attack") — so its entry point is a button injected into that weapon's own
 * usage card (activity-card.hbs's .card-buttons, the same row holding the
 * native Attack/Damage buttons — see weapon-mastery.mjs's Graze/Topple for
 * the established pattern of appending directly into that row). Spends from
 * the same Combat Superiority pool as Commander's Strike. The "Maneuver:
 * Disarming Attack" item itself is NOT intercepted — clicking it directly
 * stays inert/cosmetic; all mechanics live behind this button.
 */

const DISARM_FLAG = "disarmingAttack"; // message flags[MODULE_ID][DISARM_FLAG] = {dieSize, actorUuid, consumed?}
const BTN_CLASS = "cst-disarming-attack";
const REFUND_BTN_CLASS = "cst-disarming-attack-refund";
const DAMAGE_LABEL_MARK = "cstDisarmLabeled"; // dataset marker: guards against re-appending the label suffix

/** The actor's "Maneuver: Disarming Attack" feat, or null. */
function findDisarmingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: disarming attack", "maneuver-disarming-attack");
}

/** Relabel the native Damage button in `container` with a "(Disarming)" suffix, once. */
function relabelDamageButton(container) {
  const btn = container.querySelector('button[data-action="rollDamage"]');
  if (!btn || btn.dataset[DAMAGE_LABEL_MARK]) return btn;
  const label = btn.querySelector("span");
  if (label) label.textContent = `${label.textContent} ${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.DamageLabelSuffix")}`;
  btn.dataset[DAMAGE_LABEL_MARK] = "true";
  return btn;
}

/**
 * Undo relabelDamageButton and strip our armDamageButton listener (via a
 * node clone — native delegated click handling lives on an ancestor, not on
 * this button, so cloning only drops the listener we attached directly).
 * Only called on refund when the die was never actually rolled into damage.
 */
function unrelabelDamageButton(container) {
  const btn = container.querySelector('button[data-action="rollDamage"]');
  if (!btn) return;
  if (btn.dataset[DAMAGE_LABEL_MARK]) {
    const label = btn.querySelector("span");
    const suffix = ` ${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.DamageLabelSuffix")}`;
    if (label?.textContent.endsWith(suffix)) label.textContent = label.textContent.slice(0, -suffix.length);
  }
  const fresh = btn.cloneNode(true);
  delete fresh.dataset[DAMAGE_LABEL_MARK];
  delete fresh.dataset.cstDisarmArmed;
  btn.replaceWith(fresh);
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post a plain announcement either way. */
async function handleDisarmingAttackUse(maneuverItem) {
  const actor = maneuverItem.actor;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.DisarmingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-hand",
    canUse: remaining > 0,
  });
  if (!action) return null; // dismissed — card stays un-armed

  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0.
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoDice"));
      return null;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:disarming-attack:consumed", actor.name, remaining - 1);
  }

  await maneuverItem.displayCard(); // plain native item card; no preDisplayCard interception registered for this item
  dbg("dnd5e:disarming-attack:announced", actor.name, action);
  return { dieSize, actorUuid: actor.uuid, action };
}

const pendingDisarmDamage = new Map(); // activity.uuid -> { dieSize }
export const pendingDisarmApplied = new Map(); // activity.uuid -> { dieSize, actorUuid } — consumed by Phase 3

/**
 * Attach a bubble-phase listener directly on the native Damage button that
 * arms `pendingDisarmDamage` for this activity BEFORE dnd5e's own delegated
 * click handler (bound higher up, on the chat log) runs — DOM events bubble
 * target-first, so a listener on the button itself always fires first. Runs
 * synchronously (no await) so there is no window for an unrelated Damage
 * click elsewhere to interleave. One-shot: also flips the message's
 * `consumed` flag (fire-and-forget) so a later re-render of this same
 * message does not re-arm the listener on a second, unrelated Damage click.
 */
function armDamageButton(container, message, activity, dieSize) {
  const btn = container.querySelector('button[data-action="rollDamage"]');
  if (!btn || btn.dataset.cstDisarmArmed) return;
  btn.dataset.cstDisarmArmed = "true";
  btn.addEventListener("click", () => {
    pendingDisarmDamage.set(activity.uuid, { dieSize });
    message.update({ [`flags.${MODULE_ID}.${DISARM_FLAG}.consumed`]: true });
  }, { once: true });
}

/**
 * dnd5e.preRollDamageV2: if this activity has a pending Disarming Attack die,
 * append it to the first damage roll's parts (Cleave's onWeaponMasteryPreRollDamage
 * does the same thing subtractively — see weapon-mastery.mjs) and stash the
 * die/actor for Phase 3's Strength Save button to pick up off the resulting
 * damage message.
 */
export function onDisarmingAttackPreRollDamage(config) {
  const activity = config?.subject;
  if (!activity || !pendingDisarmDamage.has(activity.uuid)) return;
  const { dieSize } = pendingDisarmDamage.get(activity.uuid);
  pendingDisarmDamage.delete(activity.uuid);
  const roll = config.rolls?.[0];
  if (!roll) return;
  roll.parts = [...(roll.parts ?? []), `1${dieSize}`];
  pendingDisarmApplied.set(activity.uuid, { dieSize, actorUuid: activity.actor?.uuid });
  dbg("dnd5e:disarming-attack:die-added", activity.item?.name, dieSize);
}

/** Replace the DISARMING ATTACK button with REFUND RESOURCE and relabel the Damage button — the visible "armed" state. */
function decorateArmed(container, message, activity, armed) {
  const existingBtn = container.querySelector(`.${BTN_CLASS}`);
  if (existingBtn) existingBtn.replaceWith(buildRefundButton(message, container, activity, armed));
  else if (!container.querySelector(`.${REFUND_BTN_CLASS}`)) container.appendChild(buildRefundButton(message, container, activity, armed));
  relabelDamageButton(container);
  if (!armed.consumed) armDamageButton(container, message, activity, armed.dieSize);
}

/** Build the fresh (unarmed) DISARMING ATTACK button and wire its use-flow click handler. */
function buildFreshDisarmButton(container, message, activity, actor, maneuver) {
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const btn = buildDisarmButton(remaining, async () => {
    btn.disabled = true;
    try {
      const result = await handleDisarmingAttackUse(maneuver);
      if (!result) { btn.disabled = false; return; } // dismissed — leave clickable
      if (result.action !== "use") { btn.disabled = false; return; } // CHAT — announce only, card stays un-armed
      const newArmed = { dieSize: result.dieSize, actorUuid: result.actorUuid };
      await message.setFlag(MODULE_ID, DISARM_FLAG, newArmed);
      decorateArmed(container, message, activity, newArmed);
    } catch (err) {
      warn("disarming attack failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the REFUND RESOURCE button that replaces an armed DISARMING ATTACK button. */
function buildRefundButton(message, container, activity, armed) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onDisarmRefundClick(message, container, activity, armed);
    } catch (err) {
      warn("disarming attack refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Refund the spent Combat Superiority die and swap back to a fresh
 * DISARMING ATTACK button. If the die was never rolled into damage yet,
 * also cancels the pending damage-die addition and un-relabels the Damage
 * button — otherwise (damage already resolved with the die included) only
 * the resource bookkeeping is undone; the already-posted damage roll and
 * its label stand as history.
 */
async function onDisarmRefundClick(message, container, activity, armed) {
  const actor = fromUuidSync(armed.actorUuid);
  const pool = findCombatSuperiority(actor);
  if (pool) {
    const spent = Number(pool.system?.uses?.spent) || 0;
    await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
  }

  if (!armed.consumed) {
    pendingDisarmDamage.delete(activity.uuid);
    unrelabelDamageButton(container);
  }

  await message.unsetFlag(MODULE_ID, DISARM_FLAG);

  const maneuver = findDisarmingAttackManeuver(actor);
  const refundBtn = container.querySelector(`.${REFUND_BTN_CLASS}`);
  if (maneuver && refundBtn) refundBtn.replaceWith(buildFreshDisarmButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:disarming-attack:refunded", actor?.name);
}

/**
 * dnd5e.renderChatMessage handler: inject the DISARMING ATTACK button into a
 * weapon's usage card (.card-buttons — same row as the native Attack/Damage
 * buttons; see weapon-mastery.mjs's Graze/Topple for the established
 * pattern). If this specific card is already armed (flags[MODULE_ID][DISARM_FLAG]
 * set — e.g. after a reload), re-decorate instead of re-prompting.
 */
function onRenderWeaponUsageCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (item.type !== "weapon") return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container || !container.querySelector('button[data-action="rollDamage"]')) return;

  const armed = message.getFlag(MODULE_ID, DISARM_FLAG);
  if (armed) {
    decorateArmed(container, message, activity, armed);
    return;
  }

  if (container.querySelector(`.${BTN_CLASS}`)) return; // already injected this render
  const maneuver = findDisarmingAttackManeuver(actor);
  if (!maneuver) return;

  container.appendChild(buildFreshDisarmButton(container, message, activity, actor, maneuver));
  dbg("dnd5e:disarming-attack:button", actor.name);
}

/** Build the DISARMING ATTACK button (native .card-buttons styling — no wrapper/custom CSS needed). */
function buildDisarmButton(remaining, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-hand" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.Button")}</span>`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoDice");
  }
  btn.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return btn;
}

const SAVE_BTN_CLASS = "cst-disarming-attack-save";

/** 8 + the ability modifier used for the attack + the attacker's proficiency bonus (same shape as Topple's DC). */
function disarmingAttackDc(activity, actor) {
  return 8 + attackAbilityMod(activity) + (actor?.system?.attributes?.prof ?? 0);
}

/** Every targeted actor, or every controlled actor if nothing is targeted. */
function resolveSaveTargets() {
  const targeted = Array.from(game.user?.targets ?? []).map((t) => t.actor).filter(Boolean);
  if (targeted.length) return targeted;
  return (canvas.tokens?.controlled ?? []).map((t) => t.actor).filter(Boolean);
}

async function onStrengthSaveClick(activity, actorUuid) {
  const attacker = fromUuidSync(actorUuid);
  const dc = disarmingAttackDc(activity, attacker);
  const targets = resolveSaveTargets();
  if (!targets.length) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.NoTargets"));
    return;
  }
  for (const target of targets) {
    await target.rollSavingThrow({ ability: "str", target: dc }, {}, {});
  }
  dbg("dnd5e:disarming-attack:saves", targets.map((t) => t.name), dc);
}

/**
 * dnd5e.renderChatMessage: append a Strength Save button to the damage
 * message an armed Disarming Attack die was just added to. The pending
 * activity->die/actor mapping (pendingDisarmApplied, set in
 * onDisarmingAttackPreRollDamage above) is transferred onto the message's
 * own flags on first render so later re-renders (scroll, reload) still show
 * the button after the in-memory map entry is gone.
 */
function onRenderDisarmDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  if (!activity) return;

  let applied = message.getFlag(MODULE_ID, "disarmingAttackApplied");
  if (!applied) {
    const pending = pendingDisarmApplied.get(activity.uuid);
    if (!pending) return;
    applied = pending;
    pendingDisarmApplied.delete(activity.uuid);
    message.setFlag(MODULE_ID, "disarmingAttackApplied", applied);
  }

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${SAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-disarming-attack-save-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = SAVE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.DisarmingAttack.SaveButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onStrengthSaveClick(activity, applied.actorUuid);
    } catch (err) {
      warn("disarming attack save failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  const damageApplication = container.querySelector("damage-application");
  if (damageApplication) container.insertBefore(wrap, damageApplication);
  else container.appendChild(wrap);
  dbg("dnd5e:disarming-attack:save-button", activity.item?.name);
}

/** Register Disarming Attack's usage-card button + activation flow. Call once during setup. */
export function registerDisarmingAttackHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderWeaponUsageCard);
  Hooks.on("dnd5e.preRollDamageV2", onDisarmingAttackPreRollDamage);
  Hooks.on("dnd5e.renderChatMessage", onRenderDisarmDamageMessage);
}
