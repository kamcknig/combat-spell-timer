import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { findFeat } from "./features/shared.mjs";
import { usesOf } from "./second-wind.mjs";

/**
 * dnd5e Fighter "Indomitable" (2014): once you fail a saving throw, you can
 * reroll it and must use the new result; usable 1/2/3 times per long rest
 * (level 9/13/17). Unlike Second Wind/Action Surge/Tactical Mind, this
 * feature isn't triggered by using the item itself — there's an
 * INDOMITABLE button appended directly to the FAILED saving-throw's own
 * chat message (dnd5e.renderChatMessage, same hook/timing already proven
 * for Great Weapon Fighting's damage-reroll button — see
 * great-weapon-fighting.mjs). Clicking it opens the same FeatureUseDialog
 * USE/CHAT primitive; USE consumes an Indomitable charge and immediately
 * rerolls just the d20 mechanic on a CLONE of the original roll (every
 * other term — ability mod, proficiency, situational bonuses — untouched),
 * then posts the new roll as its own save-roll chat message so dnd5e's own
 * pass/fail highlighting applies automatically (carries `options.target`
 * over from the clone). CHAT posts a narrative-only announcement — no
 * reroll, no consumption (CLAUDE.md's "Feature activation dialogs"
 * convention).
 */

const INDOMITABLE_FLAG = "indomitableApplied";
const BTN_CLASS = "cst-indomitable-reroll";

/** The actor's Indomitable feat item, or null. */
function indomitableFeat(actor) {
  return findFeat(actor, "indomitable", "indomitable");
}

/** True when the current user may act on this message's actor (owner or GM). */
function canReroll(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/**
 * Reroll the d20 mechanic of a save-roll clone from scratch: construct a
 * fresh Die with the SAME shape (number/faces/modifiers/options — e.g.
 * "kh1" for advantage, "r1=1" for Halfling Lucky) as the original term and
 * evaluate it fresh, splicing it in place of the stale term. A plain
 * Die#reroll() on the existing term only rerolls the currently-active
 * result and leaves a discarded advantage/disadvantage die frozen from the
 * original roll — this instead redoes the whole d20 mechanic (including
 * advantage/disadvantage keep-highest/lowest), which is what "the same
 * bonuses" requires. Every other term in the roll is left untouched.
 */
async function rerollD20(clone) {
  const original = clone.terms[0];
  const { Die } = foundry.dice.terms;
  const fresh = new Die({
    number: original.number,
    faces: original.faces,
    modifiers: [...(original.modifiers ?? [])],
    options: { ...original.options },
  });
  await fresh.evaluate();
  clone.terms[0] = fresh;
  clone._total = clone._evaluateTotal();
  return clone;
}

/** Independent clone of a roll (round-tripped through JSON), so the original message's live Roll instance is never mutated. */
function cloneRoll(roll) {
  return Roll.fromData(roll.toJSON());
}

/** Reroll the d20 on a clone of the original roll and post it as a new save-roll message. */
async function postRerollMessage(message, actor, roll, ability) {
  const clone = await rerollD20(cloneRoll(roll));
  const abilityLabel = CONFIG.DND5E.abilities[ability]?.label ?? ability ?? "";
  const flavor = `${abilityLabel} ${game.i18n.localize("COMBAT_SPELL_TIMER.Indomitable.RerollFlavor")}`.trim();
  await CONFIG.Dice.D20Roll.toMessage([clone], {
    flavor,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: {
      dnd5e: { messageType: "roll", roll: { ability, type: "save" }, originatingMessage: message.id },
      [MODULE_ID]: { [INDOMITABLE_FLAG]: true },
    },
  });
  await message.update({ flags: { [MODULE_ID]: { [INDOMITABLE_FLAG]: true } } });
  dbg("dnd5e:indomitable:rerolled", actor.name, clone.total);
}

/** Post a narrative-only announcement — no reroll, no consumption. */
async function postAnnounceMessage(actor) {
  const content = `<p>${game.i18n.format("COMBAT_SPELL_TIMER.Indomitable.ChatFlavor", { name: actor.name })}</p>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
  dbg("dnd5e:indomitable:announced", actor.name);
}

/**
 * Prompt USE/CHAT. Returns true once a decision was made (USE or CHAT —
 * button should be removed), false when dismissed or blocked (button
 * should stay clickable).
 */
async function handleIndomitableUse(message, actor, item, roll, ability) {
  const { remaining } = usesOf(item);
  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Indomitable.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.Indomitable.Prompt", { remaining }),
    icon: "fa-solid fa-shield-halved",
    canUse: remaining > 0,
  });
  if (!action) return false; // dismissed
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0.
    if (remaining <= 0) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.Indomitable.NoUses", { name: item.name }));
      return false;
    }
    await item.update({ "system.uses.spent": item.system.uses.spent + 1 });
    dbg("dnd5e:indomitable:consumed", actor.name, remaining - 1);
    await postRerollMessage(message, actor, roll, ability);
  } else {
    await postAnnounceMessage(actor);
  }
  return true;
}

/**
 * dnd5e.renderChatMessage handler: append the INDOMITABLE button to any
 * eligible saving-throw message. Fires AFTER dnd5e's own card enrichment
 * (see great-weapon-fighting.mjs's identical hook choice). Excludes death
 * saves (flags.dnd5e.roll.type === "death") — see the plan's "What We're
 * NOT Doing". NOT gated on roll.isFailure — that signal reads `false`
 * whenever no DC was recorded on the roll (common in practice, e.g. a save
 * made with nothing properly targeted/selected), so it's unreliable as a
 * gate. The button is always enabled on an eligible save; the player/GM
 * decides whether the save actually failed and whether to use it.
 */
function onRenderSaveMessage(message, html) {
  if (message.getFlag(MODULE_ID, INDOMITABLE_FLAG)) return;
  if (message.flags?.dnd5e?.roll?.type !== "save") return;

  const actor = message.getAssociatedActor?.();
  if (!actor) return;
  const item = indomitableFeat(actor);
  if (!item) return;
  if (!canReroll(actor)) return;

  const roll = message.rolls?.[0];
  if (!roll) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const ability = message.getFlag("dnd5e", "roll")?.ability;
  const { remaining } = usesOf(item);
  const wrap = document.createElement("div");
  wrap.className = "cst-indomitable-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.Indomitable.Button")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.format("COMBAT_SPELL_TIMER.Indomitable.NoUses", { name: item.name });
  }
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      const resolved = await handleIndomitableUse(message, actor, item, roll, ability);
      if (resolved) wrap.remove();
      else btn.disabled = false;
    } catch (err) {
      warn("indomitable reroll failed", err);
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  container.appendChild(wrap);
  dbg("dnd5e:indomitable:button", actor.name);
}

/** Register Indomitable's reroll-button hook. Call once during setup. */
export function registerIndomitableHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderSaveMessage);
}
