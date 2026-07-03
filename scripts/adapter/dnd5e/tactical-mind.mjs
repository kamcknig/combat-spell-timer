import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { isSecondWindItem, usesOf } from "./second-wind.mjs";

/**
 * dnd5e Fighter "Tactical Mind" (2024): when you fail an ability check, you
 * can expend a use of Second Wind to roll 1d10 and add it to the check
 * instead of regaining HP. Tactical Mind's own ddb item carries no uses of
 * its own (`actions.class[].limitedUse` is null in the DDB export) — it
 * spends SECOND WIND's pool, so this module reads/consumes
 * `system.uses.spent` on the actor's Second Wind item, not Tactical Mind's.
 * Same bare-item / dnd5e.preDisplayCard interception shape as Second
 * Wind/Action Surge, including capturing dnd5e's already-rendered card
 * (`messageConfig.data`) so the announcement looks like a normal item card
 * (see second-wind.mjs's identical doc comment). Simplified from RAW: this
 * module doesn't detect which failed check the bonus applies to, or refund
 * the use on a still-failed check — it posts an announcement with a BONUS
 * button that rolls 1d10 on demand (CLAUDE.md's "Feature activation
 * dialogs" convention).
 */

const TACTICAL_MIND_FLAG = "tacticalMind"; // flags[MODULE_ID][TACTICAL_MIND_FLAG] = {actorUuid, rolled?}
const BTN_CLASS = "cst-tactical-mind-bonus";

const isTacticalMindItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "tactical mind" || i.system?.identifier?.toLowerCase() === "tactical-mind");

/** The actor's Second Wind item, or null. */
function secondWindItemOf(actor) {
  return actor?.items?.find(isSecondWindItem) ?? null;
}

/** dnd5e.preDisplayCard dispatch — cancels dnd5e's bare card, runs the module's own flow. */
export function onPreDisplayTacticalMindCard(item, messageConfig) {
  if (!isTacticalMindItem(item)) return true;
  handleTacticalMindUse(item, messageConfig?.data).catch((err) => console.error("combat-spell-timer | tactical mind failed", err));
  return false;
}

/** Prompt USE/CHAT, consume a Second Wind use on USE (if any remain), then post the announcement card either way. */
async function handleTacticalMindUse(item, cardData) {
  const actor = item.actor;
  if (!actor) return;
  const secondWind = secondWindItemOf(actor);
  const { remaining } = secondWind ? usesOf(secondWind) : { remaining: 0 };
  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.TacticalMind.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.TacticalMind.Prompt", { remaining }),
    icon: "fa-solid fa-brain",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0.
    if (!secondWind || remaining <= 0) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.TacticalMind.NoUses", { name: item.name }));
      return;
    }
    await secondWind.update({ "system.uses.spent": secondWind.system.uses.spent + 1 });
    dbg("dnd5e:tactical-mind:consumed", actor.name, remaining - 1);
  }
  await postTacticalMindCard(item, actor, cardData);
}

/** Post the announcement card carrying the deferred BONUS-roll button. */
async function postTacticalMindCard(item, actor, cardData) {
  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData.flags ?? {}, {
      [MODULE_ID]: { [TACTICAL_MIND_FLAG]: { actorUuid: actor.uuid } },
    }),
  });
  dbg("dnd5e:tactical-mind:posted", actor.name, message?.id);
}

/** True when the current user may act on this message's actor (owner or GM). */
function canRoll(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** Roll 1d10, post it, flag the card "rolled" so the button can't fire twice. */
async function onBonusClick(message, actor, data) {
  const roll = await new Roll("1d10").evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.TacticalMind.BonusFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  await message.update({ flags: { [MODULE_ID]: { [TACTICAL_MIND_FLAG]: { ...data, rolled: true } } } });
  dbg("dnd5e:tactical-mind:rolled", actor.name, roll.total);
}

/**
 * dnd5e.renderChatMessage handler: append the BONUS button to an eligible
 * Tactical Mind announcement card. Fires AFTER dnd5e's own card enrichment
 * (see second-wind.mjs's identical hook choice).
 */
function onRenderTacticalMindMessage(message, html) {
  const data = message.getFlag(MODULE_ID, TACTICAL_MIND_FLAG);
  if (!data || data.rolled) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor) return;
  if (!canRoll(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-tactical-mind-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d10"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.TacticalMind.BonusButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onBonusClick(message, actor, data);
      wrap.remove();
    } catch (err) {
      warn("tactical mind bonus roll failed", err);
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  container.appendChild(wrap);
  dbg("dnd5e:tactical-mind:button", actor.name);
}

/** Register Tactical Mind's use-flow + bonus-button hooks. Call once during setup. */
export function registerTacticalMindHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayTacticalMindCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderTacticalMindMessage);
}
