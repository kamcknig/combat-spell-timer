import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { insertBeforeTrailingCardElements, ensureEffectTemplate, injectEffectApplicationTray } from "./effect-application-tray.mjs";
import { findFeat } from "./features/shared.mjs";
import { BAIT_AND_SWITCH_FLAG, BAIT_AND_SWITCH_STATUS_ID } from "./features/bait-and-switch.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Bait and Switch": "When you're
 * within 5 feet of a creature on your turn, you can expend one superiority
 * die and switch places with that creature... Roll the superiority die.
 * Until the start of your next turn, you or the other creature (your
 * choice) gains a bonus to AC equal to the number rolled." Bare feat item
 * (no activities, no weapon trigger) — same dnd5e.preDisplayCard
 * interception shape as Rally/Commander's Strike/Evasive Footwork.
 *
 * Unlike Rally (whose roll is flavor-only, no downstream mechanical
 * effect — so its roll button stays available even on a CHAT-only card) and
 * unlike Evasive Footwork (whose apply-effects tray lands on the SAME
 * announcement card as the roll button), Bait and Switch: (1) only shows a
 * roll button when a die was actually spent (USE), matching Evasive
 * Footwork's "there's no free, no-cost version of a real AC bonus"
 * reasoning; and (2) posts its roll as its OWN separate chat message
 * (matching Rally's roll.toMessage() shape) — the apply-effects tray is
 * injected onto THAT roll message instead of the announcement card, via a
 * second flag/render-hook pair (BS_ROLL_FLAG). Once rolled, the
 * announcement card's controls are simply removed (no restated "Rolled X"
 * text — see this repo's CLAUDE.md gotcha on that anti-pattern; the actual
 * result is already visible on the separate roll message). No refund
 * toggle once a die is spent, since the roll immediately produces a real
 * apply-effects opportunity a table member may already have acted on.
 *
 * The applied AC-bonus marker is tracked by this module's combat-tracker
 * timer system (features/bait-and-switch.mjs) exactly like Sap/Slow/
 * Distracting Strike, since RAW gives it a defined duration ("until the
 * start of your next turn" = 1 round), unlike Evasive Footwork's
 * untrackable "until you stop moving."
 */

const BS_FLAG = "baitAndSwitch"; // announcement-card message flags[MODULE_ID][BS_FLAG] = {actorUuid, dieSize, consumed, rolled}
const BS_ROLL_FLAG = "baitAndSwitchRoll"; // roll-message flags[MODULE_ID][BS_ROLL_FLAG] = {actorUuid}
const CONTROLS_CLASS = "cst-bait-and-switch-controls";
const BTN_CLASS = "cst-bait-and-switch-roll";

export const isBaitAndSwitchItem = (i) => i?.type === "feat" && i?.name?.toLowerCase() === "maneuver: bait and switch";

/** The actor's "Maneuver: Bait and Switch" feat, or null. */
function findBaitAndSwitchManeuver(actor) {
  return findFeat(actor, "maneuver: bait and switch", "maneuver-bait-and-switch");
}

/** True when the current user may act on this message's actor (owner or GM). */
function canAct(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** dnd5e.preDisplayCard: intercept the maneuver's bare card, run our flow instead. */
export function onPreDisplayBaitAndSwitchCard(item, messageConfig) {
  if (!isBaitAndSwitchItem(item)) return true;
  handleBaitAndSwitchUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | bait and switch failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleBaitAndSwitchUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.BaitAndSwitch.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.BaitAndSwitch.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-arrow-right-arrow-left",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  let consumed = false;
  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.BaitAndSwitch.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    consumed = true;
    dbg("dnd5e:bait-and-switch:consumed", actor.name, remaining - 1);
  }

  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [BS_FLAG]: { actorUuid: actor.uuid, dieSize, consumed, rolled: false } },
    }),
  });
  dbg("dnd5e:bait-and-switch:announced", actor.name, message?.id, consumed);
}

/**
 * Roll the superiority die as its OWN chat message (RAW: "Roll the
 * superiority die"), stamped with BS_ROLL_FLAG so the roll message's own
 * render hook can find the caster and offer the apply-effects tray there.
 * Also stamps `flags.dnd5e.item.uuid` to the maneuver item: dnd5e's
 * EffectApplicationElement#_onApplyEffect ignores the tray's own `.effects`
 * property and independently re-resolves the clicked effect via
 * `chatMessage.getAssociatedItem()?.effects.get(id)` (getAssociatedItem()
 * reads exactly this flag) — without it, a bare `roll.toMessage()` has no
 * item association at all, so Apply silently finds nothing to clone.
 * Removes the announcement card's controls afterward (no restated result
 * text — see this file's doc comment).
 */
function buildRollButton(message, actor, maneuver, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.BaitAndSwitch.RollButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      const roll = await new Roll(`1${data.dieSize}`).evaluate();
      const rollMessage = await roll.toMessage({
        flavor: game.i18n.localize("COMBAT_SPELL_TIMER.BaitAndSwitch.RollFlavor"),
        speaker: ChatMessage.getSpeaker({ actor }),
        flags: { dnd5e: { item: { uuid: maneuver.uuid } } },
      });
      await rollMessage.setFlag(MODULE_ID, BS_ROLL_FLAG, { actorUuid: actor.uuid });
      await message.setFlag(MODULE_ID, BS_FLAG, { ...data, rolled: true });
      btn.closest(`.${CONTROLS_CLASS}`)?.remove();
      dbg("dnd5e:bait-and-switch:rolled", actor.name, roll.total);
    } catch (err) {
      warn("bait and switch roll failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage: show the "Roll Superiority Die" button on Bait
 * and Switch's own announcement card, but ONLY when the card actually spent
 * a die and hasn't been rolled yet — a CHAT-only card, or an already-rolled
 * card, gets nothing (see this file's doc comment on why, matching Evasive
 * Footwork's stricter gating rather than Rally's permissive one).
 */
function onRenderBaitAndSwitchMessage(message, html) {
  const data = message.getFlag(MODULE_ID, BS_FLAG);
  if (!data || !data.consumed || data.rolled) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor || !canAct(actor)) return;
  const maneuver = findBaitAndSwitchManeuver(actor);
  if (!maneuver) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  wrap.appendChild(buildRollButton(message, actor, maneuver, data));
  insertBeforeTrailingCardElements(container, wrap);
  dbg("dnd5e:bait-and-switch:card", actor.name);
}

/**
 * dnd5e.renderChatMessage: on the SEPARATE roll message Bait and Switch's
 * own roll button posted, (re-)stamp the maneuver item's persisted effect
 * template with this roll's AC bonus and offer it via the native
 * apply-effects tray. Runs on every render (not just the first), matching
 * ensureEffectTemplate's own "changes refreshes on reuse" contract.
 */
async function onRenderBaitAndSwitchRollMessage(message, html) {
  const data = message.getFlag(MODULE_ID, BS_ROLL_FLAG);
  if (!data) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor || !canAct(actor)) return;
  const maneuver = findBaitAndSwitchManeuver(actor);
  if (!maneuver) return;
  const total = message.rolls?.[0]?.total;
  if (typeof total !== "number") return;

  const effectDoc = await ensureEffectTemplate(maneuver, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.BaitAndSwitch.EffectName"),
    statusId: BAIT_AND_SWITCH_STATUS_ID,
    flagKey: BAIT_AND_SWITCH_FLAG,
    changes: [
      { key: "system.attributes.ac.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: `+${total}`, priority: 20 },
    ],
  });
  injectEffectApplicationTray(html, effectDoc);
  dbg("dnd5e:bait-and-switch:tray", actor.name, total);
}

/** Register Bait and Switch's activation flow. Call once during setup. */
export function registerBaitAndSwitchHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayBaitAndSwitchCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderBaitAndSwitchMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderBaitAndSwitchRollMessage);
}
