import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";

/**
 * dnd5e Fighter "Second Wind": bonus action, 1d10 + fighter level healing,
 * once per short or long rest. The ddb item is a bare description item (no
 * activities, no consumption) — Item5e#use skips the activity pipeline and
 * posts the card directly via dnd5e.preDisplayCard, exactly like Path to the
 * Grave's pre-fix-up path (path-to-the-grave.mjs). Unlike PTG, this module
 * fully owns the flow FOREVER (no native-flow hand-off): every use is
 * intercepted, a module dialog (FeatureUseDialog: USE/CHAT) replaces dnd5e's
 * native Ability Use dialog, and the resulting chat card carries its own
 * "Roll Healing" button — clicking it is what actually rolls and heals. See
 * CLAUDE.md's "Feature activation dialogs" section for why this shape
 * (announce now, roll later, on a chat-card button click) is the module's
 * standard for feature activation flows going forward.
 */

const SECOND_WIND_FLAG = "secondWind"; // flags[MODULE_ID][SECOND_WIND_FLAG] = {actorUuid, itemUuid, healed?}
const BTN_CLASS = "cst-second-wind-heal";

export const isSecondWindItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "second wind" || i.system?.identifier?.toLowerCase() === "second-wind");

/** An item's usable uses as numbers (mirrors path-to-the-grave.mjs's usesOf — not shared, both tiny/local). */
export function usesOf(item) {
  const max = Number(item?.system?.uses?.max) || 0;
  const spent = Number(item?.system?.uses?.spent) || 0;
  return { max, spent, remaining: Math.max(0, max - spent) };
}

/**
 * dnd5e.preDisplayCard dispatch — the path a no-activity item takes. Always
 * cancels dnd5e's bare card and runs the module's own USE/CHAT flow instead
 * (never hands off to a native flow, unlike Path to the Grave).
 * `messageConfig.data` is already dnd5e's fully-rendered card (icon + name +
 * description, via item-card.hbs) plus its speaker and `flags.dnd5e.item` —
 * captured here and reused as-is so the eventual announcement looks exactly
 * like a normal dnd5e item-use card instead of a hand-rolled one-line flavor
 * message.
 */
export function onPreDisplaySecondWindCard(item, messageConfig) {
  if (!isSecondWindItem(item)) return true;
  handleSecondWindUse(item, messageConfig?.data).catch((err) => console.error("combat-spell-timer | second wind failed", err));
  return false;
}

/** Prompt USE/CHAT, consume on USE (if uses remain), then post the announcement card either way. */
async function handleSecondWindUse(item, cardData) {
  const actor = item.actor;
  if (!actor) return;
  const { remaining } = usesOf(item);
  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.SecondWind.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.SecondWind.Prompt", { remaining }),
    icon: "fa-solid fa-heart",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0, so this
    // shouldn't be reachable through normal interaction — kept as a guard.
    if (remaining <= 0) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.SecondWind.NoUses", { name: item.name }));
      return;
    }
    await item.update({ "system.uses.spent": item.system.uses.spent + 1 });
    dbg("dnd5e:second-wind:consumed", actor.name, remaining - 1);
  }
  await postSecondWindCard(item, actor, cardData);
}

/** Post the announcement card carrying the deferred heal-roll button. */
async function postSecondWindCard(item, actor, cardData) {
  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData.flags ?? {}, {
      [MODULE_ID]: { [SECOND_WIND_FLAG]: { actorUuid: actor.uuid, itemUuid: item.uuid } },
    }),
  });
  dbg("dnd5e:second-wind:posted", actor.name, message?.id);
}

/** True when the current user may act on this message's actor (owner or GM). */
function canHeal(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** Roll 1d10 + fighter level, post it, heal the actor, flag the card "healed" so the button can't fire twice. */
async function onHealClick(message, actor, data) {
  const fighterLevel = actor?.classes?.fighter?.system?.levels ?? 0;
  const roll = await new Roll(`1d10 + ${fighterLevel}`).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.SecondWind.HealFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  await actor.applyDamage(-roll.total);
  await message.update({ flags: { [MODULE_ID]: { [SECOND_WIND_FLAG]: { ...data, healed: true } } } });
  dbg("dnd5e:second-wind:healed", actor.name, roll.total);
}

/**
 * dnd5e.renderChatMessage handler: append the "Roll Healing" button to an
 * eligible Second Wind announcement card. Fires AFTER dnd5e's own card
 * enrichment (same reasoning as great-weapon-fighting.mjs's identical
 * hook choice — see CLAUDE.md's renderChatMessageHTML vs
 * dnd5e.renderChatMessage note).
 */
function onRenderSecondWindMessage(message, html) {
  const data = message.getFlag(MODULE_ID, SECOND_WIND_FLAG);
  if (!data || data.healed) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor) return;
  if (!canHeal(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-second-wind-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d10"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.SecondWind.HealButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onHealClick(message, actor, data);
      wrap.remove();
    } catch (err) {
      warn("second wind heal failed", err);
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  container.appendChild(wrap);
  dbg("dnd5e:second-wind:button", actor.name);
}

/** Register Second Wind's use-flow + heal-button hooks. Call once during setup. */
export function registerSecondWindHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplaySecondWindCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderSecondWindMessage);
}
