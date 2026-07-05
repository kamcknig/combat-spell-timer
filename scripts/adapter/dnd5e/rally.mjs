import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { insertBeforeTrailingCardElements } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Rally": the imported "Maneuver: Rally"
 * feat is a bare description item (no activities) — same shape as
 * Commander's Strike, so it follows the same dnd5e.preDisplayCard
 * interception pattern. Unlike every attack-tied maneuver, Rally has no
 * weapon-attack trigger at all ("On your turn, you can use a bonus action...
 * choose a friendly creature who can see or hear you") — it's a pure
 * bonus-action ally-buff, matching Commander's Strike's own "directs an
 * ally" shape (see commanders-strike.mjs's own doc comment). This file is a
 * close copy of Commander's Strike's bare-item flow, minus its second entry
 * point (the weapon usage-card button — not applicable here).
 */

const RALLY_FLAG = "rally"; // flags[MODULE_ID][RALLY_FLAG] = { actorUuid, dieSize, consumed, rolled }
const BTN_CLASS = "cst-rally-roll";
const REFUND_BTN_CLASS = "cst-rally-refund";

export const isRallyItem = (i) => i?.type === "feat" && i?.name?.toLowerCase() === "maneuver: rally";

/** dnd5e.preDisplayCard: intercept the maneuver's bare card, run our flow instead. */
export function onPreDisplayRallyCard(item, messageConfig) {
  if (!isRallyItem(item)) return true;
  handleRallyUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | rally failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleRallyUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Rally.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.Rally.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-flag",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  let consumed = false;
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0, so this
    // shouldn't be reachable through normal interaction — kept as a guard.
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Rally.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    consumed = true;
    dbg("dnd5e:rally:consumed", actor.name, remaining - 1);
  }
  await postRallyCard(actor, dieSize, cardData, consumed);
}

/** Post the announcement card carrying the deferred superiority-die roll button. */
async function postRallyCard(actor, dieSize, cardData, consumed) {
  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [RALLY_FLAG]: { actorUuid: actor.uuid, dieSize, consumed, rolled: false } },
    }),
  });
  dbg("dnd5e:rally:posted", actor.name, message?.id);
}

/**
 * Roll one superiority die + the actor's Charisma modifier (RAW: "temporary
 * hit points equal to the superiority die roll + your Charisma modifier")
 * and post it. Speaker is the maneuver's actor.
 */
async function onRollDie(actor, dieSize) {
  const roll = await new Roll(`1${dieSize} + @abilities.cha.mod`, actor.getRollData()).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.Rally.RollFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  dbg("dnd5e:rally:rolled", actor?.name, roll.total);
}

/**
 * Build the "Roll Superiority Die" button. DELIBERATELY NOT owner-gated —
 * Rally bolsters an ALLY, so any player may press it (mirrors Commander's
 * Strike exactly). When the card's use didn't actually consume a die (CHAT
 * action), it's gated on the pool still having a die available; when it did
 * consume one (`data.consumed`), the die is already reserved for this card so
 * the button stays enabled regardless of the pool's remaining count.
 */
function buildRollButton(message, data) {
  const actor = fromUuidSync(data.actorUuid);
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.Rally.RollButton")}`;
  if (!data.consumed && remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.Rally.NoDice");
  }
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRollDie(actor, data.dieSize);
      // Only a card whose use actually spent a die gets the refund toggle —
      // a CHAT-only roll has nothing to refund, so just leave it disabled.
      if (data.consumed) {
        const next = { ...data, rolled: true };
        await message.setFlag(MODULE_ID, RALLY_FLAG, next);
        btn.replaceWith(buildRefundButton(message, next));
      }
    } catch (err) {
      warn("rally roll failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/** Build the "REFUND RESOURCE" button: gives the spent superiority die back and swaps back to the roll button. */
function buildRefundButton(message, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = REFUND_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.RefundResourceButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      const actor = fromUuidSync(data.actorUuid);
      const pool = findCombatSuperiority(actor);
      if (pool) {
        const spent = Number(pool.system?.uses?.spent) || 0;
        await pool.update({ "system.uses.spent": Math.max(0, spent - 1) });
      }
      const next = { ...data, rolled: false };
      await message.setFlag(MODULE_ID, RALLY_FLAG, next);
      btn.replaceWith(buildRollButton(message, next));
      dbg("dnd5e:rally:refunded", actor?.name);
    } catch (err) {
      warn("rally refund failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage: append either the "Roll Superiority Die" button
 * or, once that roll has happened for a die-consuming card, the
 * "REFUND RESOURCE" button in its place. Inserted via
 * insertBeforeTrailingCardElements so it lands above the card's
 * property-tags footer rather than after it.
 */
function onRenderRallyMessage(message, html) {
  const data = message.getFlag(MODULE_ID, RALLY_FLAG);
  if (!data) return;
  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`) || container.querySelector(`.${REFUND_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-rally-controls";
  wrap.appendChild(data.consumed && data.rolled ? buildRefundButton(message, data) : buildRollButton(message, data));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:rally:button", data);
}

/** Register Rally's activation flow. Call once during setup. */
export function registerRallyHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayRallyCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderRallyMessage);
}
