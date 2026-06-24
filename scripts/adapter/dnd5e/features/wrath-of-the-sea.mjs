import { dbg } from "../../../utils/debug.mjs";
import { MODULE_ID } from "../../../module.mjs";
import { findFeat, findModuleEffect } from "./shared.mjs";

/**
 * dnd5e Druid (Circle of the Sea) "Wrath of the Sea" feature descriptor.
 *
 * The item has TWO activities:
 *  - "Activate the aura": manifests the 5-ft swirling-water emanation (places a
 *    measured template) and spends one Wild Shape use; lasts 10 min (100 rounds).
 *  - "Save for damage": posts the save/damage chat card (the bonus-action
 *    attack). LEFT ALONE — never detected or modified.
 *
 * Phase 1 scope: track the activate activity as a 100-round self-marker AE with
 * a combat-tracker row and a combat-join prompt. ddb-importer classifies
 * WrathOfTheSea as a "marker" (no stat changes — todo.md:27), so effect.changes
 * returns []. Phases 2 (Wild Shape consumption) and 3 (swirling light) extend
 * this descriptor.
 */

// 10 minutes @ 6s/round. 2024-only content, so no edition variant.
const WRATH_DURATION_ROUNDS = 100;

const isWrathItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() === "wrath of the sea"
      || i.system?.identifier?.toLowerCase() === "wrath-of-the-sea");

/**
 * True only for the "activate the aura" activity of a Wrath of the Sea feat.
 * The save-for-damage activity rolls damage and is excluded; the activate
 * activity is identified by the emanation template, with a Wild Shape
 * (itemUses) consumption target as a fallback signal.
 */
export function isWrathActivateActivity(activity) {
  if (!isWrathItem(activity?.item)) return false;
  if (activity?.damage?.parts?.length) return false;          // the "save for damage" activity
  if (activity?.target?.template?.type) return true;          // places the emanation template
  return (activity?.consumption?.targets ?? []).some(t => t.type === "itemUses");
}

/**
 * Wild Shape uses snapshot taken in onPreUse (keyed by caster actor uuid),
 * consumed in onActivityUse. preUse/postUse both fire on the activating client,
 * so the snapshot stays local to one client. A stale entry (dialog cancelled →
 * no postUse) is harmlessly overwritten by the next use.
 */
const wildShapeSpentBefore = new Map();

/**
 * The actor's Wild Shape uses pool. Prefer the activate activity's configured
 * itemUses consumption target; fall back to a feat named/identified "Wild Shape".
 */
function wildShapePool(actor, activity) {
  const tgt = (activity?.consumption?.targets ?? []).find(t => t.type === "itemUses" && t.target);
  const byTarget = tgt ? actor?.items?.get(tgt.target) : null;
  if (Number(byTarget?.system?.uses?.max) > 0) return byTarget;
  return findFeat(actor, "wild shape", "wild-shape");
}

const usesSpent = (item) => Number(item?.system?.uses?.spent) || 0;
const usesMax = (item) => Number(item?.system?.uses?.max) || 0;

// Per-token flag holding the light that was on the token before Wrath applied
// its own, so it can be restored on end. Stored on the token (not the AE),
// because the AE doesn't exist yet when onStart runs.
const PRIOR_LIGHT_FLAG = "wrathPriorLight";

// Blue swirling 5-ft emanation. dim:6.5 covers the full 5-ft square with a bit
// of spill past the grid edge; "vortex" is Foundry's swirling animation. Tunable.
const WRATH_LIGHT = {
  dim: 6.5,
  bright: 0,
  color: "#1e90ff",
  alpha: 0.5,
  attenuation: 0.6,
  luminosity: 0.25,
  animation: { type: "vortex", speed: 4, intensity: 4 },
};

/** The caster's TokenDocuments on the active scene (synthetic-actor safe). */
function wrathTokens(actor) {
  const docs = actor?.getActiveTokens?.(false, true) ?? [];
  if (docs.length) return docs;
  return actor?.token ? [actor.token] : [];
}

/**
 * Apply the swirling light to each of the caster's tokens, snapshotting the
 * prior light into a token flag. Self-correcting on a re-activation refresh: if
 * the flag already holds a prior light (our light is currently on), keep that
 * prior value rather than snapshotting our own light. The flag write here is
 * enqueued AFTER any onEffectDeleted restore from the same refresh (same client,
 * delete-before-apply ordering), so the blue light is the final state.
 */
async function applyWrathLight(actor) {
  for (const td of wrathTokens(actor)) {
    const cur = td.toObject();
    const hasFlag = cur.flags?.[MODULE_ID]?.[PRIOR_LIGHT_FLAG] !== undefined;
    const prior = hasFlag ? cur.flags[MODULE_ID][PRIOR_LIGHT_FLAG] : cur.light;
    dbg("dnd5e:wrath-of-the-sea:light-apply", td.uuid);
    await td.update({
      "==light": { ...WRATH_LIGHT },
      [`flags.${MODULE_ID}.${PRIOR_LIGHT_FLAG}`]: prior,
    }).catch(err => console.error("combat-spell-timer | wrath of the sea: light apply failed", err));
  }
}

/** Restore each token's prior light and clear the flag (no-op if not applied). */
async function removeWrathLight(actor) {
  for (const td of wrathTokens(actor)) {
    const prior = td.flags?.[MODULE_ID]?.[PRIOR_LIGHT_FLAG];
    if (prior === undefined) continue;
    dbg("dnd5e:wrath-of-the-sea:light-remove", td.uuid);
    await td.update({
      "==light": prior,
      [`flags.${MODULE_ID}.-=${PRIOR_LIGHT_FLAG}`]: null,
    }).catch(err => console.error("combat-spell-timer | wrath of the sea: light remove failed", err));
  }
}

export default {
  id: "wrath-of-the-sea",
  label: "Wrath of the Sea",

  detect(activity) {
    if (!isWrathActivateActivity(activity)) return null;
    const item = activity.item;
    dbg("dnd5e:wrath-of-the-sea:detect", item.name, activity.name ?? activity.type);
    return {
      name: item.name,
      img: item.img,
      itemUuid: item.uuid,
      durationRounds: WRATH_DURATION_ROUNDS,
    };
  },

  // Beyond20 "start by name" parity (scripts/core/beyond20.mjs).
  fromActor(actor) {
    const item = actor?.items?.find(isWrathItem);
    return {
      name: item?.name ?? "Wrath of the Sea",
      img: item?.img ?? "",
      itemUuid: item?.uuid ?? null,
      durationRounds: WRATH_DURATION_ROUNDS,
    };
  },

  effect: {
    statusId: "cst-wrath-of-the-sea",
    // Fallback only — the AE normally inherits the feat's own image (record.img).
    // A core water/whirlpool icon; adjust if this path 404s on your install.
    defaultIcon: "icons/magic/water/vortex-water-whirlpool-blue.webp",
    featNames: ["wrath of the sea"],
    // Pure marker — ddb classifies WrathOfTheSea with no stat changes (todo.md:27).
    changes() { return []; },
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-water",
    roundsLeftKey: "COMBAT_SPELL_TIMER.WrathOfTheSea.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.WrathOfTheSea.EndLabel",
    // No turnEnd: fixed 10-minute duration, no per-turn extend/end prompt.
    joinPrompt: {
      titleKey: "COMBAT_SPELL_TIMER.WrathOfTheSea.AlreadyActiveTitle",
      promptKey: "COMBAT_SPELL_TIMER.WrathOfTheSea.AlreadyActivePrompt",
      roundsKey: "COMBAT_SPELL_TIMER.WrathOfTheSea.AlreadyActiveRounds",
      defaultRounds: () => WRATH_DURATION_ROUNDS,
    },
  },

  /**
   * preUseActivity — for the activate activity only:
   *  1. Turn the "Place Measured Template" creation flag off
   *     (create.measuredTemplate = false). This item's usage dialog has nothing
   *     else to configure, so dnd5e's `_requiresConfigurationDialog`
   *     (dnd5e.mjs:17305) then suppresses the dialog entirely — the activity
   *     runs straight through with no template prompt (the desired flow). The
   *     effect, timer, light, Wild Shape spend, and chat card all still happen;
   *     only the template placement is skipped.
   *  2. Default any consume checkbox to UNCHECKED (resources = []) — a harmless
   *     no-op today (this item has no consumption section), kept as a
   *     forward-guard if a Wild Shape consumption target is ever added.
   *  3. Snapshot Wild Shape uses spent, so onActivityUse can tell whether the
   *     system consumed and avoid a double-spend.
   */
  onPreUse(activity, usageConfig) {
    if (!isWrathActivateActivity(activity)) return;
    const actor = activity.actor;
    if (usageConfig?.create && "measuredTemplate" in usageConfig.create) {
      usageConfig.create.measuredTemplate = false;
      dbg("dnd5e:wrath-of-the-sea:preuse", "create.measuredTemplate off — suppresses the template dialog");
    }
    if (Array.isArray(usageConfig?.consume?.resources)) {
      usageConfig.consume.resources = [];
      dbg("dnd5e:wrath-of-the-sea:preuse", "consume.resources defaulted to []");
    }
    const pool = wildShapePool(actor, activity);
    if (actor && pool) {
      wildShapeSpentBefore.set(actor.uuid, usesSpent(pool));
      dbg("dnd5e:wrath-of-the-sea:preuse", "wild shape spent before", usesSpent(pool), "of", usesMax(pool));
    }
  },

  /**
   * postUseActivity (dispatched as onActivityUse for every activity) — for the
   * activate activity only: compare Wild Shape uses to the pre-use snapshot.
   * If the system already spent one (after > before), do nothing. Otherwise
   * spend one ourselves — but only if a use remains — so Wrath of the Sea is
   * never double-charged if the item/system is later fixed.
   */
  onActivityUse(activity) {
    if (!isWrathActivateActivity(activity)) return;
    const actor = activity.actor;
    if (!actor || !wildShapeSpentBefore.has(actor.uuid)) return;
    const before = wildShapeSpentBefore.get(actor.uuid);
    wildShapeSpentBefore.delete(actor.uuid);

    const pool = wildShapePool(actor, activity);
    if (!pool) { dbg("dnd5e:wrath-of-the-sea:reconcile", "no Wild Shape pool found"); return; }
    const after = usesSpent(pool);
    if (after > before) {
      dbg("dnd5e:wrath-of-the-sea:reconcile", "system already spent a Wild Shape use — skipping");
      return;
    }
    if (after >= usesMax(pool)) {
      dbg("dnd5e:wrath-of-the-sea:reconcile", "no Wild Shape uses remaining");
      ui.notifications?.info(game.i18n.format("COMBAT_SPELL_TIMER.WrathOfTheSea.NoWildShapeUses", { name: actor.name }));
      return;
    }
    dbg("dnd5e:wrath-of-the-sea:reconcile", "spending one Wild Shape use", `${after} -> ${after + 1}`);
    pool.update({ "system.uses.spent": after + 1 })
      .catch(err => console.error("combat-spell-timer | wrath of the sea: wild shape spend failed", err));
  },

  /** Feature started → attach the swirling blue emanation light. Awaited so the
   *  prior-light snapshot is captured before the AE/timer creation continues. */
  async onStart(actor) {
    await applyWrathLight(actor).catch(err => console.error("combat-spell-timer | wrath of the sea: onStart failed", err));
  },

  /**
   * Feature AE deleted by any path → remove the light. Guard: if a Wrath AE is
   * still present (a re-activation already created the new one), leave the light
   * alone — the surviving AE owns it.
   */
  onEffectDeleted(actor) {
    if (findModuleEffect(actor, this)) return;
    return removeWrathLight(actor);
  },
};
