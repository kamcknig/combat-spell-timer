import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";
import { onFeatureStart } from "../../../core/features.mjs";

/**
 * dnd5e Fighter (Battle Master, 2014) "Goading Attack": "the target must
 * make a Wisdom saving throw. On a failed save, the target has disadvantage
 * on all attack rolls against targets other than you until the end of your
 * next turn." This module doesn't automate the save (same rigor as
 * Disarming Attack's Strength-save prompt — a button, not an enforced
 * check); the GM decides whether to apply the marker via the damage
 * message's apply-effects tray (goading-attack.mjs's onRenderGoadDamageMessage).
 * Caster-anchored timer, target-anchored "Goaded" marker — same shape as
 * Sap/Slow/Distracting Strike/Feinting Attack — but unlike Sap (consumed the
 * instant the target makes any attack roll), Goading Attack's disadvantage
 * is conditional on WHO the target attacks (nothing against the caster) and
 * applies to EVERY qualifying attack for the whole duration, so there is no
 * early-consumption hook here; the marker simply expires via the timer at
 * the caster's next turn.
 */
export const GOADED_FLAG = "goaded"; // flags[MODULE_ID][GOADED_FLAG] = true on the marker AE
export const GOADED_STATUS_ID = "cst-goaded";

function goadCaster(effect) {
  return effect?.flags?.[MODULE_ID]?.casterActorUuid ?? null;
}

export default {
  id: "goadingAttack",
  label: "Goading Attack",
  effect: null, // lives on the TARGET — see onRemove
  onRemove({ casterActorUuid, exceptEffectUuid } = {}) {
    if (!casterActorUuid) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (effect.uuid === exceptEffectUuid) continue;
        if (!effect.flags?.[MODULE_ID]?.[GOADED_FLAG]) continue;
        if (goadCaster(effect) !== casterActorUuid) continue;
        dbg("dnd5e:goading-attack-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },
  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-bullhorn",
    roundsLeftKey: "COMBAT_SPELL_TIMER.GoadingAttack.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.GoadingAttack.EndLabel",
    turnEnd: { mode: "expire" },
  },
};

/** The actor's current Goaded marker, or null. */
function goadedMarker(actor) {
  return (actor?.effects ?? []).find(e => e.flags?.[MODULE_ID]?.[GOADED_FLAG]) ?? null;
}

/**
 * dnd5e.preRollAttackV2 dispatch: a Goaded actor's attack roll against
 * anyone OTHER than the caster who goaded it is made with Disadvantage.
 * Checks the roller's currently-targeted tokens for the caster's actor —
 * if the caster isn't among them (no target, or a different target), the
 * attack is "against someone other than you" and gets Disadvantage; if the
 * caster IS targeted, the attack is unaffected. Pre-roll so
 * D20Roll.applyKeybindings sees config.disadvantage before the dialog/roll
 * is built. Never consumed here — stays active for every attack until the
 * marker's timer expires at the caster's next turn.
 * @param {object} config
 */
export function onGoadedPreRollAttack(config) {
  const actor = config?.subject?.actor;
  const marker = goadedMarker(actor);
  if (!marker) return;
  const casterActorUuid = goadCaster(marker);
  const targetsCaster = Array.from(game.user?.targets ?? []).some(t => t.actor?.uuid === casterActorUuid);
  if (targetsCaster) return;
  dbg("dnd5e:goading-attack:disadvantage", actor.name);
  config.disadvantage = true;
}

/**
 * createActiveEffect dispatch: a Goaded marker was just applied to a target
 * (via the effect-application tray) — start the caster-anchored timer.
 * Mirrors sap.mjs#onSapEffectApplied's exceptEffectUuid reasoning: the
 * marker already exists by the time this fires, so onFeatureStart's
 * refresh-sweep must not delete the very effect that triggered it.
 * @param {ActiveEffect} effect
 * @param {string} userId
 * @param {(actor: Actor, featureId: string, opts: object) => Promise<string|null>} applyEffect
 */
export async function onGoadingAttackEffectApplied(effect, userId, applyEffect) {
  if (userId !== game.user.id) return;
  if (!effect.flags?.[MODULE_ID]?.[GOADED_FLAG]) return;
  const casterActorUuid = goadCaster(effect);
  if (!casterActorUuid || !fromUuidSync(casterActorUuid)) return;
  dbg("dnd5e:goading-attack:applied", effect.parent?.name, casterActorUuid);
  await onFeatureStart(
    { featureId: "goadingAttack", casterActorUuid, name: effect.name, img: effect.img, durationRounds: 1, exceptEffectUuid: effect.uuid },
    applyEffect
  );
}
