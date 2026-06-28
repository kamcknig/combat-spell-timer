import { dbg } from "../../../utils/debug.mjs";
import { findModuleEffect } from "./shared.mjs";

/**
 * dnd5e Druid (Circle of the Moon, 2024) "Moonlight Step" feature descriptor.
 *
 * The teleport ("Transport") activity grants Advantage on the caster's next
 * attack roll, "before the end of this turn". We model this as a one-round,
 * owner-anchored marker AE that:
 *   - shows the feat's icon as a token status,
 *   - is removed the instant the caster makes ANY attack roll (Phase 2), and
 *   - otherwise expires at the END of the caster's cast turn (turnEnd.expire +
 *     includeCastTurn).
 *
 * The Advantage itself is applied at roll time via the dnd5e.preRollAttackV2
 * dispatch (Phase 2) — core dnd5e has no AE-settable "advantage on all attacks"
 * flag, and the imported feat's own effect uses midi-qol/DAE keys that do
 * nothing here (so we never clone it: effect.hardcodedOnly).
 */

// "before the end of this turn" → one owner-anchored round; the turn-end expire
// (includeCastTurn) removes it at the end of the cast turn, the attack consume
// removes it sooner.
const MOONLIGHT_STEP_DURATION_ROUNDS = 1;
const STATUS_ID = "cst-moonlight-step";

const isMoonlightStepItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "moonlight step"
      || i.system?.identifier?.toLowerCase() === "moonlight-step");

/**
 * The feat may carry a second "spend a level 2+ spell slot to restore a use"
 * activity (no buff). It is the only Moonlight Step activity that consumes a
 * spell slot, so a spellSlots consumption target disqualifies the activity from
 * starting the buff. Harmless if the imported item has no such activity.
 */
const restoresUse = (activity) =>
  (activity?.consumption?.targets ?? []).some(t => t.type === "spellSlots");

const moonlightStep = {
  id: "moonlight-step",
  label: "Moonlight Step",

  detect(activity) {
    if (!isMoonlightStepItem(activity?.item)) return null;
    if (restoresUse(activity)) {
      dbg("dnd5e:moonlight-step:detect", "skip restore-use activity");
      return null;
    }
    const item = activity.item;
    dbg("dnd5e:moonlight-step:detect", item.name, activity.name ?? activity.type);
    return {
      name: item.name,
      img: item.img,
      itemUuid: item.uuid,
      durationRounds: MOONLIGHT_STEP_DURATION_ROUNDS,
    };
  },

  // Beyond20 "start by name" parity (scripts/core/beyond20.mjs).
  fromActor(actor) {
    const item = actor?.items?.find(isMoonlightStepItem);
    return {
      name: item?.name ?? "Moonlight Step",
      img: item?.img ?? "",
      itemUuid: item?.uuid ?? null,
      durationRounds: MOONLIGHT_STEP_DURATION_ROUNDS,
    };
  },

  effect: {
    statusId: STATUS_ID,
    // Fallback only — the AE normally inherits the feat's own image (record.img).
    // Adjust if this core path 404s on your install.
    defaultIcon: "icons/magic/movement/trail-streak-impact-blue.webp",
    featNames: ["moonlight step"],
    // The imported feat's own "Advantage on Next Attack" effect carries only
    // midi-qol / DAE keys (flags.midi-qol.advantage.attack.all + a "1Attack"
    // special duration) that do NOTHING in core dnd5e — never clone it.
    hardcodedOnly: true,
    // Pure marker: Advantage is applied at roll time (preRollAttackV2, Phase 2),
    // not through AE changes — core dnd5e has no "advantage on all attacks" flag.
    changes() { return []; },
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-moon",
    roundsLeftKey: "COMBAT_SPELL_TIMER.MoonlightStep.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.MoonlightStep.EndLabel",
    // Ends at the END of the caster's OWN cast turn ("before the end of this
    // turn"). includeCastTurn makes the cast turn itself qualify (the default
    // "expire" skips it). Writer-gated removal happens in onFeatureTurnEnd.
    turnEnd: { mode: "expire", includeCastTurn: true },
  },
};

export default moonlightStep;

/**
 * dnd5e.preRollAttackV2 dispatch: while the bearer carries the Moonlight Step
 * marker, their attack rolls are made with Advantage. Sets config.advantage,
 * honored by D20Roll.applyKeybindings (dnd5e.mjs: `roll.options.advantage ||
 * config.advantage || keys.advantage`). The marker is removed afterwards by
 * onMoonlightStepAttackRolled (dnd5e.rollAttackV2 fires post-evaluate, so THIS
 * roll keeps its advantage and only the NEXT one loses it). config.subject is
 * the AttackActivity. Fires only on the rolling client (owns the actor).
 * @param {object} config  The pending attack roll process config.
 */
export function onMoonlightStepPreRollAttack(config) {
  const actor = config?.subject?.actor;
  if (!actor) return;
  if (!findModuleEffect(actor, moonlightStep)) return;
  dbg("dnd5e:moonlight-step:advantage", actor.name);
  config.advantage = true;
}

/**
 * dnd5e.rollAttackV2 dispatch: a completed attack roll consumes Moonlight Step.
 * Returns the early-end query so the adapter drops the timer + marker AE; null
 * when the actor has no marker. Fires only on the rolling client.
 * @param {object} subject  The AttackActivity ({ subject } hook arg).
 * @returns {{featureId: string, casterActorUuid: string}|null}
 */
export function onMoonlightStepAttackRolled(subject) {
  const actor = subject?.actor;
  if (!actor) return null;
  if (!findModuleEffect(actor, moonlightStep)) return null;
  dbg("dnd5e:moonlight-step:consume-on-attack", actor.name);
  return { featureId: moonlightStep.id, casterActorUuid: actor.uuid };
}
