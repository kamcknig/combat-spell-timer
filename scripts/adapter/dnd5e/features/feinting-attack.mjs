import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Feinting Attack": "You have advantage
 * on your next attack roll against that target this turn. If that attack
 * hits, add the superiority die to the attack's damage roll." A
 * target-anchored marker ("Feinted"), caster-anchored timer expiring at the
 * END of the caster's OWN current turn (turnEnd.includeCastTurn — same shape
 * as Moonlight Step's "before the end of this turn", unlike Distracting
 * Strike's plain expire, which waits a full round). The marker also drives
 * two roll-time automations (Phase 3, below): Advantage on the caster's next
 * attack against the marked target, and adding the already-rolled
 * superiority die total to that attack's damage roll. Applied via a
 * persisted template on the "Maneuver: Feinting Attack" item itself (see
 * feinting-attack.mjs's ensureEffectTemplate() call), through dnd5e's native
 * apply-effects tray on the maneuver's own roll message.
 */
export const FEINTED_FLAG = "feinted"; // flags[MODULE_ID][FEINTED_FLAG] = true on the marker AE
export const FEINTED_STATUS_ID = "cst-feinted";

function feintCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "feintingAttack",
  label: "Feinting Attack",
  effect: null, // lives on the TARGET — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[FEINTED_FLAG]) continue;
        if (feintCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:feinting-attack-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-mask",
    roundsLeftKey: "COMBAT_SPELL_TIMER.FeintingAttack.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.FeintingAttack.EndLabel",
    // "This turn" — ends at the end of the caster's OWN cast turn, not a full
    // round later. includeCastTurn makes the cast turn itself qualify (the
    // default "expire" skips it — see core/features.mjs#onFeatureTurnEnd).
    turnEnd: { mode: "expire", includeCastTurn: true },
  },
};

/**
 * createActiveEffect dispatch: a Feinted marker was just applied to a target
 * via the apply-effects tray — start the caster-anchored timer. Mirrors
 * distracting-strike.mjs#onDistractingStrikeEffectApplied's exceptEffectUuid
 * reasoning exactly: the marker already exists by the time this fires, so
 * onFeatureStart's refresh-sweep must not delete the very effect that
 * triggered it.
 */
export async function onFeintingAttackEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[FEINTED_FLAG]) return;
  const casterActorUuid = feintCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:feinting-attack:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "feintingAttack", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}

// ── Phase 3 adds onFeintingAttackPreRollAttack, onFeintingAttackTargetAttacked,
// and onFeintingAttackPreRollDamage below this line. ──
