import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Distracting Strike": a pure marker
 * effect on the target ("Distracted"), lasting until the caster's next
 * turn. No mechanical automation — the maneuver's actual rules benefit
 * (advantage for the next ally attack against the target) is not enforced
 * by this module; the marker + combat-tracker timer exist purely so the
 * table can see/track it. Same shape as Sap (features/sap.mjs) minus its
 * disadvantage hooks. The marker AE is created via a persisted template on
 * the "Maneuver: Distracting Strike" item itself (see distracting-strike.mjs's
 * ensureEffectTemplate() call — effect-application-tray.mjs), applied to a
 * target through dnd5e's native apply-effects tray on the maneuver's own
 * announcement card.
 */
export const DISTRACTED_FLAG = "distracted"; // flags[MODULE_ID][DISTRACTED_FLAG] = true on the marker AE
export const DISTRACTED_STATUS_ID = "cst-distracted";

function distractCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "distractingStrike",
  label: "Distracting Strike",
  effect: null, // lives on the TARGET — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[DISTRACTED_FLAG]) continue;
        if (distractCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:distracting-strike-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-bullseye",
    roundsLeftKey: "COMBAT_SPELL_TIMER.DistractingStrike.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.DistractingStrike.EndLabel",
    turnEnd: { mode: "expire" },
  },
};

/**
 * createActiveEffect dispatch: a Distracted marker was just applied to a
 * target via the apply-effects tray — start the attacker-anchored timer.
 * Mirrors sap.mjs#onSapEffectApplied's exceptEffectUuid reasoning exactly:
 * the marker already exists by the time this fires, so onFeatureStart's
 * refresh-sweep must not delete the very effect that triggered it.
 */
export async function onDistractingStrikeEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[DISTRACTED_FLAG]) return;
  const casterActorUuid = distractCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:distracting-strike:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "distractingStrike", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}

/**
 * dnd5e.rollAttackV2 dispatch: an attack roll was just made against a
 * currently-targeted token — if that token carries a Distracted marker, the
 * marker's job is done ("the next attack roll against the distracted
 * creature") regardless of hit/miss or who rolled it, per the user's
 * explicit "any attack roll ends it" scope (not gated on "an attacker other
 * than you", nor on whether the attack actually hits). Mirrors
 * onSapAttackRolled's shape; checks the roller's targeted tokens (not the
 * roller's own actor), since the marker lives on the TARGET, not the
 * attacker. Only the first matching targeted token's marker is ended per
 * roll — a roll against several simultaneously-marked targets from
 * different casters isn't expected in practice and isn't handled further.
 * @param {object} subject  The AttackActivity ({ subject } hook arg).
 * @returns {{featureId: string, casterActorUuid: string}|null}
 */
export function onDistractingStrikeTargetAttacked(subject) {
  if (!subject) return null;
  for (const target of game.user?.targets ?? []) {
    const marker = (target.actor?.effects ?? []).find(e => e.flags?.[MODULE_ID]?.[DISTRACTED_FLAG]);
    if (!marker) continue;
    const casterActorUuid = distractCaster(marker);
    if (!casterActorUuid) continue;
    dbg("dnd5e:distracting-strike:consumed-on-target-attacked", target.actor?.name);
    return { featureId: "distractingStrike", casterActorUuid };
  }
  return null;
}
