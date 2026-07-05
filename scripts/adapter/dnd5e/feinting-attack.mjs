import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { ensureEffectTemplate, injectEffectApplicationTray, insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";
import { FEINTED_FLAG, FEINTED_STATUS_ID } from "./features/feinting-attack.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Feinting Attack": same bare-feat-item
 * activation shape as Evasive Footwork (evasive-footwork.mjs) — a plain
 * description item, intercepted via dnd5e.preDisplayCard — USE spends one
 * Combat Superiority die and posts a ROLL SUPERIORITY DIE button on the
 * announcement card. Rolling posts the die result as its OWN separate chat
 * message (`Roll#toMessage`) and offers dnd5e's native apply-effects tray
 * directly on THAT roll message, sized to the roll — not back on the
 * announcement card, since the roll result is what the tray applies. Unlike
 * Evasive Footwork's self-applied AC bonus, this marker is applied to a
 * TARGET and drives roll-time automation handled in
 * features/feinting-attack.mjs (Advantage grant, early-end on the caster's
 * own attack against that target, and adding the rolled total to that
 * attack's damage roll) — this file owns only the activation/roll/tray half.
 */

const FEINT_FLAG = "feintingAttack"; // message flags[MODULE_ID][FEINT_FLAG] = {actorUuid, dieSize, consumed, rolled, total?}
const FEINT_ROLL_FLAG = "feintingAttackRoll"; // roll-result message flags[MODULE_ID][FEINT_ROLL_FLAG] = {actorUuid, total}
const CONTROLS_CLASS = "cst-feinting-attack-controls";
const BTN_CLASS = "cst-feinting-attack-roll";

export const isFeintingAttackItem = (i) => i?.type === "feat" && i?.name?.toLowerCase() === "maneuver: feinting attack";

/** The actor's "Maneuver: Feinting Attack" feat, or null. */
function findFeintingAttackManeuver(actor) {
  return findFeat(actor, "maneuver: feinting attack", "maneuver-feinting-attack");
}

/** True when the current user may act on this message's actor (owner or GM). */
function canAct(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** dnd5e.preDisplayCard: intercept the maneuver's bare card, run our flow instead. */
export function onPreDisplayFeintingAttackCard(item, messageConfig) {
  if (!isFeintingAttackItem(item)) return true;
  handleFeintingAttackUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | feinting attack failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleFeintingAttackUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.FeintingAttack.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.FeintingAttack.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-mask",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  let consumed = false;
  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.FeintingAttack.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    consumed = true;
    dbg("dnd5e:feinting-attack:consumed", actor.name, remaining - 1);
  }

  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [FEINT_FLAG]: { actorUuid: actor.uuid, dieSize, consumed, rolled: false } },
    }),
  });
  dbg("dnd5e:feinting-attack:announced", actor.name, message?.id, consumed);
}

/**
 * (Re-)stamp the maneuver item's persisted effect template with `total` and
 * offer it via the native apply-effects tray. Called on every render of a
 * rolled card, not just the first roll, so the template always reflects THIS
 * message's own roll — see effect-application-tray.mjs's ensureEffectTemplate
 * doc comment on why extraFlags refreshes on reuse.
 */
async function showFeintingAttackTray(html, maneuver, actor, total) {
  const effectDoc = await ensureEffectTemplate(maneuver, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.FeintingAttack.EffectName"),
    statusId: FEINTED_STATUS_ID,
    flagKey: FEINTED_FLAG,
    extraFlags: { feintTotal: total },
  });
  injectEffectApplicationTray(html, effectDoc);
}

/**
 * Roll the superiority die, persist the result onto the announcement
 * message, remove the now-spent roll button, and post the roll as its own
 * chat message — flagged so onRenderFeintingAttackRollMessage can offer the
 * apply-effects tray directly on THAT message once it renders, not back on
 * the announcement card.
 */
async function onRollClick(message, container, actor, data) {
  const roll = await new Roll(`1${data.dieSize}`).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.FeintingAttack.RollFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { [MODULE_ID]: { [FEINT_ROLL_FLAG]: { actorUuid: actor.uuid, total: roll.total } } },
  });
  const next = { ...data, rolled: true, total: roll.total };
  await message.setFlag(MODULE_ID, FEINT_FLAG, next);
  container.querySelector(`.${CONTROLS_CLASS}`)?.remove();
  dbg("dnd5e:feinting-attack:rolled", actor.name, roll.total);
}

/** Build the "ROLL SUPERIORITY DIE" icon button. */
function buildRollButton(message, container, actor, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.FeintingAttack.RollButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRollClick(message, container, actor, data);
    } catch (err) {
      warn("feinting attack roll failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage: on Feinting Attack's own announcement card, show
 * the roll button — only while it hasn't been rolled yet; once rolled, this
 * card has nothing left to show (the tray lives on the separate roll
 * message instead — see onRenderFeintingAttackRollMessage). A CHAT-only card
 * (no die spent) gets no button. Inserted via insertBeforeTrailingCardElements
 * so it lands above the card's property-tags footer rather than after it (a
 * bare appendChild would put it below the tags — see
 * effect-application-tray.mjs's doc comment).
 */
async function onRenderFeintingAttackMessage(message, html) {
  const data = message.getFlag(MODULE_ID, FEINT_FLAG);
  if (!data || !data.consumed || data.rolled) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor || !canAct(actor)) return;
  if (!findFeintingAttackManeuver(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildRollButton(message, container, actor, data));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:feinting-attack:card", actor.name);
}

/**
 * dnd5e.renderChatMessage: offer the Feinting Attack apply-effects tray on
 * the superiority-die roll message itself — the roll IS the value the tray
 * applies to a target, so it belongs on that message, not the announcement
 * card. Re-runs on every render (including after a reload), which is safe:
 * ensureEffectTemplate's `existing` branch just refreshes the stored total
 * rather than duplicating the template.
 */
async function onRenderFeintingAttackRollMessage(message, html) {
  const data = message.getFlag(MODULE_ID, FEINT_ROLL_FLAG);
  if (!data) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor) return;
  const maneuver = findFeintingAttackManeuver(actor);
  if (!maneuver) return;
  await showFeintingAttackTray(html, maneuver, actor, data.total);
}

/** Register Feinting Attack's activation flow. Call once during setup. */
export function registerFeintingAttackHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayFeintingAttackCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderFeintingAttackMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderFeintingAttackRollMessage);
}
