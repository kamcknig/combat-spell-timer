import { warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { findFeat } from "./features/shared.mjs";

/**
 * dnd5e "Fighting Style: Unarmed Fighting" (2024 PHB):
 *  - "When you hit with your Unarmed Strike and deal damage, you can deal
 *    Bludgeoning damage equal to 1d6 plus your Strength modifier instead of
 *    the normal damage of an Unarmed Strike. If you aren't holding any
 *    weapons or a Shield when you make the attack roll, the d6 becomes a
 *    d8."
 *  - "At the start of each of your turns, you can deal 1d4 Bludgeoning
 *    damage to one creature Grappled by you."
 * The first half REPLACES (not adds to) the Unarmed Strike's base damage
 * formula at roll time — unlike Dueling/Thrown Weapon Fighting's flat `+N`,
 * this overwrites roll.parts[0] (the item's own base formula) while
 * preserving anything dnd5e appends after it (this module's own Rage bonus,
 * system.bonuses.mwak.damage — see rage.mjs — and any magic weapon
 * damageBonus), since those are actor/item-wide bonuses that still stack on
 * top per RAW, not part of "the normal damage of an Unarmed Strike" being
 * replaced. Eligibility uses dnd5e's own
 * activity.attack.type.classification === "unarmed" flag, the same one
 * dnd5e itself uses to label an Unarmed Strike attack, rather than
 * name-matching the item.
 * The second half (Grapple Damage) has no roll-time trigger to hook — per
 * explicit scope, start-of-turn timing is not implemented. Instead it's a
 * button that rolls a fixed 1d4 Bludgeoning damage message on demand,
 * appended to two chat cards: the feat's own card (posted via
 * Item5e#displayCard() when the item is clicked, since the feat has no
 * activities) and the Unarmed Strike attack's own activation card (posted
 * by Activity#use(), template chat/activity-card.hbs — the ATTACK/DAMAGE
 * button card) — appended directly into dnd5e's own .card-buttons flex
 * column there so it inherits identical native button styling, below
 * DAMAGE, with no custom CSS needed.
 * See thoughts/shared/plans/2026-07-02-fighter-unarmed-fighting.md.
 */

const UF_NAME = "fighting style: unarmed fighting";
const UF_IDENTIFIER = "fighting-style-unarmed-fighting";
const GRAPPLE_BTN_CLASS = "cst-uf-grapple";

/** The actor's "Fighting Style: Unarmed Fighting" feat item, or null. */
function unarmedFightingFeat(actor) {
  return findFeat(actor, UF_NAME, UF_IDENTIFIER);
}

/**
 * True when the actor has no equipped weapons and no equipped shield — the
 * 2024 PHB's "d6 becomes a d8" upgrade condition. The Unarmed Strike item
 * itself (a "natural" weapon, never actually equipped) is excluded from the
 * weapon count; the equipped shield check reuses dnd5e's own Actor5e#shield
 * accessor rather than re-scanning equipment.
 */
function isEmptyHanded(actor) {
  const equippedWeapons = (actor?.itemTypes?.weapon ?? [])
    .filter((w) => w.system?.equipped && w.system?.type?.value !== "natural");
  if (equippedWeapons.length) return false;
  return !actor?.shield;
}

/**
 * dnd5e.preRollDamageV2 dispatch: replace the base damage part of an
 * Unarmed Strike attack with 1d6 (or 1d8 when empty-handed) plus the
 * actor's Strength modifier, Bludgeoning. Only roll.parts[0] (the item's
 * own base formula) is replaced; any later parts — actor/item-wide bonus
 * terms dnd5e appends for index 0 (this module's Rage bonus, magic weapon
 * bonus) — are preserved so they still stack. Forces @abilities.str.mod
 * specifically rather than relying on the roll's own @mod, since the feat
 * always uses Strength regardless of what ability the attack used.
 * Workflow-local hook — fires only on the rolling client, so no
 * cross-client gating is needed.
 * @param {object} config  The pending damage roll process config.
 */
export function onUnarmedFightingPreRollDamage(config) {
  const activity = config?.subject;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor || !item) return;
  if (activity?.attack?.type?.classification !== "unarmed") return;
  if (!unarmedFightingFeat(actor)) return;
  const roll = config.rolls?.[0];
  if (!roll) return;

  const die = isEmptyHanded(actor) ? "1d8" : "1d6";
  const bonusParts = (roll.parts ?? []).slice(1);
  dbg("dnd5e:unarmed-fighting:swap", actor.name, item.name, die, bonusParts);
  roll.parts = [die, "@abilities.str.mod", ...bonusParts];
  roll.options ??= {};
  roll.options.type = "bludgeoning";
  roll.options.types = ["bludgeoning"];
}

/** Roll and post a fixed 1d4 Bludgeoning "Grapple Damage" chat message, in the same card format as any other damage roll. */
async function onGrappleDamageClick(actor, item) {
  const roll = new CONFIG.Dice.DamageRoll("1d4", actor.getRollData(), { type: "bludgeoning" });
  await roll.evaluate();
  await CONFIG.Dice.DamageRoll.toMessage([roll], {
    flavor: `${item.name} - ${game.i18n.localize("COMBAT_SPELL_TIMER.UnarmedFighting.GrappleFlavor")}`,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { dnd5e: { messageType: "roll", roll: { type: "damage" } } },
  });
  dbg("dnd5e:unarmed-fighting:grapple", actor.name, item.name);
}

/** True when the current user may act on this message's actor (owner or GM). */
function canRoll(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/**
 * Build the "Grapple Damage" <button> element shared by both chat-card
 * injection sites (the feat's own card and the Unarmed Strike attack card).
 * Markup mirrors dnd5e's own native usage-card buttons
 * (`<i inert></i> <span>label</span>`) so it reads identically wherever
 * it's inserted, with no custom styling required.
 */
function buildGrappleButton(actor, feat) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = GRAPPLE_BTN_CLASS;
  btn.innerHTML = `<i class="fa-solid fa-hand-fist" inert></i> <span>${game.i18n.localize("COMBAT_SPELL_TIMER.UnarmedFighting.GrappleButton")}</span>`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onGrappleDamageClick(actor, feat);
    } catch (err) {
      warn("unarmed fighting grapple damage roll failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: append a "Grapple Damage" button to the
 * Unarmed Fighting feat's own chat card (Item5e#displayCard(), posted when
 * the item is clicked — the feat has no activities of its own, so this is
 * NOT a roll-type message and carries no flags.dnd5e.roll). Repeatable —
 * no per-message "already used" flag, unlike Great Weapon Fighting's
 * once-per-message reroll.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderItemCard(message, html) {
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!actor || !item) return;
  const feat = unarmedFightingFeat(actor);
  if (!feat || feat.id !== item.id) return;
  if (!canRoll(actor)) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${GRAPPLE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = "cst-uf-controls";
  wrap.appendChild(buildGrappleButton(actor, feat));
  container.appendChild(wrap);
  dbg("dnd5e:unarmed-fighting:button", actor.name, "item-card");
}

/**
 * dnd5e.renderChatMessage handler: append a "Grapple Damage" button below
 * the ATTACK/DAMAGE buttons on the Unarmed Strike activity's own activation
 * card. Inserted directly into dnd5e's own `.card-buttons` (a flex column
 * shared by the native buttons), so it inherits identical full-width/gap
 * styling with no wrapper or custom CSS. Same eligibility as the
 * damage-formula swap (activity classified "unarmed" + actor has the feat)
 * — repeatable, no per-message "already used" flag.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderAttackCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  if (!activity || !actor) return;
  if (activity.attack?.type?.classification !== "unarmed") return;
  const feat = unarmedFightingFeat(actor);
  if (!feat) return;
  if (!canRoll(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container || container.querySelector(`.${GRAPPLE_BTN_CLASS}`)) return;

  container.appendChild(buildGrappleButton(actor, feat));
  dbg("dnd5e:unarmed-fighting:button", actor.name, "attack-card");
}

/** Register the Unarmed Fighting damage swap + Grapple Damage buttons. Call once during setup. */
export function registerUnarmedFightingHooks() {
  Hooks.on("dnd5e.preRollDamageV2", onUnarmedFightingPreRollDamage);
  Hooks.on("dnd5e.renderChatMessage", onRenderItemCard);
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackCard);
}
