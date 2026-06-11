import { dbg } from "../../../utils/debug.mjs";

/**
 * Effects whose rules end them when their BEARER gains a status, but whose
 * source automation doesn't enforce it (DAE-style special durations without
 * DAE). When an AE granting one of `endOnStatuses` is created on an actor,
 * any of the actor's own effects matching `names` are removed.
 *
 *  - "Twilight Emanation" (Twilight cleric, Channel Divinity: Twilight
 *    Sanctuary; ddb's ChannelDivinityTwilightSanctuary enricher): the sphere
 *    "lasts for 1 minute or until you are incapacitated or die" — the 60s AE
 *    duration covers the minute; this covers the rest. Unconscious and dead
 *    imply the rules' "incapacitated or die".
 */
const STATUS_ENDED_EFFECTS = [
  {
    names: ["twilight emanation"],
    endOnStatuses: ["incapacitated", "unconscious", "dead"],
  },
];

/**
 * createActiveEffect dispatch (from the adapter's early-end listener): when a
 * just-created AE marks the actor with a terminating status, remove the
 * status-ended effects it terminates. Initiating client only — they applied
 * an AE to this actor, so they can delete from it too.
 * @param {ActiveEffect} effect  The effect that was just created.
 * @param {string} userId        The initiating user's id.
 */
export async function onStatusEndedEffects(effect, userId) {
  if (userId !== game.user.id) return;
  const actor = effect.parent;
  if (actor?.documentName !== "Actor") return;
  const statuses = effect.statuses;
  if (!statuses?.size) return;
  for (const entry of STATUS_ENDED_EFFECTS) {
    if (!entry.endOnStatuses.some(s => statuses.has(s))) continue;
    const ids = [...(actor.effects ?? [])]
      .filter(e => e.id !== effect.id && entry.names.includes(e.name?.toLowerCase()))
      .map(e => e.id);
    if (!ids.length) continue;
    dbg("dnd5e:status-ended-effects", actor.name, entry.names[0], ids.length);
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}
