import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Bait and Switch": a pure AC-bonus
 * marker on the recipient (caster or ally, chosen at Apply time), lasting
 * until the start of the caster's next turn. Same caster-anchored-timer /
 * target-anchored-effect shape as Distracting Strike
 * (features/distracting-strike.mjs) minus its "ends when an attack roll
 * happens" early-end hook — Bait and Switch's AC bonus has no RAW early-end
 * trigger, so the standard round-based timer expiry (and manual removal)
 * are the only removal paths. The marker AE is created via a persisted
 * template on the "Maneuver: Bait and Switch" item itself
 * (bait-and-switch.mjs's ensureEffectTemplate() call —
 * effect-application-tray.mjs), applied to a recipient through dnd5e's
 * native apply-effects tray on the roll's own chat message (not the
 * maneuver's announcement card — see bait-and-switch.mjs's own doc
 * comment).
 */
export const BAIT_AND_SWITCH_FLAG = "baitAndSwitch"; // flags[MODULE_ID][BAIT_AND_SWITCH_FLAG] = true on the marker AE
export const BAIT_AND_SWITCH_STATUS_ID = "cst-bait-and-switch";

function baitAndSwitchCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "baitAndSwitch",
  label: "Bait and Switch",
  effect: null, // lives on the RECIPIENT (caster or ally) — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[BAIT_AND_SWITCH_FLAG]) continue;
        if (baitAndSwitchCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:bait-and-switch-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-arrow-right-arrow-left",
    roundsLeftKey: "COMBAT_SPELL_TIMER.BaitAndSwitch.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.BaitAndSwitch.EndLabel",
    turnEnd: { mode: "expire" },
  },
};

/**
 * createActiveEffect dispatch: a Bait and Switch AC-bonus marker was just
 * applied to a recipient via the apply-effects tray — start the
 * caster-anchored timer. Mirrors sap.mjs#onSapEffectApplied's
 * exceptEffectUuid reasoning exactly: the marker already exists by the time
 * this fires, so onFeatureStart's refresh-sweep must not delete the very
 * effect that triggered it.
 */
export async function onBaitAndSwitchEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[BAIT_AND_SWITCH_FLAG]) return;
  const casterActorUuid = baitAndSwitchCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:bait-and-switch:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "baitAndSwitch", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}
