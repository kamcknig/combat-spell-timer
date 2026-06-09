import { MODULE_ID } from "../module.mjs";
import { getTimers, remainingRounds } from "./store.mjs";
import { getAdapter } from "../adapter/index.mjs";

/**
 * Effect-collection for the in-row combatant effects block.
 *
 * Mirrors the set of icons the core/dnd5e combat tracker shows on a combatant
 * row (`actor.appliedEffects` filtered by showIcon/isTemporary), then enriches
 * each with the data the expanded panel needs: source actor, cast round and
 * rounds remaining. Two countdown sources are merged:
 *   - module feature effects (e.g. Rage) carry an empty AE duration — their
 *     countdown lives in the module timer record, read via remainingRounds();
 *   - every other effect uses its own dnd5e AE duration (start.round / remaining).
 */

/**
 * True if the tracker would draw an icon for this effect — same rule as core's
 * `_prepareTurnContext`: shown when `showIcon` is ALWAYS, or CONDITIONAL while
 * the effect is temporary. Defeated markers are excluded (core treats them as a
 * defeated flag, not an icon).
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
function showsIcon(effect) {
  if (effect.statuses?.has?.(CONFIG.specialStatusEffects?.DEFEATED)) return false;
  // v14+: an effect's showIcon (ALWAYS / CONDITIONAL+temporary) governs the icon.
  const SHOW = CONST.ACTIVE_EFFECT_SHOW_ICON;
  if (SHOW) {
    return effect.showIcon === SHOW.ALWAYS || (effect.showIcon === SHOW.CONDITIONAL && effect.isTemporary);
  }
  // v13: the combat tracker shows the actor's temporary effects (dnd5e's
  // isTemporary also covers our flagged feature effects).
  return !!effect.isTemporary;
}

/**
 * Resolve the Actor an effect originates from, walking the origin UUID through
 * Item / Activity / ActiveEffect parents. Returns null when unresolvable.
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
function originActor(effect) {
  if (!effect.origin) return null;
  let doc = null;
  try { doc = fromUuidSync(effect.origin); } catch { /* unresolved/compendium */ }
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  if (doc.actor) return doc.actor;            // Item / Activity / embedded
  if (doc.parent?.documentName === "Actor") return doc.parent;
  return null;
}

/**
 * The source actor's display name to show in parentheses, or null when the
 * effect comes from the combatant itself. Prefers the source's combatant/token
 * name in this combat (e.g. "Akra") over the full actor name (e.g.
 * "Akra (Dragonborn Cleric)"), matching how spell rows label their caster.
 * @param {ActiveEffect} effect
 * @param {Actor} self  The combatant's own actor.
 * @param {Combat} combat
 * @returns {string|null}
 */
function sourceLabel(src, self, effect, combat) {
  if (!src) return null;
  if (src === self || src.id === self?.id || src.uuid === self?.uuid) return null;
  const srcCombatant = combat?.getCombatantsByActor?.(src)?.[0];
  return srcCombatant?.name ?? src.token?.name ?? src.name ?? effect.sourceName ?? null;
}

/**
 * Collect the displayable effects for a combatant's row.
 * @param {Combatant} combatant
 * @param {Combat} combat
 * @returns {Array<{img:string, name:string, source:string|null, castRound:number|null, remaining:number|null, timer:object|null, effectUuid:string, controllable:boolean, expandable:boolean}>}
 */
export function collectEffects(combatant, combat) {
  const actor = combatant?.actor;
  if (!actor) return [];
  const timers = getTimers(combat);
  const out = [];
  for (const effect of actor.appliedEffects ?? []) {
    if (!showsIcon(effect)) continue;

    const src = originActor(effect);            // the Actor this effect came from
    const source = sourceLabel(src, actor, effect, combat); // null when it's self
    // Removable by: any GM, the owner of the actor it's on (owns the effect), or
    // the owner of the actor that applied it (cast it). Everyone else: no menu.
    const controllable = game.user.isGM || (actor.isOwner ?? false) || (src?.isOwner ?? false);

    let castRound = null;
    let remaining = null;
    let timer = null;      // module feature timer → drives the remove menu
    let countdown = null;  // timer whose countdown the icon/card should mirror

    const featureId = effect.flags?.[MODULE_ID]?.feature;
    if (featureId) {
      // Module feature (Rage, …): countdown lives in its timer record.
      timer = timers.find(t => t.effectUuid === effect.uuid)
        ?? timers.find(t => t.type === featureId && t.casterCombatantId === combatant.id)
        ?? null;
      countdown = timer;
    } else {
      // Spell-applied effect: mirror its spell timer (the caster's concentration
      // effect and every target effect it applied both resolve to the same timer)
      // so the icon counts down in lockstep with the spell row — at the spell's
      // initiative slot — not on the AE's own per-target expiry clock.
      countdown = getAdapter().getEffectTimer?.(effect, timers) ?? null;
    }

    if (countdown) {
      castRound = countdown.castRound;
      remaining = remainingRounds(countdown, combat);
    } else {
      // No linked timer: express the AE's own duration in whole combat rounds.
      // Combat-based durations (rounds/turns) are already in rounds; time-based
      // ones (seconds/minutes/…) convert via seconds remaining so the icon and
      // card read rounds — e.g. Bane's 1 min reads 10, not 60.
      effect.updateDuration?.();
      const dur = effect.duration ?? {};
      const timeBased = CONST.ACTIVE_EFFECT_TIME_DURATION_UNITS?.includes?.(dur.units);
      let rounds = null;
      if (timeBased) {
        if (Number.isFinite(dur.secondsRemaining)) {
          rounds = Math.ceil(dur.secondsRemaining / (CONFIG.time?.roundTime || 6));
        }
      } else if (Number.isFinite(dur.remaining)) {
        rounds = dur.remaining;
      }
      if (rounds != null) {
        remaining = rounds;
        castRound = Math.max(dur.startRound ?? effect.start?.round ?? 1, 1);
      }
    }

    out.push({
      img: effect.img,
      name: effect.name,
      source,
      castRound,
      remaining,
      // The module timer record for feature effects (Rage, …); null otherwise.
      // Feature cards remove via the timer; other effects delete the AE directly.
      timer,
      effectUuid: effect.uuid,
      controllable,
      // Only effects with a real countdown get a detail card in the panel.
      expandable: Number.isFinite(remaining) && remaining > 0,
    });
  }
  return out;
}
