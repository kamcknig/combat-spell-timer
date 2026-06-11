import { dbg } from "../../../utils/debug.mjs";
import { effectOriginItem } from "./shared.mjs";

/**
 * Effects whose rules end them when their BEARER acts — attacks or casts a
 * spell — but whose source automation doesn't enforce it (DAE-style special
 * durations without DAE). Matched by the ORIGIN item's name, because the
 * applied effect itself may be generically named (Cloak of Shadows applies
 * plain "Invisible").
 *
 *  - Channel Divinity: Cloak of Shadows (Trickery cleric): "You become
 *    visible if you attack or cast a spell."
 */
const ACTION_ENDED_EFFECTS = [
  {
    itemNameIncludes: "cloak of shadows",
    endOnAttack: true,
    endOnSpell: true,
  },
];

/** Remove the actor's effects that the given action kind terminates. */
async function endActionEndedEffects(actor, kind) {
  if (actor?.documentName !== "Actor") return;
  for (const entry of ACTION_ENDED_EFFECTS) {
    if (kind === "attack" && !entry.endOnAttack) continue;
    if (kind === "spell" && !entry.endOnSpell) continue;
    const ids = [...(actor.effects ?? [])]
      .filter(e => (effectOriginItem(e)?.name?.toLowerCase() ?? "").includes(entry.itemNameIncludes))
      .map(e => e.id);
    if (!ids.length) continue;
    dbg("dnd5e:action-ended-effects", actor.name, kind, entry.itemNameIncludes, ids.length);
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

/**
 * dnd5e.postUseActivity dispatch (from the adapter's detection listener):
 * casting any spell ends the bearer's break-on-spell effects. Fires only on
 * the acting client, which owns the actor.
 * @param {Activity} activity
 */
export function onActionEndedActivityUse(activity) {
  if (activity?.item?.type !== "spell") return;
  return endActionEndedEffects(activity.actor, "spell");
}

/**
 * dnd5e.rollAttackV2 dispatch: a completed attack roll ends the attacker's
 * break-on-attack effects. `subject` is the AttackActivity (null for
 * actor-less enricher rolls — skipped). Fires only on the rolling client.
 * @param {object} subject  The attack activity ({ subject } hook arg).
 */
export function onActionEndedAttackRoll(subject) {
  const actor = subject?.actor;
  if (!actor) return;
  return endActionEndedEffects(actor, "attack");
}
