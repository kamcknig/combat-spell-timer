import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Commander's Strike": the imported
 * "Maneuver: Commander's Strike" feat is a bare description item (no
 * activities) — same shape as Second Wind, so it follows the same
 * dnd5e.preDisplayCard interception pattern. Unlike Second Wind, the resource
 * it spends is NOT its own uses — it's a die from the actor's separate
 * "Combat Superiority" feat, which carries the shared superiority-dice pool
 * (system.uses) stamped at import time (see import/builders.mjs). The
 * resulting chat card carries a superiority-die roll button that ANY player
 * may click (Commander's Strike directs an ally, not necessarily the owner).
 */

const CS_FLAG = "commandersStrike"; // flags[MODULE_ID][CS_FLAG] = { actorUuid, dieSize }
const BTN_CLASS = "cst-commanders-strike-roll";
const ATTACK_BTN_CLASS = "cst-commanders-strike";

/** DDB stores "Commander’s Strike" with a curly apostrophe — normalize before matching. */
const norm = (s) => String(s ?? "").replace(/’/g, "'").toLowerCase();

export const isCommandersStrikeItem = (i) =>
  i?.type === "feat" && norm(i.name) === "maneuver: commander's strike";

/** The actor's Combat Superiority feat (the shared superiority-dice pool). */
export const findCombatSuperiority = (actor) =>
  findFeat(actor, "combat superiority", "combat-superiority");

/** dnd5e.preDisplayCard: intercept the maneuver's bare card, run our flow instead. */
export function onPreDisplayCommandersStrikeCard(item, messageConfig) {
  if (!isCommandersStrikeItem(item)) return true;
  handleCommandersStrikeUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | commander's strike failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleCommandersStrikeUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.CommandersStrike.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-people-arrows",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  if (action === "use") {
    // Defensive: USE is disabled in the dialog whenever remaining <= 0, so this
    // shouldn't be reachable through normal interaction — kept as a guard.
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    dbg("dnd5e:commanders-strike:consumed", actor.name, remaining - 1);
  }
  await postCommandersStrikeCard(actor, dieSize, cardData);
}

/** Post the announcement card carrying the deferred superiority-die roll button. */
async function postCommandersStrikeCard(actor, dieSize, cardData) {
  // cardData is dnd5e's fully-rendered item card (from preDisplayCard). Both
  // entry points (item click, Phase 3's attack-dialog button) reach here via
  // the maneuver item's own card, so cardData is always present.
  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [CS_FLAG]: { actorUuid: actor.uuid, dieSize } },
    }),
  });
  dbg("dnd5e:commanders-strike:posted", actor.name, message?.id);
}

/** Roll one superiority die and post it. Speaker is the maneuver's actor. */
async function onRollDie(actor, dieSize) {
  const roll = await new Roll(`1${dieSize}`).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.RollFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  dbg("dnd5e:commanders-strike:rolled", actor?.name, roll.total);
}

/**
 * dnd5e.renderChatMessage: append the "Roll Superiority Die" button.
 * DELIBERATELY NOT owner-gated — Commander's Strike directs an ALLY, so any
 * player may press it. Disabled locally after a click (no message.update, so
 * no write-permission issue); repeat rolls are possible by design (see
 * plan's "What We're NOT Doing"). Also disabled up front if the actor has no
 * Combat Superiority uses remaining (e.g. the die was spent by other means
 * since the card was posted).
 */
function onRenderCommandersStrikeMessage(message, html) {
  const data = message.getFlag(MODULE_ID, CS_FLAG);
  if (!data) return;
  const actor = fromUuidSync(data.actorUuid);
  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${BTN_CLASS}`)) return;

  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);

  const wrap = document.createElement("div");
  wrap.className = "cst-commanders-strike-controls";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.RollButton")}`;
  if (remaining <= 0) {
    btn.disabled = true;
    btn.title = game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.NoDice");
  }
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRollDie(actor, data.dieSize);
    } catch (err) {
      warn("commander's strike roll failed", err);
      btn.disabled = false;
    }
  });
  wrap.appendChild(btn);
  container.appendChild(wrap);
  dbg("dnd5e:commanders-strike:button", actor?.name, { remaining });
}

/**
 * renderAttackRollConfigurationDialog (dnd5e 5.3.3, ApplicationV2): inject a
 * COMMANDER'S STRIKE button below the roll buttons when the rolling actor owns
 * the maneuver and has a superiority die. Clicking closes the attack dialog and
 * fires the maneuver's own use flow (converges on preDisplayCard).
 */
function onRenderAttackDialog(app, element) {
  if (element.querySelector(`.${ATTACK_BTN_CLASS}`)) return; // dialog re-renders on form change

  const activity = app.config?.subject;          // AttackActivity
  const actor = activity?.actor;
  if (!actor) return;

  const maneuver = actor.items.find(isCommandersStrikeItem);
  if (!maneuver) return;
  const pool = findCombatSuperiority(actor);
  if ((pool?.system?.uses?.value ?? 0) <= 0) return; // no die available

  const nav = element.querySelector(".dialog-buttons");
  if (!nav) return;

  const btn = document.createElement("button");
  btn.type = "button";                            // never submit
  btn.className = ATTACK_BTN_CLASS;
  btn.style.flexBasis = "100%";                   // wrap onto its own row below the flexrow
  btn.innerHTML = `<i class="fa-solid fa-people-arrows"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.CommandersStrike.AttackButton")}`;
  btn.addEventListener("click", () => {
    app.close();                                  // forgo this attack roll
    maneuver.use();                               // → dnd5e.preDisplayCard → our flow
  });
  nav.insertAdjacentElement("afterend", btn);
  dbg("dnd5e:commanders-strike:attack-button", actor.name);
}

/** Register Commander's Strike hooks. Call once during setup. */
export function registerCommandersStrikeHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayCommandersStrikeCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderCommandersStrikeMessage);
  Hooks.on("renderAttackRollConfigurationDialog", onRenderAttackDialog);
}
