import SystemAdapter from "../SystemAdapter.mjs";
import { durationToRounds } from "./duration.mjs";
import { getFeature, listFeatures } from "./features/index.mjs";
import { createFeatureEffect, deleteFeatureEffect, findModuleEffect, moduleFeatureId, boundFeatureId } from "./features/shared.mjs";
import { dbg } from "../../utils/debug.mjs";
import { onStatusEndedEffects } from "./features/status-ended-effects.mjs";

export default class Dnd5eAdapter extends SystemAdapter {
  static SYSTEM_ID = "dnd5e";

  /**
   * Detect trackable spell casts via dnd5e.postUseActivity and emit a
   * NormalizedCast for each. Only spells, only finite time durations, only
   * when the caster is a combatant in the active combat.
   * @param {(record: import("../SystemAdapter.mjs").NormalizedCast) => void} onCast
   */
  registerCastDetection(onCast) {
    Hooks.on("dnd5e.postUseActivity", (activity, _usageConfig, results) => {
      const item = activity?.item;
      const actor = activity?.actor;
      if (item?.type !== "spell" || !actor) return;

      const durationRounds = durationToRounds(activity.duration ?? item.system?.duration);
      if (!durationRounds) return; // not a finite time duration

      // NOTE: combat membership is resolved in CORE (onSpellCast), which adds the
      // timer to EVERY started combat the caster is in. The adapter stays free of
      // combat logic — it only detects a trackable spell cast.

      // Capture the concentration effect (if any) for precise early removal.
      const concStatus = CONFIG.specialStatusEffects?.CONCENTRATING;
      const concEffect = results?.effects?.find(e => e.statuses?.has?.(concStatus));

      const castRecord = {
        name: item.name,
        img: item.img,
        casterActorUuid: actor.uuid,
        durationRounds,
        concentration: !!concEffect || !!activity.duration?.concentration,
        spellUuid: item.uuid,
        spellLevel: item.system?.level,
        concentrationEffectUuid: concEffect?.uuid ?? null
      };
      dbg("dnd5e:cast", castRecord.name, `${castRecord.durationRounds}r`, castRecord.concentration ? "conc" : "");
      onCast(castRecord);
    });
  }

  /**
   * Remove a timer when the caster's concentration ends. dnd5e fires
   * `dnd5e.endConcentration(actor, effect)`; we match the timer by the
   * concentration effect uuid captured at cast time.
   * @param {(query: object) => void} onEarlyRemove
   */
  registerEarlyRemoval(onEarlyRemove) {
    Hooks.on("dnd5e.endConcentration", (_actor, effect) => {
      if (!effect?.uuid) return;
      dbg("dnd5e:end-concentration", effect.uuid);
      onEarlyRemove({ concentrationEffectUuid: effect.uuid });
    });
  }

  /**
   * When a concentration spell timer is manually removed, delete the
   * concentration AE so the actor is no longer concentrating. Deleting the AE
   * fires dnd5e.endConcentration, which cleans up any remaining timer records
   * in other combats. For feature timers, delete the feature's module-owned AE.
   * @param {object} record
   */
  onManualRemove(record) {
    const f = getFeature(record.type);
    if (f) {
      this.removeFeatureEffect({ featureId: f.id, casterActorUuid: record.casterActorUuid, effectUuid: record.effectUuid });
      return;
    }
    if (!record.concentrationEffectUuid) return;
    fromUuid(record.concentrationEffectUuid).then(e => e?.delete());
  }

  /**
   * When a timer expires naturally (rounds elapsed), drop concentration so the
   * actor's inventory spinner and status icon are cleared. Same AE deletion as
   * onManualRemove; dnd5e.endConcentration will cascade to remove any remaining
   * timer records in other combats. For feature timers, delete the module-owned AE.
   * @param {object} record
   */
  onTimerExpired(record) {
    const f = getFeature(record.type);
    if (f) {
      this.removeFeatureEffect({ featureId: f.id, casterActorUuid: record.casterActorUuid, effectUuid: record.effectUuid });
      return;
    }
    if (!record.concentrationEffectUuid) return;
    fromUuid(record.concentrationEffectUuid).then(e => e?.delete());
  }

  /**
   * Check whether the actor is already concentrating on a trackable spell.
   * Resolves the concentration AE's origin — which may be an Activity (dnd5e
   * 5.x) or an Item directly — to get the spell's name, image, and duration.
   * @param {Actor} actor
   * @returns {Promise<import("../SystemAdapter.mjs").NormalizedCast|null>}
   */
  async getExistingSpell(actor) {
    const concStatus = CONFIG.specialStatusEffects?.CONCENTRATING;
    const effect = actor?.effects?.find(e => e.statuses?.has?.(concStatus));
    if (!effect?.origin) return null;

    const origin = await fromUuid(effect.origin).catch(() => null);
    if (!origin) return null;

    // origin may be an Activity (dnd5e 5.x) with .item, or a spell Item directly
    let item;
    if (origin.documentName === "Item" && origin.type === "spell") item = origin;
    else if (origin.item?.type === "spell") item = origin.item;
    else return null;

    const durationRounds = durationToRounds(item.system?.duration);
    if (!durationRounds) return null;

    dbg("dnd5e:existing-spell", item.name, `${durationRounds}r`);
    return {
      name: item.name,
      img: item.img,
      casterActorUuid: actor.uuid,
      durationRounds,
      concentration: true,
      spellUuid: item.uuid,
      spellLevel: item.system?.level ?? null,
      concentrationEffectUuid: effect.uuid
    };
  }

  /**
   * Cast a spell by name at a chosen slot level, consuming the slot. Mirrors what
   * dnd5e does from the sheet: pick the spell's first usable activity and call
   * Activity#use with the slot pre-selected and the usage dialog suppressed.
   * Level 0 (cantrip) consumes no slot. Routing through the normal cast path means
   * dnd5e fires `dnd5e.postUseActivity`, so this module's own cast detection adds
   * a combat timer automatically — no extra wiring, no duplicate cast.
   * @param {Actor} actor
   * @param {{name: string, level: number}} spec
   * @returns {Promise<object|null>} Activity usage results, or null if nothing was cast.
   */
  async castSpell(actor, { name, level }) {
    const spell = actor?.items?.find(i => i.type === "spell" && i.name === name);
    if (!spell) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.Beyond20.SpellNotFound",
        { name, actor: actor?.name ?? "" }));
      return null;
    }

    // The same activity dnd5e itself would use: the first one flagged canUse.
    // Calling the activity directly avoids the ActivityChoiceDialog that
    // item.use() can pop when a spell has more than one usable activity.
    const activity = spell.system.activities?.filter(a => a.canUse)?.[0];
    if (!activity) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.Beyond20.NoActivity", { name }));
      return null;
    }

    const baseLevel = spell.system.level ?? 0;
    const isCantrip = baseLevel === 0;
    // Never cast below the spell's printed level (defensive against a bad parse).
    const slotLevel = Math.max(level, baseLevel || 1);

    // Cantrips have no slot to spend → empty config. Otherwise draw from the
    // chosen leveled slot; dnd5e derives `scaling` from the slot's level itself.
    let usage = {};
    if (!isCantrip) {
      let slot = `spell${slotLevel}`;
      // Best-effort warlock support: if the actor has no leveled slot of this
      // level but their pact slots sit at it, spend pact magic instead.
      const slots = actor.system?.spells ?? {};
      if (!(slots[slot]?.value > 0) && slots.pact?.value > 0 && (slots.pact?.level ?? 0) === slotLevel) {
        slot = "pact";
      }
      usage = { spell: { slot }, consume: { spellSlot: true } };
    }

    dbg("dnd5e:beyond20-cast", name, isCantrip ? "cantrip" : `slot ${slotLevel}`);
    // dialog { configure:false } → no usage dialog; slot/level come straight from
    // `usage`. A falsy return means dnd5e declined to cast (e.g. no slots).
    return (await activity.use(usage, { configure: false })) ?? null;
  }

  /**
   * Activate a feat/trait the actor owns, by name, exactly as using it from the
   * sheet would: dnd5e shows its own dialog(s) and applies the effect. Used for
   * Beyond20 traits the module does not manage itself (e.g. Bolstering Magic).
   * Matches by item name or identifier (case-insensitive). Returns the use result,
   * or null if the feat isn't on the actor.
   * @param {Actor} actor
   * @param {{name: string}} spec
   * @returns {Promise<object|null>}
   */
  async useFeature(actor, { name }) {
    const n = name?.toLowerCase() ?? "";
    const ident = n.replace(/\s+/g, "-");
    const item = actor?.items?.find(i => i.type === "feat"
      && (i.name?.toLowerCase() === n || i.system?.identifier?.toLowerCase() === ident));
    if (!item) {
      ui.notifications?.warn(game.i18n.format("COMBAT_SPELL_TIMER.Beyond20.FeatureNotFound",
        { name, actor: actor?.name ?? "" }));
      return null;
    }
    dbg("dnd5e:beyond20-use-feature", item.name, actor.name);
    // No usage/dialog options → dnd5e runs the item's normal activation: the
    // benefit-choice dialog appears and the chosen effect is applied. The module
    // adds no timer of its own here.
    return (await item.use()) ?? null;
  }

  /**
   * Detect feature activations via dnd5e.postUseActivity and emit a start record
   * for each registered feature that recognizes the used activity. All edition /
   * level / naming logic lives in the feature descriptor's `detect`. Every
   * activity use is also dispatched to the optional descriptor hook
   * `onActivityUse(activity)`, for features that react to companion-item
   * activities without starting a timer (e.g. Wild Surge marker effects).
   * @param {(record: object) => void} onFeature
   */
  registerFeatureDetection(onFeature) {
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      const actor = activity?.actor;
      if (!actor) return;
      for (const f of listFeatures()) {
        f.onActivityUse?.(activity);
        const rec = f.detect?.(activity);
        if (!rec) continue;
        dbg("dnd5e:feature", f.id, actor.name, `${rec.durationRounds}r`);
        onFeature({ featureId: f.id, casterActorUuid: actor.uuid, ...rec });
      }
    });
  }

  /**
   * End a feature early when a just-created AE matches the feature's early-end
   * policy (e.g. unconscious/incapacitated for Rage), by listening to
   * createActiveEffect on all clients. Also dispatches status-ended effects
   * (e.g. Twilight Emanation on incapacitated) via onStatusEndedEffects.
   * @param {(query: object) => void} onEarlyEnd
   */
  registerFeatureEarlyEnd(onEarlyEnd) {
    Hooks.on("createActiveEffect", (effect, _options, userId) => {
      const actor = effect.parent;
      if (!actor) return;
      // Rules-bound effects that end when their bearer gains a status
      // (e.g. Twilight Emanation on incapacitated).
      onStatusEndedEffects(effect, userId);
      for (const f of listFeatures()) {
        if (!f.endsEarlyOnEffect?.(effect, actor)) continue;
        dbg("dnd5e:feature-early-end", f.id, actor.name);
        onEarlyEnd({ featureId: f.id, casterActorUuid: actor.uuid });
      }
    });
  }

  /**
   * Run a feature's cleanup when its module-owned AE is deleted by ANY path
   * (turn-end End, expiry, manual remove, early-end, re-start refresh, or the
   * user deleting the AE from the sheet). The hook fires on all clients; only
   * the initiating client acts — it performed the AE delete, so it has owner
   * permission for any companion-document cleanup too.
   */
  registerFeatureCleanup() {
    Hooks.on("deleteActiveEffect", (effect, _options, userId) => {
      if (userId !== game.user.id) return;
      const actor = effect.parent;
      if (actor?.documentName !== "Actor") return;
      const f = getFeature(moduleFeatureId(effect));
      if (!f?.onEffectDeleted) return;
      dbg("dnd5e:feature-effect-deleted", f.id, actor.name);
      f.onEffectDeleted(actor, effect);
    });
  }

  /**
   * Create the module-owned ActiveEffect for a feature on the actor (tiered:
   * clone the feature's source effect, else hard-coded changes). Returns its UUID.
   * @param {Actor} actor
   * @param {string} featureId
   * @param {{img?:string, itemUuid?:string}} opts
   * @returns {Promise<string|null>}
   */
  async applyFeatureEffect(actor, featureId, opts) {
    const f = getFeature(featureId);
    if (!f) return null;
    // Feature-specific start hook — may prompt the user (e.g. Form of the Beast
    // form selection) and add companion documents before the AE exists.
    await f.onStart?.(actor, opts);
    // Features with no module-owned AE (effect: null) — e.g. Zealous Presence,
    // whose effect lives on OTHER actors — are tracked by their timer row only.
    if (!f.effect) return null;
    const uuid = await createFeatureEffect(actor, f, opts);
    dbg("dnd5e:feature-create-ae", f.id, actor?.name, uuid);
    return uuid;
  }

  /**
   * Delete a feature's module-owned AE during early-end / cleanup.
   * @param {{featureId?:string, casterActorUuid?:string, effectUuid?:string}} query
   */
  async removeFeatureEffect({ featureId, casterActorUuid, effectUuid } = {}) {
    const f = getFeature(featureId);
    if (!f) return;
    await deleteFeatureEffect(f, { casterActorUuid, effectUuid });
    // Feature-specific end cleanup (e.g. sweep effects the feature applied to
    // OTHER actors). Runs on whichever client performs the removal — expiry on
    // the GM, manual remove on the remover; early-end paths can invoke it on
    // several clients, so implementations must be idempotent.
    await f.onRemove?.({ casterActorUuid, effectUuid });
  }

  /**
   * Remove an applied effect from the combatant panel. If the effect was placed
   * by a concentration spell, end the caster's concentration instead of just
   * deleting the effect — that clears the caster's concentration status and
   * cascades to remove this (and any sibling target) effects, matching how a
   * concentration spell timer's removal behaves.
   * @param {string} effectUuid
   */
  async removeAppliedEffect(effectUuid) {
    const effect = await fromUuid(effectUuid).catch(() => null);
    if (!effect) return;
    const conc = this.#concentrationFor(effect);
    if (conc?.parent?.endConcentration) {
      // Ending concentration deletes the concentration effect and cascades to its
      // dependent target effects (including this one) — don't also delete it here,
      // or we race that cascade and hit "ActiveEffect does not exist".
      await conc.parent.endConcentration(conc);
      return;
    }
    await effect.delete();
  }

  /**
   * The module timer whose countdown an applied effect should mirror.
   * A concentration spell's timer records the caster's concentration-effect uuid
   * in `concentrationEffectUuid`. dnd5e tags both that concentration effect (its
   * own uuid) and every target effect it applies (`flags.dnd5e.dependentOn`) with
   * that uuid — so a single equality check links the icon to the spell row's
   * clock for the caster and all targets. Non-concentration applied effects fall
   * back to matching their spell item via `origin` (Item uuid, or `<itemUuid>.Activity.<id>`).
   * Effects whose lifetime mirrors a feature (`flags[MODULE_ID].boundFeature`,
   * e.g. a Wild Surge marker bound to "rage") resolve to the actor's timer for
   * that feature, so they never fall back to their sentinel AE duration.
   * @param {ActiveEffect} effect
   * @param {object[]} timers
   * @returns {object|null}
   */
  getEffectTimer(effect, timers) {
    const bound = boundFeatureId(effect);
    if (bound) {
      const actorUuid = effect.parent?.uuid;
      const byBound = timers.find(t => t.type === bound && t.casterActorUuid === actorUuid);
      if (byBound) return byBound;
    }
    const concKey = effect?.flags?.dnd5e?.dependentOn ?? effect?.uuid ?? null;
    if (concKey) {
      const byConc = timers.find(t => t.concentrationEffectUuid && t.concentrationEffectUuid === concKey);
      if (byConc) return byConc;
    }
    const origin = effect?.origin;
    if (origin) {
      const bySpell = timers.find(t => t.spellUuid && (origin === t.spellUuid || origin.startsWith(`${t.spellUuid}.`)));
      if (bySpell) return bySpell;
    }
    return null;
  }

  /**
   * Bring a spell's applied effects into line after its timer's rounds changed:
   * set the caster's concentration effect AND each of its dependent target effects
   * to `rounds` remaining, so an extended spell's icons don't self-expire at the
   * original duration. Feature timers keep their sentinel-duration AE (it never
   * self-expires — the timer alone drives the count), so this is a no-op for them.
   * @param {object} timer
   * @param {number} rounds
   */
  async setTimerEffectRounds(timer, rounds) {
    if (timer.type || !timer.concentrationEffectUuid) return; // feature, or non-concentration spell
    const conc = await fromUuid(timer.concentrationEffectUuid).catch(() => null);
    if (!conc) return;
    const effects = [conc, ...(conc.getDependents?.() ?? [])].filter(e => e?.documentName === "ActiveEffect");
    const combat = game.combat;
    const update = {
      "duration.startRound": combat?.round ?? null,
      "duration.startTurn": combat?.turn ?? 0,
      "duration.rounds": rounds,
      "duration.seconds": null,
    };
    for (const e of effects) await e.update(update).catch(() => {});
  }

  /**
   * The caster's concentration effect that applied `effect`, or null when the
   * effect isn't concentration-applied. Matches by the concentrated item (a
   * concentration effect always records its item) and, as a fallback, by the
   * dependents the concentration effect lists. Deliberately does NOT guess from a
   * lone concentration — an unrelated effect must not end the caster's spell.
   * @param {ActiveEffect} effect
   * @returns {ActiveEffect|null}
   */
  #concentrationFor(effect) {
    const caster = this.#casterOf(effect);
    const effects = caster?.concentration?.effects;
    if (!effects?.size) return null;
    const itemId = this.#originItemId(effect);
    const concItemId = (ce) => { const i = ce.getFlag("dnd5e", "item"); return i?.id ?? i?.data?._id ?? null; };
    return (itemId ? [...effects].find(ce => concItemId(ce) === itemId) : null)
      ?? [...effects].find(ce => ce.getDependents?.().some(d => d?.uuid === effect.uuid))
      ?? null;
  }

  /**
   * Resolve the Actor an effect originates from, via its origin (Item/Activity/Actor).
   * @param {ActiveEffect} effect
   * @returns {Actor|null}
   */
  #casterOf(effect) {
    const doc = this.#originDoc(effect);
    if (!doc) return null;
    if (doc.documentName === "Actor") return doc;
    return doc.actor ?? (doc.parent?.documentName === "Actor" ? doc.parent : null);
  }

  /**
   * The Item id behind an effect's origin (the spell/feature item), via an Item
   * or Activity origin, or null.
   * @param {ActiveEffect} effect
   * @returns {string|null}
   */
  #originItemId(effect) {
    const doc = this.#originDoc(effect);
    if (!doc) return null;
    if (doc.documentName === "Item") return doc.id;
    return doc.item?.id ?? null; // Activity → its parent item
  }

  /** Resolve an effect's origin document, or null. */
  #originDoc(effect) {
    if (!effect?.origin) return null;
    try { return fromUuidSync(effect.origin) ?? null; } catch { return null; }
  }

  /**
   * Every registered feature the actor currently has an active module-owned AE
   * for. Returns { featureId, name, img, effectUuid } records (empty if none).
   * @param {Actor} actor
   * @returns {Promise<object[]>}
   */
  async getExistingFeatures(actor) {
    const out = [];
    for (const f of listFeatures()) {
      const e = findModuleEffect(actor, f);
      if (e) out.push({ featureId: f.id, name: e.name, img: e.img, effectUuid: e.uuid });
    }
    return out;
  }

  /**
   * The system-agnostic presentation/policy view for a feature, or null.
   * @param {string} featureId
   * @returns {import("../SystemAdapter.mjs").FeatureView|null}
   */
  getFeatureView(featureId) { return getFeature(featureId)?.view ?? null; }

  /**
   * Build a feature start record from just an actor (no activity), e.g. for the
   * Beyond20 "start by name" path. Null if the feature is unknown.
   * @param {Actor} actor
   * @param {string} featureId
   * @returns {object|null}
   */
  getFeatureStartRecord(actor, featureId) {
    const f = getFeature(featureId);
    const rec = f?.fromActor?.(actor);
    return rec ? { featureId, casterActorUuid: actor.uuid, ...rec } : null;
  }

  /**
   * Distinct dnd5e spell names from world items and every Item compendium, sorted
   * for display. Used for the spell-mapping editor's autocompletion list. Requests
   * the `type` field in the pack index so spells can be filtered without loading
   * full documents.
   * @returns {Promise<string[]>}
   */
  async listSpellNames() {
    const names = new Set();
    for (const item of game.items ?? []) {
      if (item.type === "spell") names.add(item.name);
    }
    for (const pack of game.packs ?? []) {
      if (pack.metadata?.type !== "Item") continue;
      try {
        const index = await pack.getIndex({ fields: ["type"] });
        for (const entry of index) if (entry.type === "spell") names.add(entry.name);
      } catch (err) {
        dbg("dnd5e:list-spell-names:pack-failed", pack.collection, err);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }
}
