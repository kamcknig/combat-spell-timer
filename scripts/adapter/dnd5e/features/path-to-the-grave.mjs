import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { candidateActors, effectOriginActor } from "./shared.mjs";
import { removeEffect } from "../../../core/socket.mjs";

/**
 * dnd5e Cleric "Channel Divinity: Path to the Grave" (Grave Domain) — use
 * flow. The ddb item is a bare description item (no activities, no
 * consumption, no activity-linked effect), so Item5e#use skips the activity
 * pipeline and posts the card directly — no Ability Use dialog, nothing
 * consumed, no effects section on the card.
 *
 * ONE-TIME FIX-UP: the first use is intercepted via dnd5e.preDisplayCard (the
 * path a no-activity item takes) and the module makes the item native:
 *   - a no-op "Cursed" template ActiveEffect on the item (flagged, no
 *     changes — just the visible marker), and
 *   - a utility activity whose consumption targets the actor's Channel
 *     Divinity uses pool and whose effects link the template.
 * Then the use is re-triggered and dnd5e runs its NATIVE flow end to end: the
 * real Ability Use dialog (consumption box + checkbox — consuming only while
 * ticked), the usage card with the native EFFECTS section (live-listing
 * controlled tokens, per-row permission locks, apply arrow), and native
 * effect application. Items that already carry activities (e.g. the 2024
 * variant) are never touched.
 *
 * The applied curses inherit the template's module flag and carry an origin
 * pointing back to the caster's item — the Phase-2 feature timer uses both to
 * end every applied curse at the end of the caster's next turn.
 */

export const PTG_FLAG = "pathToTheGrave"; // flags[MODULE_ID][PTG_FLAG] = true on the template + applied curses

const isPathToTheGraveItem = (i) => i?.type === "feat"
  && (i.name?.toLowerCase() ?? "").includes("path to the grave");

/** An item's usable uses as numbers (max may be a formula string pre-prep). */
function usesOf(item) {
  const max = Number(item?.system?.uses?.max) || 0;
  const spent = Number(item?.system?.uses?.spent) || 0;
  return { max, spent, remaining: Math.max(0, max - spent) };
}

/**
 * The actor's Channel Divinity uses pool: a feat named "Channel Divinity"
 * (allowing suffixes like "Channel Divinity (Cleric)", but not the option
 * items, which use a colon), else the feature item itself when it carries its
 * own uses. Null if neither.
 */
function channelDivinityPool(actor, item) {
  const pool = actor?.items?.find(i => {
    if (i.type !== "feat") return false;
    const n = i.name?.toLowerCase() ?? "";
    if (n !== "channel divinity" && !n.startsWith("channel divinity (")) return false;
    return usesOf(i).max > 0;
  });
  if (pool) {
    dbg("dnd5e:path-to-the-grave-pool", pool.name, usesOf(pool));
    return pool;
  }
  if (usesOf(item).max > 0) {
    dbg("dnd5e:path-to-the-grave-pool", "item-own-uses", item?.name, usesOf(item));
    return item;
  }
  dbg("dnd5e:path-to-the-grave-pool", "none found");
  return null;
}

/**
 * dnd5e.preDisplayCard dispatch — the path a NO-activity item takes (Item5e#use
 * skips the activity pipeline entirely). First use: cancel the bare card, fix
 * the item up, and re-trigger; dnd5e then owns the whole flow. Items that
 * already have activities (fixed-up, or the 2024 variant) never reach this
 * path, so there is no loop: if the item somehow still displays a bare card
 * while carrying activities (e.g. none are usable because the pool is empty),
 * it passes through untouched.
 */
export function onPreDisplayPathToTheGraveCard(item, _messageConfig) {
  if (!isPathToTheGraveItem(item)) return true;
  if ((item.system?.activities?.size ?? 0) > 0) return true;
  fixUpAndUse(item).catch(err => console.error("combat-spell-timer | path to the grave fix-up failed", err));
  return false;
}

/**
 * dnd5e.preUseActivity dispatch — repair path for an activity that exists but
 * has NO linked effects (an item fixed up by an earlier module version, or a
 * hand-built activity): link the curse template so the card grows its native
 * EFFECTS section, then re-trigger. Activities that already link effects (a
 * fresh fix-up, the 2024 variant) pass straight through.
 */
export function onPreUsePathToTheGrave(activity, usageConfig) {
  if (!isPathToTheGraveItem(activity?.item)) return true;
  if (usageConfig?.cstPathToTheGrave) return true;
  if ((activity?.name ?? "").toLowerCase().includes("end curse")) return true;
  // Healthy = effects linked AND the template carries the current 1-round
  // duration (older module versions wrote 2 — migrate on the next use).
  const template = [...(activity.item.effects ?? [])].find(e => e.flags?.[MODULE_ID]?.[PTG_FLAG]);
  if (activity.effects?.length && template?.duration?.rounds === 1) return true;
  repairAndUse(activity).catch(err => console.error("combat-spell-timer | path to the grave repair failed", err));
  return false;
}

/** Link the curse template to an effect-less activity, then re-use it. */
async function repairAndUse(activity) {
  const item = activity.item;
  const template = await ensureCurseTemplate(item);
  if (template) {
    await item.update({ [`system.activities.${activity.id}.effects`]: [{ _id: template.id }] });
    dbg("dnd5e:path-to-the-grave-activity-repaired", item.name);
  }
  await item.system.activities.get(activity.id)?.use({ cstPathToTheGrave: true });
}

/**
 * One-time item fix-up: ensure the no-op curse template effect, add the use
 * activity (consumption → Channel Divinity pool; effects → the template),
 * then re-trigger the use so dnd5e's native dialog/card take over. Persisted
 * on the item, so subsequent uses are fully native; a ddb re-import simply
 * gets fixed up again on its next first use.
 * @param {Item5e} item
 */
async function fixUpAndUse(item) {
  const template = await ensureCurseTemplate(item);
  const pool = channelDivinityPool(item.actor, item);
  if (!pool) {
    ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.PathToTheGrave.NoPool", { name: item.name }));
  }
  const cls = CONFIG.DND5E?.activityTypes?.utility?.documentClass;
  if (!cls) return;
  const data = new cls({
    activation: { type: "action", value: 1 },
    consumption: pool ? {
      targets: [{ type: "itemUses", target: pool.id === item.id ? "" : pool.id, value: "1" }],
    } : {},
    effects: template ? [{ _id: template.id }] : [],
  }, { parent: item }).toObject();
  await item.update({ [`system.activities.${data._id}`]: data });
  dbg("dnd5e:path-to-the-grave-activity-created", item.name, pool?.name ?? "no pool");
  await item.use();
}

/**
 * The item's no-op curse template effect (created once, reused thereafter).
 * dnd5e clones it onto each target via the card's native apply flow; the
 * module flag survives the clone, which is what the Phase-2 sweep matches.
 * Any ddb-authored template (the 2014 "Cursed" with vulnerability changes) is
 * left alone and unlinked — the user wants a pure marker.
 * @param {Item5e} item
 * @returns {Promise<ActiveEffect|null>}
 */
async function ensureCurseTemplate(item) {
  const existing = [...(item.effects ?? [])].find(e => e.flags?.[MODULE_ID]?.[PTG_FLAG]);
  if (existing) {
    // Migrate templates created by earlier module versions (2-round display).
    if (existing.duration?.rounds !== 1) await existing.update({ "duration.rounds": 1 });
    return existing;
  }
  const [created] = await item.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.localize("COMBAT_SPELL_TIMER.PathToTheGrave.EffectName"),
    img: item.img,
    transfer: false,
    disabled: false,
    statuses: ["cst-path-to-the-grave"],
    description: `<p>${game.i18n.localize("COMBAT_SPELL_TIMER.PathToTheGrave.EffectDescription")}</p>`,
    changes: [],
    // "1 Round" display, matching the Cloak of Shadows convention; the feature
    // timer's end-of-next-turn sweep is the authoritative end (it DELETES the
    // applied copies), and this finite duration also marks them temporary
    // (token icon) and acts as the out-of-combat failsafe.
    duration: { rounds: 1 },
    flags: { [MODULE_ID]: { [PTG_FLAG]: true } },
  }]);
  dbg("dnd5e:path-to-the-grave-template-created", item.name);
  return created ?? null;
}

/**
 * Feature registry descriptor for Path to the Grave.
 *
 * Shape: caster-anchored, AE-less (effect: null). The curse lives on the
 * targets; the caster carries nothing (no module AE, no caster token icon) —
 * same pattern as Zealous Presence. The timer uses durationRounds: 2 so the
 * natural sentinel-prune (start of round+2) is only a failsafe; the
 * turnEnd.mode: "expire" policy ends it exactly at the end of the caster's
 * next turn.
 */
export default {
  id: "path-to-the-grave",
  label: "Path to the Grave",

  detect(activity) {
    if (!isPathToTheGraveItem(activity?.item)) return null;
    // The 2024 item has an "End Curse" activity — only the activation starts the clock.
    if ((activity?.name ?? "").toLowerCase().includes("end curse")) return null;
    const item = activity.item;
    // 2 owner-anchored rounds: survives THROUGH the caster's next turn; the
    // turnEnd "expire" policy ends it exactly at that turn's end, with natural
    // pruning (start of turn+2) as the failsafe.
    return { name: item.name, img: item.img, itemUuid: item.uuid, durationRounds: 2 };
  },

  // The curse lives on the TARGETS; the caster carries nothing (no module AE,
  // no caster token icon) — Zealous Presence pattern.
  effect: null,

  /**
   * Timer ended (turn-end expiry, manual remove, re-cast refresh, prune) →
   * remove every applied curse originating from this caster, wherever it is.
   */
  onRemove({ casterActorUuid }) {
    const caster = casterActorUuid ? fromUuidSync(casterActorUuid) : null;
    if (!caster) return;
    for (const actor of candidateActors()) {
      for (const effect of actor.effects ?? []) {
        if (!effect.flags?.[MODULE_ID]?.[PTG_FLAG]) continue;
        if (effectOriginActor(effect)?.uuid !== caster.uuid) continue;
        dbg("dnd5e:path-to-the-grave-remove", actor.name, effect.uuid);
        removeEffect(effect.uuid);
      }
    }
  },

  view: {
    anchorToOwner: true,
    icon: "fa-solid fa-skull",
    roundsLeftKey: "COMBAT_SPELL_TIMER.PathToTheGrave.RoundsLeft",
    removeLabelKey: "COMBAT_SPELL_TIMER.PathToTheGrave.EndLabel",
    turnEnd: { mode: "expire" },
  },
};
