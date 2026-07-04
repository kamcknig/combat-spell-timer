import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { SAP_FLAG, SAP_STATUS_ID } from "./features/sap.mjs";
import { SLOW_FLAG, SLOW_STATUS_ID } from "./features/slow.mjs";
import { ensureEffectTemplate, injectEffectApplicationTray } from "./effect-application-tray.mjs";

/**
 * dnd5e Fighter "Weapon Mastery" (2024 PHB) — Cleave, Graze, and Topple.
 * (Sap and Slow live in features/sap.mjs and features/slow.mjs — they need
 * the module's timer/feature-registry machinery; Nick/Push/Vex are cosmetic,
 * no code.)
 *
 * Eligibility for every mastery property is a single check:
 * item.system.masteryOptions (dnd5e.mjs:76839-76853) already encodes "the
 * actor's chosen mastery weapon types (system.traits.weaponProf.mastery
 * .value, populated at import — see import/weapon-mastery.mjs) cover this
 * weapon's base item, AND the weapon has a mastery property at all" — we
 * only add the equipped check the getter omits. Because eligibility keys off
 * the weapon's own intrinsic system.mastery field, no separate melee/ranged
 * classification check is needed per property: only weapons whose printed
 * mastery is genuinely "cleave" will ever match the cleave button, etc.
 */

const BTN_CLASS_PREFIX = "cst-weapon-mastery";

/** True when `item` is equipped and the actor's chosen mastery types unlock `key` for it. */
function hasMastery(actor, item, key) {
  if (!item?.system?.equipped) return false;
  return (item.system.masteryOptions ?? []).some(o => o.value === key);
}

/** True when the current user may act on this message's actor (owner or GM). */
function canAct(actor) {
  return !!game.user?.isGM || (actor?.isOwner ?? false);
}

/** The resolved ability modifier for an attack activity's actor, or 0. */
function attackAbilityMod(activity) {
  const key = activity?.ability;
  return key ? (activity.actor?.system?.abilities?.[key]?.mod ?? 0) : 0;
}

// ── Cleave ───────────────────────────────────────────────────────────────

const CLEAVE_BTN_CLASS = `${BTN_CLASS_PREFIX}-cleave`;
/** Message flag marking a usage card as the Cleave follow-up attack, so players can tell it apart from the original attack. */
const CLEAVE_CARD_FLAG = "cleaveFollowUp";
/** Activity uuids with a pending no-ability-mod Cleave damage roll, consumed by the next damage roll from that activity. */
const pendingCleaveDamage = new Set();

/**
 * Re-use the weapon's activity for the extra Cleave attack, then flag the
 * resulting usage card so onRenderCleaveUsageCard can mark it as a Cleave
 * follow-up (a plain re-use would otherwise look identical to the original
 * attack, with nothing telling players it's the free extra swing).
 */
async function onCleaveAttackClick(activity) {
  pendingCleaveDamage.add(activity.uuid);
  try {
    const results = await activity.use();
    const message = results?.message;
    if (message) await message.setFlag(MODULE_ID, CLEAVE_CARD_FLAG, true);
  } catch (err) {
    pendingCleaveDamage.delete(activity.uuid);
    throw err;
  }
}

/**
 * dnd5e.renderChatMessage handler: give a Cleave follow-up's usage card an
 * expandable "Cleave" info row, in the same visual language as the card's
 * own native description toggle (same `.card-header.description.collapsible`
 * / `.collapsible-content.card-content` classes — dnd5e's chat-log click
 * delegation, Item5e.chatListeners (dnd5e.mjs:23752-23757), toggles any
 * `.collapsible` it finds, so this needs no click handler of its own; the
 * `.dnd5e2` ancestor already on the message supplies the collapsed/expanded
 * CSS). Inserted right after the weapon's own description row so it reads as
 * a second, additional info toggle rather than a duplicate of the first.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderCleaveUsageCard(message, html) {
  if (!message.getFlag(MODULE_ID, CLEAVE_CARD_FLAG)) return;
  const card = html.querySelector(".chat-card");
  if (!card || card.querySelector(`.${BTN_CLASS_PREFIX}-cleave-info`)) return;

  const section = document.createElement("section");
  section.className = `card-header description collapsible collapsed ${BTN_CLASS_PREFIX}-cleave-info`;
  section.innerHTML = `
    <header class="summary">
      <div class="name-stacked border">
        <span class="title">${game.i18n.localize("DND5E.WEAPON.Mastery.Cleave")}</span>
      </div>
      <i class="fa-solid fa-chevron-down fa-fw" inert></i>
    </header>
    <section class="details collapsible-content card-content">
      <div class="wrapper"><p>${game.i18n.localize("COMBAT_SPELL_TIMER.WeaponMastery.CleaveDescription")}</p></div>
    </section>
  `;

  const nativeDescription = card.querySelector(".card-header.description.collapsible");
  if (nativeDescription) nativeDescription.after(section);
  else card.prepend(section);
  dbg("dnd5e:weapon-mastery:cleave-card-info", message.id);
}

/**
 * dnd5e.preRollDamageV2 dispatch: if this activity has a pending Cleave
 * follow-up, drop the "@mod" term dnd5e pushes onto roll.parts
 * (dnd5e.mjs:28345) unless the modifier is negative (still applied then,
 * per RAW "unless that modifier is negative"). One-shot: consumed
 * immediately so a later, unrelated damage roll from the same weapon is
 * unaffected.
 * @param {object} config  The pending damage roll process config.
 */
export function onWeaponMasteryPreRollDamage(config) {
  const activity = config?.subject;
  if (!activity || !pendingCleaveDamage.has(activity.uuid)) return;
  pendingCleaveDamage.delete(activity.uuid);
  const roll = config.rolls?.[0];
  if (!roll) return;
  const mod = Number(roll.data?.mod ?? 0);
  if (mod >= 0) {
    roll.parts = (roll.parts ?? []).filter(p => !(typeof p === "string" && p.includes("@mod")));
    dbg("dnd5e:weapon-mastery:cleave-strip-mod", activity.item?.name, mod);
  }
}

// ── Graze ────────────────────────────────────────────────────────────────

const GRAZE_BTN_CLASS = `${BTN_CLASS_PREFIX}-graze`;

/** The weapon's own damage type (first entry of its base damage's type set), or null. */
function weaponDamageType(item) {
  return item?.system?.damage?.base?.types?.first?.() ?? null;
}

async function onGrazeDamageClick(activity, item, actor) {
  const mod = attackAbilityMod(activity);
  const type = weaponDamageType(item);
  const roll = new CONFIG.Dice.DamageRoll(String(mod), actor.getRollData(), { type });
  await roll.evaluate();
  await CONFIG.Dice.DamageRoll.toMessage([roll], {
    flavor: `${item.name} - ${game.i18n.localize("COMBAT_SPELL_TIMER.WeaponMastery.GrazeFlavor")}`,
    speaker: ChatMessage.getSpeaker({ actor }),
    flags: { dnd5e: { messageType: "roll", roll: { type: "damage" } } },
  });
  dbg("dnd5e:weapon-mastery:graze", actor.name, item.name, mod, type);
}

// ── Topple ───────────────────────────────────────────────────────────────

const TOPPLE_BTN_CLASS = `${BTN_CLASS_PREFIX}-topple`;

/**
 * The creature Topple should target: the first currently-targeted token
 * (live game.user.targets, not a message flags.dnd5e.targets snapshot —
 * Topple's button lives on the weapon's pre-roll usage card, created via
 * activity.use() before the player necessarily has a target set, so a
 * card-creation-time snapshot is frequently stale/empty), falling back to
 * the first controlled/selected token if nothing is targeted. Single
 * target, matching Topple's RAW wording ("a creature"), not every target.
 */
function resolveToppleTarget() {
  const targeted = Array.from(game.user?.targets ?? [])[0];
  if (targeted?.actor) return targeted.actor;
  const controlled = canvas.tokens?.controlled?.[0];
  return controlled?.actor ?? null;
}

/**
 * DC 8 + the ability modifier used for the attack + the attacker's
 * Proficiency Bonus (full 2024 PHB Topple text — not just "DC 8 + mod").
 */
function toppleDc(activity, actor) {
  const mod = attackAbilityMod(activity);
  const prof = actor?.system?.attributes?.prof ?? 0;
  return 8 + mod + prof;
}

async function onToppleSaveClick(activity, actor) {
  const target = resolveToppleTarget();
  if (!target) {
    ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.WeaponMastery.ToppleNoTarget"));
    return;
  }
  const dc = toppleDc(activity, actor);
  const rolls = await target.rollSavingThrow({ ability: "con", target: dc }, {}, {});
  const failed = rolls?.[0] && rolls[0].isSuccess === false;
  dbg("dnd5e:weapon-mastery:topple-save", target.name, dc, failed ? "failed" : "saved");
  if (failed) await target.toggleStatusEffect("prone", { active: true });
}

// ── Sap: native "Apply Effects" tray ────────────────────────────────────

function ensureSapEffectTemplate(item, actor) {
  return ensureEffectTemplate(item, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.WeaponMastery.SapEffectName"),
    statusId: SAP_STATUS_ID, flagKey: SAP_FLAG,
  });
}

/**
 * Slow's template mirrors Sap's exactly, but carries a real mechanical
 * change instead of relying on a roll-time hook: an ADD -10 to
 * system.attributes.movement.bonus, self-clamped to a floor of 0 by dnd5e's
 * own prepareMovement() pass (see the doc comment in features/slow.mjs).
 */
function ensureSlowEffectTemplate(item, actor) {
  return ensureEffectTemplate(item, actor, {
    name: game.i18n.localize("COMBAT_SPELL_TIMER.WeaponMastery.SlowEffectName"),
    statusId: SLOW_STATUS_ID, flagKey: SLOW_FLAG,
    changes: [
      { key: "system.attributes.movement.bonus", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "-10", priority: 20 },
    ],
  });
}

/**
 * dnd5e.renderChatMessage handler: offer Sap's / Slow's apply-effects tray on
 * an eligible weapon's damage-roll message. Unlike Cleave/Graze/Topple (which
 * moved to pre-roll placement during manual testing — see their own
 * comments above), Sap/Slow stay on the damage-roll message: their trays
 * genuinely depend on knowing the attack hit (the GM chooses whether/whom to
 * apply it to), which only the damage roll confirms. A weapon has only one
 * `system.mastery` value, so only one of the two branches below ever fires
 * for a given message in practice.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
async function onRenderDamageMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "damage") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (!canAct(actor)) return;

  if (hasMastery(actor, item, "sap")) {
    const effectDoc = await ensureSapEffectTemplate(item, actor);
    injectEffectApplicationTray(html, effectDoc);
    dbg("dnd5e:weapon-mastery:sap-tray", actor.name, item.name);
  }
  if (hasMastery(actor, item, "slow")) {
    const effectDoc = await ensureSlowEffectTemplate(item, actor);
    injectEffectApplicationTray(html, effectDoc);
    dbg("dnd5e:weapon-mastery:slow-tray", actor.name, item.name);
  }
}

// ── Button injection (attack-roll message: Cleave + Graze + Topple) ────────

function buildButton(cls, iconClass, labelKey, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls;
  btn.innerHTML = `<i class="fa-solid ${iconClass}"></i> ${game.i18n.localize(labelKey)}`;
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    btn.disabled = true;
    try {
      await onClick();
    } catch (err) {
      warn("weapon mastery action failed", err);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * dnd5e.renderChatMessage handler: append a CLEAVE ATTACK button to an
 * eligible attack-roll message (post-roll, since the extra attack only makes
 * sense once the original is known to hit). Fires AFTER dnd5e's own card
 * decoration (see CLAUDE.md's renderChatMessageHTML vs dnd5e.renderChatMessage
 * note) so .message-content already has the rendered card to append after.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderAttackMessage(message, html) {
  if (message.flags?.dnd5e?.roll?.type !== "attack") return;
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (!canAct(actor)) return;
  if (!hasMastery(actor, item, "cleave")) return;

  const container = html.querySelector(".message-content");
  if (!container || container.querySelector(`.${CLEAVE_BTN_CLASS}`)) return;

  const wrap = document.createElement("div");
  wrap.className = `${BTN_CLASS_PREFIX}-controls`;
  wrap.appendChild(buildButton(CLEAVE_BTN_CLASS, "fa-people-arrows",
    "COMBAT_SPELL_TIMER.WeaponMastery.CleaveButton", () => onCleaveAttackClick(activity)));

  const damageApplication = container.querySelector("damage-application");
  if (damageApplication) container.insertBefore(wrap, damageApplication);
  else container.appendChild(wrap);
  dbg("dnd5e:weapon-mastery:cleave-button", actor.name, item.name);
}

/**
 * dnd5e.renderChatMessage handler: append GRAZE DAMAGE / TOPPLE SAVE buttons
 * directly into an eligible weapon's own usage card — the ATTACK/DAMAGE
 * button card posted BEFORE any roll happens (Activity#use()'s
 * _createUsageMessage, template chat/activity-card.hbs) — inserted into
 * dnd5e's own .card-buttons (a flex column shared by the native buttons) so
 * they inherit identical styling with no wrapper/custom CSS, same placement
 * Unarmed Fighting's Grapple Damage button uses on the Unarmed Strike
 * activity's own card. Both work pre-roll because neither depends on roll
 * data: targets come from Activity#messageFlags (spread into this card's
 * flags.dnd5e.targets at use() time, dnd5e.mjs:16844-16855 — snapshots
 * game.user.targets the moment the weapon is used) and activity.ability
 * needs no roll data either.
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderUsageCard(message, html) {
  const activity = message.getAssociatedActivity?.();
  const actor = message.getAssociatedActor?.();
  const item = message.getAssociatedItem?.();
  if (!activity || !actor || !item) return;
  if (!canAct(actor)) return;

  const container = html.querySelector(".card-buttons");
  if (!container) return;

  if (hasMastery(actor, item, "graze") && !container.querySelector(`.${GRAZE_BTN_CLASS}`)) {
    container.appendChild(buildButton(GRAZE_BTN_CLASS, "fa-hand-sparkles",
      "COMBAT_SPELL_TIMER.WeaponMastery.GrazeButton", () => onGrazeDamageClick(activity, item, actor)));
    dbg("dnd5e:weapon-mastery:graze-button", actor.name, item.name);
  }
  if (hasMastery(actor, item, "topple") && !container.querySelector(`.${TOPPLE_BTN_CLASS}`)) {
    container.appendChild(buildButton(TOPPLE_BTN_CLASS, "fa-person-falling",
      "COMBAT_SPELL_TIMER.WeaponMastery.ToppleButton", () => onToppleSaveClick(activity, actor)));
    dbg("dnd5e:weapon-mastery:topple-button", actor.name, item.name);
  }
}

export { hasMastery, canAct, attackAbilityMod, weaponDamageType, onRenderAttackMessage };

/**
 * Register Cleave's attack-roll button, Graze/Topple's usage-card buttons,
 * Sap's apply-effects tray on the damage-roll message, and Cleave's
 * damage-time mod strip. Call once during setup.
 */
export function registerWeaponMasteryHooks() {
  Hooks.on("dnd5e.renderChatMessage", onRenderAttackMessage);
  Hooks.on("dnd5e.renderChatMessage", onRenderCleaveUsageCard);
  Hooks.on("dnd5e.renderChatMessage", onRenderUsageCard);
  Hooks.on("dnd5e.renderChatMessage", onRenderDamageMessage);
  Hooks.on("dnd5e.preRollDamageV2", onWeaponMasteryPreRollDamage);
}
