import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { FEATURE_SENTINEL_ROUNDS } from "./shared.mjs";

/**
 * Barbarian Path of Wild Magic — "Wild Surge" (level 3).
 * Entering a rage triggers a surge of untamed magic ("roll on the Wild Magic
 * table"). Foundry already owns the mechanics: the actor's own Wild Surge feat
 * item rolls the table and applies its effects when used. This module:
 *  - activates that item automatically on every fresh rage start,
 *  - creates a marker AE for table results that grant a lasting rider but
 *    apply no effect of their own (see SURGE_ACTIVITY_MARKERS), so the rider
 *    shows on the token and in the combat tracker,
 *  - and removes everything rage-bound again when the rage ends (see
 *    RAGE_BOUND_SURGE_EFFECTS + the marker flag).
 */

const isWildSurgeItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "wild surge" || i.system?.identifier?.toLowerCase() === "wild-surge");

/** The actor's Wild Surge feat item, or null. */
export function findWildSurgeItem(actor) {
  return actor?.items?.find(isWildSurgeItem) ?? null;
}

/**
 * Activate the actor's Wild Surge item exactly as using it from the sheet
 * would (dnd5e posts the card and rolls/applies its effects). No-op for
 * actors without the item. Returns the system's use result, or null.
 * @param {Actor} actor
 * @returns {Promise<object|null>}
 */
export async function triggerWildSurge(actor) {
  const item = findWildSurgeItem(actor);
  if (!item) return null;
  dbg("dnd5e:wild-surge", actor.name);
  return (await item.use()) ?? null;
}

/** Module flag marking an AE this module created for a Wild Surge rider. */
const SURGE_FLAG = "wildSurgeEffect";

/**
 * Wild Surge activities whose table result grants a rider that lasts "until
 * your rage ends" but applies NO ActiveEffect of its own — the module creates
 * a marker AE so the rider is visible on the token / combat tracker. Matched
 * by lowercased activity-name prefix. The marker uses the activity's own icon
 * (the one shown on its button in the Wild Surge activity dialog) with `img`
 * as fallback — unless `useActivityIcon: false`, where `img` always wins
 * (e.g. roll 7's activity only has the generic utility icon).
 *  - roll 3: an exploding spirit (flumph/pixie) — re-summonable each turn as
 *    a bonus action.
 *  - roll 5: retributive wild magic — attackers who hit you take 1d6 force.
 *  - roll 7: flowers and vines — ground within 15 ft is difficult terrain
 *    for enemies.
 *  - roll 8: a bolt of light from your chest — re-usable each turn as a
 *    bonus action.
 */
const SURGE_ACTIVITY_MARKERS = [
  {
    prefix: "3: exploding spirit",
    statusId: "cst-exploding-spirit",
    img: "icons/creatures/magical/spirit-undead-winged-ghost.webp",
    nameKey: "COMBAT_SPELL_TIMER.WildSurge.ExplodingSpirit",
    descriptionKey: "COMBAT_SPELL_TIMER.WildSurge.ExplodingSpiritDescription",
  },
  {
    prefix: "5: wild magic damage",
    statusId: "cst-wild-magic-damage",
    img: "systems/dnd5e/icons/svg/activity/damage.svg",
    nameKey: "COMBAT_SPELL_TIMER.WildSurge.WildMagicDamage",
    descriptionKey: "COMBAT_SPELL_TIMER.WildSurge.WildMagicDamageDescription",
  },
  {
    prefix: "7: flowers and vines",
    statusId: "cst-flowers-and-vines",
    img: "icons/magic/nature/root-vine-entangle-foot-green.webp",
    useActivityIcon: false,
    nameKey: "COMBAT_SPELL_TIMER.WildSurge.FlowersAndVines",
    descriptionKey: "COMBAT_SPELL_TIMER.WildSurge.FlowersAndVinesDescription",
  },
  {
    prefix: "8: bolt of light",
    statusId: "cst-bolt-of-light",
    img: "icons/magic/lightning/bolt-strike-beam-yellow.webp",
    useActivityIcon: false,
    nameKey: "COMBAT_SPELL_TIMER.WildSurge.BoltOfLight",
    descriptionKey: "COMBAT_SPELL_TIMER.WildSurge.BoltOfLightDescription",
  },
];

/**
 * dnd5e.postUseActivity dispatch (via the rage descriptor's onActivityUse):
 * when a Wild Surge activity with a lasting rider is used, create its marker
 * AE on the actor. Deduped by status id — re-using the rider as a bonus action
 * on later turns fires this hook again but must not stack markers.
 * @param {Activity} activity
 */
export async function onWildSurgeActivity(activity) {
  const actor = activity?.actor;
  if (!actor || !isWildSurgeItem(activity?.item)) return;
  const aname = activity.name?.toLowerCase() ?? "";
  const cfg = SURGE_ACTIVITY_MARKERS.find(c => aname.startsWith(c.prefix));
  if (!cfg) return;
  if (actor.effects.some(e => e.statuses?.has?.(cfg.statusId))) return;
  const data = {
    name: game.i18n.localize(cfg.nameKey),
    // Same icon as the activity's button in the Wild Surge dialog, unless the
    // entry opts for its own (the activity icon may be a generic type default).
    img: (cfg.useActivityIcon !== false && activity.img) || cfg.img,
    statuses: [cfg.statusId],
    disabled: false,
    origin: activity.item.uuid,
    description: `<p>${game.i18n.localize(cfg.descriptionKey)}</p>`,
    // Same v14 quirk as feature AEs (shared.mjs): a temporary-flagged effect
    // with no finite duration gets suppressed by the expiry registry, so it
    // carries the sentinel; rage end deletes it (boundFeature drives display).
    duration: { rounds: FEATURE_SENTINEL_ROUNDS },
    flags: {
      dnd5e: { isTemporary: true },
      [MODULE_ID]: { [SURGE_FLAG]: true, boundFeature: "rage" },
    },
  };
  dbg("dnd5e:wild-surge-marker", cfg.statusId, actor.name);
  await actor.createEmbeddedDocuments("ActiveEffect", [data]);
}

/**
 * Wild Magic table effects that last "until your rage ends" (lowercased AE
 * names, as applied by the actor's Wild Surge item — names per ddb-importer's
 * WildSurge enricher). Actor effects and item enchantments alike:
 *  - roll 4: "Wild Surge Weapon" — an enchant-type AE on the chosen weapon.
 *  - roll 6: "Multicolored Light AC Bonus" — +1 AC on the actor.
 * Module-created marker AEs are matched by SURGE_FLAG instead of name.
 */
const RAGE_BOUND_SURGE_EFFECTS = ["wild surge weapon", "multicolored light ac bonus"];

const isRageBoundSurgeEffect = (e) => e.flags?.[MODULE_ID]?.[SURGE_FLAG] === true
  || RAGE_BOUND_SURGE_EFFECTS.includes(e.name?.toLowerCase());

/**
 * Resolve the Actor an applied effect originates from, walking the origin
 * UUID through Item / Activity parents. Null when there is no origin or it
 * can't be resolved (e.g. a deleted source, or a world-item origin).
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
function effectOriginActor(effect) {
  if (!effect?.origin) return null;
  let doc = null;
  try { doc = fromUuidSync(effect.origin); } catch { /* unresolved */ }
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  return doc.actor ?? (doc.parent?.documentName === "Actor" ? doc.parent : null);
}

/**
 * Delete the rage-bound surge effects on one actor that pass `originOk`,
 * sweeping the actor's own effects (roll 6, module markers) and each item's
 * effects (roll 4's weapon enchantment lives on the enchanted item).
 * @param {Actor} actor
 * @param {(e: ActiveEffect) => boolean} originOk
 */
async function sweepSurgeEffects(actor, originOk) {
  const match = (e) => isRageBoundSurgeEffect(e) && originOk(e);
  const ids = [...(actor.effects ?? [])].filter(match).map(e => e.id);
  if (ids.length) {
    dbg("dnd5e:wild-surge-effects-removed", actor.name, ids.length);
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
  for (const item of actor.items ?? []) {
    // NEVER touch a Wild Surge item itself: it holds the TEMPLATE effects
    // its activities apply copies of ("Multicolored Light AC Bonus", "Wild
    // Surge Weapon"). Deleting those would permanently break the feature —
    // only applied copies elsewhere (actor, enchanted weapon) are rage-bound.
    if (isWildSurgeItem(item)) continue;
    const eids = [...(item.effects ?? [])].filter(match).map(e => e.id);
    if (!eids.length) continue;
    dbg("dnd5e:wild-surge-enchantment-removed", actor.name, item.name, eids.length);
    await item.deleteEmbeddedDocuments("ActiveEffect", eids);
  }
}

/** Every distinct combatant actor across all combats except the rager. */
function otherCombatantActors(rager) {
  const seen = new Map();
  for (const combat of game.combats ?? []) {
    for (const combatant of combat.combatants ?? []) {
      const a = combatant.actor;
      if (a && a.uuid !== rager.uuid) seen.set(a.uuid, a);
    }
  }
  return [...seen.values()];
}

/**
 * Remove the rage-bound Wild Surge effects when a rage ends (none is fine),
 * scoped by ORIGIN so concurrent ragers don't clobber each other:
 *  - On the rager's own actor: remove effects that originate from the rager,
 *    plus unattributable ones (no/unresolvable origin — assumed self-applied).
 *    An effect another rager's surge shared onto this actor (e.g. roll 6's
 *    ally AC bonus) survives — it ends with THAT rage, not this one.
 *  - On every other combatant: remove only effects that provably originate
 *    from this rager (the ally-shared copies), and only where this client
 *    has owner permission — natural expiry runs GM-side and cleans them all;
 *    a player ending their own rage can only clean actors they own.
 * The ddb-applied AEs carry no module flag and no self-expiring duration, so
 * without this they would linger after the rage.
 * @param {Actor} rager  The actor whose rage just ended.
 */
export async function removeWildSurgeEffects(rager) {
  if (!rager) return;
  const fromRager = (e) => effectOriginActor(e)?.uuid === rager.uuid;
  await sweepSurgeEffects(rager, (e) => {
    const src = effectOriginActor(e);
    return !src || src.uuid === rager.uuid;
  });
  for (const actor of otherCombatantActors(rager)) {
    if (!actor.isOwner) continue;
    await sweepSurgeEffects(actor, fromRager);
  }
}
