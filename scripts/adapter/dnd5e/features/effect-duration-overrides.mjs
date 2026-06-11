import { dbg } from "../../../utils/debug.mjs";
import { effectOriginItem } from "./shared.mjs";

/**
 * Duration corrections for applied effects whose source data carries the
 * wrong duration, keyed by the ORIGIN item's name (the applied effect itself
 * may be generically named — Cloak of Shadows just applies "Invisible").
 *
 *  - Channel Divinity: Cloak of Shadows (Trickery cleric): "you become
 *    invisible until the end of your next turn" — ddb-importer's enricher
 *    applies the effect with a 60-second duration; the rules give it a
 *    single round.
 */
const DURATION_OVERRIDES = [
  {
    itemNameIncludes: "cloak of shadows",
    duration: { rounds: 1 },
  },
];

/**
 * createActiveEffect dispatch (from the adapter's early-end listener): when a
 * just-created AE originates from a listed item, override its duration —
 * anchored to the current combat round/turn so the countdown starts now.
 * Initiating client only (they created the effect, so they can update it).
 * @param {ActiveEffect} effect  The effect that was just created.
 * @param {string} userId        The initiating user's id.
 */
export async function onEffectDurationOverrides(effect, userId) {
  if (userId !== game.user.id) return;
  if (effect.parent?.documentName !== "Actor") return;
  const itemName = effectOriginItem(effect)?.name?.toLowerCase() ?? "";
  if (!itemName) return;
  const entry = DURATION_OVERRIDES.find(o => itemName.includes(o.itemNameIncludes));
  if (!entry) return;
  const combat = game.combat;
  dbg("dnd5e:effect-duration-override", effect.name, entry.itemNameIncludes, entry.duration);
  await effect.update({
    "duration.rounds": entry.duration.rounds ?? null,
    "duration.turns": entry.duration.turns ?? null,
    "duration.seconds": null,
    "duration.startRound": combat?.round ?? null,
    "duration.startTurn": combat?.turn ?? null,
  });
}
