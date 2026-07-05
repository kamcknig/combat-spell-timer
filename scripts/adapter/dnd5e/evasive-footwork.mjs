import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { FeatureUseDialog } from "../../apps/feature-use-dialog.mjs";
import { usesOf } from "./second-wind.mjs";
import { findFeat } from "./features/shared.mjs";
import { findCombatSuperiority } from "./commanders-strike.mjs";
import { ensureEffectTemplate, injectEffectApplicationTray } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Evasive Footwork": "When you move,
 * you can expend one superiority die, rolling the die and adding the number
 * rolled to your AC until you stop moving." Same bare-feat-item activation
 * shape as Commander's Strike (commanders-strike.mjs) — a plain description
 * item, intercepted via dnd5e.preDisplayCard — but unlike Commander's
 * Strike, the die roll here IS the mechanical effect (an AC bonus applied
 * through dnd5e's native apply-effects tray), not flavor text. So the roll
 * button only appears when the card actually spent a die (USE), matching
 * Disarming Attack / Distracting Strike's stricter action-gating rather than
 * Commander's Strike's "always show a roll button" shape — there's no
 * free, no-cost version of a real AC bonus.
 *
 * The applied AC-bonus effect is intentionally NOT tracked by this module's
 * combat-tracker timer system: 2014 Evasive Footwork lasts only "until you
 * stop moving," which this module has no way to detect, so the bonus runs
 * with no duration limit and no auto-removal — the player/GM deletes it
 * manually. That also means, unlike Sap/Slow/Distracting Strike, there's no
 * features/ registry entry for this maneuver at all.
 */

const EF_FLAG = "evasiveFootwork"; // message flags[MODULE_ID][EF_FLAG] = {actorUuid, dieSize, consumed, rolled, total?}
const EF_STATUS_ID = "cst-evasive-footwork";
const CONTROLS_CLASS = "cst-evasive-footwork-controls";
const BTN_CLASS = "cst-evasive-footwork-roll";

export const isEvasiveFootworkItem = (i) => i?.type === "feat" && i?.name?.toLowerCase() === "maneuver: evasive footwork";

/** The actor's "Maneuver: Evasive Footwork" feat, or null. */
function findEvasiveFootworkManeuver(actor) {
  return findFeat(actor, "maneuver: evasive footwork", "maneuver-evasive-footwork");
}

/** True when the current user may act on this message's actor (owner or GM). */
function canAct(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** dnd5e.preDisplayCard: intercept the maneuver's bare card, run our flow instead. */
export function onPreDisplayEvasiveFootworkCard(item, messageConfig) {
  if (!isEvasiveFootworkItem(item)) return true;
  handleEvasiveFootworkUse(item, messageConfig?.data)
    .catch((err) => console.error("combat-spell-timer | evasive footwork failed", err));
  return false;
}

/** Prompt USE/CHAT, consume one Combat Superiority die on USE, post the card either way. */
async function handleEvasiveFootworkUse(maneuverItem, cardData) {
  const actor = maneuverItem.actor;
  if (!actor) return;
  const pool = findCombatSuperiority(actor);
  const { remaining } = usesOf(pool);
  const dieSize = pool?.getFlag(MODULE_ID, "superiorityDie") ?? "d8";

  const action = await FeatureUseDialog.prompt({
    title: game.i18n.localize("COMBAT_SPELL_TIMER.EvasiveFootwork.Title"),
    message: game.i18n.format("COMBAT_SPELL_TIMER.EvasiveFootwork.Prompt", { remaining, die: dieSize }),
    icon: "fa-solid fa-person-running",
    canUse: remaining > 0,
  });
  if (!action) return; // dismissed
  let consumed = false;
  if (action === "use") {
    if (!pool || remaining <= 0) {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.EvasiveFootwork.NoDice"));
      return;
    }
    await pool.update({ "system.uses.spent": pool.system.uses.spent + 1 });
    consumed = true;
    dbg("dnd5e:evasive-footwork:consumed", actor.name, remaining - 1);
  }

  const message = await ChatMessage.create({
    ...cardData,
    flags: foundry.utils.mergeObject(cardData?.flags ?? {}, {
      [MODULE_ID]: { [EF_FLAG]: { actorUuid: actor.uuid, dieSize, consumed, rolled: false } },
    }),
  });
  dbg("dnd5e:evasive-footwork:announced", actor.name, message?.id, consumed);
}

/**
 * (Re-)stamp the maneuver item's persisted effect template with `total`'s AC
 * bonus and offer it via the native apply-effects tray. Called on every
 * render of a rolled card, not just the first roll, so the template always
 * reflects THIS message's own roll — see effect-application-tray.mjs's
 * ensureEffectTemplate doc comment on why `changes` refreshes on reuse.
 */
async function showEvasiveFootworkTray(html, maneuver, actor, total) {
  const effectDoc = await ensureEffectTemplate(maneuver, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.EvasiveFootwork.EffectName"),
    statusId: EF_STATUS_ID,
    flagKey: EF_FLAG,
    changes: [
      { key: "system.attributes.ac.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: `+${total}`, priority: 20 },
    ],
    duration: {}, // unlimited — no auto-expiry; the player/GM removes it manually once they stop moving
  });
  injectEffectApplicationTray(html, effectDoc);
}

/** Replace the controls row's contents with the resolved roll's readout. */
function renderRolledState(container, data) {
  const wrap = container.querySelector(`.${CONTROLS_CLASS}`);
  if (!wrap) return;
  wrap.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.format("COMBAT_SPELL_TIMER.EvasiveFootwork.RolledLabel", { total: data.total })}`;
}

/** Roll the superiority die, persist the result onto the message, and reveal the apply-effects tray. */
async function onRollClick(message, html, container, actor, maneuver, data) {
  const roll = await new Roll(`1${data.dieSize}`).evaluate();
  await roll.toMessage({
    flavor: game.i18n.localize("COMBAT_SPELL_TIMER.EvasiveFootwork.RollFlavor"),
    speaker: ChatMessage.getSpeaker({ actor }),
  });
  const next = { ...data, rolled: true, total: roll.total };
  await message.setFlag(MODULE_ID, EF_FLAG, next);
  renderRolledState(container, next);
  await showEvasiveFootworkTray(html, maneuver, actor, roll.total);
  dbg("dnd5e:evasive-footwork:rolled", actor.name, roll.total);
}

/** Build the "ROLL SUPERIORITY DIE" icon button. */
function buildRollButton(message, html, container, actor, maneuver, data) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("COMBAT_SPELL_TIMER.EvasiveFootwork.RollButton")}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onRollClick(message, html, container, actor, maneuver, data);
    } catch (err) {
      warn("evasive footwork roll failed", err);
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage: on Evasive Footwork's own announcement card, show
 * the roll button (if the card spent a die and hasn't been rolled yet) or the
 * resolved roll + apply-effects tray (if it has already been rolled — e.g.
 * after a reload). A CHAT-only card (no die spent) gets neither.
 */
async function onRenderEvasiveFootworkMessage(message, html) {
  const data = message.getFlag(MODULE_ID, EF_FLAG);
  if (!data || !data.consumed) return;
  const actor = fromUuidSync(data.actorUuid);
  if (!actor || !canAct(actor)) return;
  const maneuver = findEvasiveFootworkManeuver(actor);
  if (!maneuver) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CONTROLS_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = CONTROLS_CLASS;
  // Insert above the card's property-tags row (.card-footer.pills, nested
  // inside .chat-card — e.g. "FIGHTER 3") rather than appending after the
  // whole card, matching the shared chat-card-button convention.
  const tags = container.querySelector(".card-footer.pills");
  if (tags) tags.parentElement.insertBefore(wrap, tags);
  else container.appendChild(wrap);

  if (data.rolled) {
    renderRolledState(container, data);
    await showEvasiveFootworkTray(html, maneuver, actor, data.total);
  } else {
    wrap.appendChild(buildRollButton(message, html, container, actor, maneuver, data));
  }
  dbg("dnd5e:evasive-footwork:card", actor.name, data.rolled);
}

/** Register Evasive Footwork's activation flow. Call once during setup. */
export function registerEvasiveFootworkHooks() {
  Hooks.on("dnd5e.preDisplayCard", (item, messageConfig) => onPreDisplayEvasiveFootworkCard(item, messageConfig));
  Hooks.on("dnd5e.renderChatMessage", onRenderEvasiveFootworkMessage);
}
