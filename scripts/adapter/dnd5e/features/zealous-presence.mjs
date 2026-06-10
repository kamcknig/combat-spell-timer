import { dbg } from "../../../utils/debug.mjs";
import { effectOriginActor } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";

/**
 * dnd5e Barbarian "Zealous Presence" (Path of the Zealot, level 10) feature
 * descriptor. Inverted shape: the caster never carries the effect — up to ten
 * OTHER creatures gain the item-applied "Zealous Presence" AE until the start
 * of the caster's next turn. The module tracks the window as an owner-anchored
 * 1-round timer on the caster (no AE, no caster token icon) and, when the
 * timer ends by any path, removes every applied copy originating from this
 * caster from ANY actor that carries it (world actors and scene tokens alike,
 * combatant or not). Deletions route through the GM socket (removeEffect), so
 * ownership of the targets never matters.
 */

const APPLIED_EFFECT_NAME = "zealous presence";

const isZealousPresenceItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "zealous presence" || i.system?.identifier?.toLowerCase() === "zealous-presence");

/**
 * Every distinct actor that could carry an applied effect: world actors plus
 * each scene token's actor — unlinked tokens have synthetic actors that live
 * on the token, not in game.actors.
 */
function candidateActors() {
  const seen = new Map();
  for (const actor of game.actors ?? []) seen.set(actor.uuid, actor);
  for (const scene of game.scenes ?? []) {
    for (const token of scene.tokens ?? []) {
      if (token.actor) seen.set(token.actor.uuid, token.actor);
    }
  }
  return [...seen.values()];
}

export default {
  id: "zealous-presence",
  label: "Zealous Presence",

  detect(activity) {
    if (!isZealousPresenceItem(activity?.item)) return null;
    // The 2024-rules item carries a second activity, "Spend Rage to Restore
    // Use" — only the battle cry itself starts the clock.
    if (activity?.name?.toLowerCase().startsWith("spend rage")) return null;
    const item = activity.item;
    // 1 owner-anchored round = until the start of the caster's next turn.
    return { name: item.name, img: item.img, itemUuid: item.uuid, durationRounds: 1 };
  },

  // The caster never carries the effect ("up to ten OTHER creatures"), so no
  // module-owned AE and no caster token icon — the anchored tracker row is the
  // only caster-side artifact. Explicit null: without it the Tier-1 clone path
  // would copy the item's template effect onto the caster.
  effect: null,

  /**
   * Timer ended (expiry at the caster's next turn, manual remove, or re-cast
   * refresh) → remove every applied "Zealous Presence" effect that originates
   * from this caster, wherever it landed. Origin-scoped so another Zealot's
   * concurrent presence is untouched; idempotent (removeEffect on a deleted
   * uuid is a no-op), as the contract requires.
   */
  onRemove({ casterActorUuid }) {
    const caster = casterActorUuid ? fromUuidSync(casterActorUuid) : null;
    if (!caster) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.name?.toLowerCase() !== APPLIED_EFFECT_NAME) continue;
        if (effectOriginActor(effect)?.uuid !== caster.uuid) continue;
        dbg("dnd5e:zealous-presence-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-bullhorn",
    roundsLeftKey: "COMBAT_SPELL_TIMER.ZealousPresence.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.ZealousPresence.EndLabel",
    // No turnEnd (fixed duration, no extension) and no joinPrompt (one round).
  },
};
