import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";

/**
 * dnd5e Fighter "Action Surge": take one additional action on your turn
 * (except the Magic action), once (twice at level 17+) per short or long
 * rest. Same bare-item / dnd5e.preDisplayCard interception shape as Second
 * Wind (second-wind.mjs) — the ddb item has no activities, so Item5e#use()
 * skips the activity pipeline and fires dnd5e.preDisplayCard before posting
 * a bare description card; this module cancels that and runs its own
 * USE/CHAT flow instead (CLAUDE.md's "Feature activation dialogs"
 * convention). Simpler than Second Wind: there's nothing to roll or apply,
 * so the announcement chat card is the entire flow — no deferred button.
 */

const isActionSurgeItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "action surge" || i.system?.identifier?.toLowerCase() === "action-surge");

/** An item's usable uses as numbers (mirrors second-wind.mjs's usesOf). */
function usesOf(item) {
  const max = Number(item?.system?.uses?.max) || 0;
  const spent = Number(item?.system?.uses?.spent) || 0;
  return { max, spent, remaining: Math.max(0, max - spent) };
}

/**
 * dnd5e.preDisplayCard dispatch — cancels dnd5e's bare card, runs the
 * module's own flow. `messageConfig.data` is already dnd5e's fully-rendered
 * card (icon + name + description, via item-card.hbs) plus its speaker and
 * `flags.dnd5e.item` — captured here and reused as-is so the eventual
 * announcement looks exactly like a normal dnd5e item-use card instead of a
 * hand-rolled one-line flavor message.
 */
export function onPreDisplayActionSurgeCard(item, messageConfig) {
  if (!isActionSurgeItem(item)) return true;
  handleActionSurgeUse(item, messageConfig?.data).catch((err) => console.error("combat-spell-timer | action surge failed", err));
  return false;
}

/** Prompt USE/CHAT, consume on USE (if uses remain), then post the announcement card either way. */
async function handleActionSurgeUse(item, cardData) {
  const actor = item.actor;
  if (!actor) return;
  const { remaining } = usesOf(item);
  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.ActionSurge.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.ActionSurge.Prompt", { remaining }),
    icon: "fa-solid fa-bolt",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0.
    if (remaining <= 0) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.ActionSurge.NoUses", { name: item.name }));
      return;
    }
    await item.update({ "system.uses.spent": item.system.uses.spent + 1 });
    dbg("dnd5e:action-surge:consumed", actor.name, remaining - 1);
  }
  await postActionSurgeCard(item, actor, cardData);
}

/** Post the announcement card. Nothing deferred — no roll or effect to apply. */
async function postActionSurgeCard(item, actor, cardData) {
  const message = await ChatMessage.create(cardData);
  dbg("dnd5e:action-surge:posted", actor.name, message?.id);
}

/** Register Action Surge's use-flow hook. Call once during setup. */
export function registerActionSurgeHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayActionSurgeCard(item, messageConfig));
}
