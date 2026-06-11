import { MODULE_ID } from "../../../module.mjs";

/**
 * Sentinel rounds duration stamped on feature AEs. Large enough that Foundry
 * v14's expiry registry never reaches (or "reframes" via an Infinity remaining)
 * it during play, so the module timer stays the sole authority on when the
 * feature ends. The real round count lives in the module flag; the actor-sheet
 * hook (effect-sheet.mjs) renders the live remaining in place of this value.
 */
export const FEATURE_SENTINEL_ROUNDS = 99999;

/**
 * Generic, feature-agnostic ActiveEffect machinery for the feature registry.
 * Generalizes Phase-1's Rage-specific builders so any registered feature can:
 *   - be detected as module-owned (by flag or its status id),
 *   - clone an effect off its source item (Tier 1) or build from hard-coded
 *     changes (Tier 2),
 *   - and be deleted by uuid or by scanning the actor.
 * The original feature/item effect is never mutated.
 */

/** The feature id a module-owned AE was stamped with, or null. */
export function moduleFeatureId(effect) {
  return effect?.flags?.[MODULE_ID]?.feature ?? null;
}

/**
 * The feature id an AE's lifetime is bound to (flags[MODULE_ID].boundFeature),
 * or null. Set on companion AEs that live and die with a feature's timer
 * (e.g. a Wild Surge marker bound to "rage") so displays mirror that timer.
 */
export function boundFeatureId(effect) {
  return effect?.flags?.[MODULE_ID]?.boundFeature ?? null;
}

/** True for any module-owned feature AE (optionally for a specific feature). */
export function isModuleEffect(effect, feature = null) {
  const fid = effect?.flags?.[MODULE_ID]?.feature;
  if (feature) return fid === feature.id || (feature.effect?.statusId && effect?.statuses?.has?.(feature.effect.statusId));
  return fid != null;
}

/** The actor's active module-owned AE for a feature, or null. */
export function findModuleEffect(actor, feature) {
  return [...(actor?.effects ?? [])].find(e => isModuleEffect(e, feature)) ?? null;
}

/** The actor's feat item matching a name or identifier (case-insensitive), or null. */
export function findFeat(actor, name, identifier) {
  return actor?.items?.find(i => i?.type === "feat"
    && (i.name?.toLowerCase() === name || i.system?.identifier?.toLowerCase() === identifier)) ?? null;
}

/** Overlay required markers: active, temporary (token icon), flagged, combat-bound duration. */
function withMarkers(base, feature, origin, durationRounds) {
  const statusId = feature.effect?.statusId;
  const statuses = [...new Set([...(base.statuses ?? []), ...(statusId ? [statusId] : [])])];
  return {
    name: base.name || feature.label || feature.id,
    img: base.img || feature.effect?.defaultIcon,
    changes: base.changes ?? [],
    statuses, disabled: false,
    // A finite rounds duration is required on Foundry v14: an effect marked
    // temporary (via the dnd5e.isTemporary flag) but with no finite duration ends
    // up with remaining === Infinity, which v14's ActiveEffectRegistry treats as
    // "expired" on the next world-time tick (it has a start but no duration.expiry)
    // — silently suppressing the effect after one turn. A large sentinel keeps it
    // active and unsuppressed for the whole feature; the module timer owns the
    // real expiry, and the actor-sheet hook shows the live remaining round count.
    duration: { rounds: FEATURE_SENTINEL_ROUNDS },
    origin: origin ?? undefined,
    flags: {
      ...(base.flags ?? {}),
      // Foundry v14's ActiveEffect.isTemporary is duration-only (ignores statuses),
      // so without this flag the effect could land in "Passive" and never show a
      // token / combat-tracker icon. `dnd5e.isTemporary` is dnd5e's sanctioned flag
      // to mark an effect temporary. Harmless on v13, where the status already makes
      // it temporary.
      dnd5e: { ...(base.flags?.dnd5e ?? {}), isTemporary: true },
      // Store the real round count so the actor-sheet hook can show the true
      // duration in place of the sentinel when no live timer is available.
      [MODULE_ID]: { feature: feature.id, durationRounds: durationRounds ?? null },
    },
  };
}

function findFeatureItem(actor, feature, itemUuid) {
  if (itemUuid) {
    const byUuid = fromUuidSync(itemUuid);
    if (byUuid?.documentName === "Item") return byUuid;
  }
  const names = new Set((feature.effect?.featNames ?? []).map(n => n.toLowerCase()));
  return actor?.items?.find(i => names.has(i.name?.toLowerCase?.() ?? "")) ?? null;
}

/** Tier-1 source: the effect to clone off the feature's item (prefer named-with-changes). */
function findSourceEffect(actor, feature, itemUuid) {
  const item = findFeatureItem(actor, feature, itemUuid);
  if (!item) return null;
  const effects = [...(item.effects ?? [])];
  if (!effects.length) return null;
  return effects.find(e => e.name?.toLowerCase() === item.name?.toLowerCase() && e.changes?.length)
      ?? effects.find(e => e.changes?.length) ?? effects[0];
}

/** Tier 1 (clone) → Tier 2 (hard-coded). Creates the AE on the actor; returns its uuid. */
export async function createFeatureEffect(actor, feature, { img, itemUuid, durationRounds } = {}) {
  if (!actor || !feature) return null;
  const source = findSourceEffect(actor, feature, itemUuid);
  const origin = itemUuid ?? source?.parent?.uuid ?? null;
  let base;
  if (source) {
    const s = source.toObject();
    base = { name: s.name, img: img || s.img, changes: s.changes ?? [], statuses: s.statuses ?? [], flags: s.flags ?? {} };
  } else {
    base = { name: feature.label, img, changes: feature.effect?.changes?.(actor) ?? [] };
  }
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [withMarkers(base, feature, origin, durationRounds)]);
  return effect?.uuid ?? null;
}

/**
 * Resolve the Actor an applied effect originates from, walking the origin
 * UUID through Item / Activity parents. Null when there is no origin or it
 * can't be resolved (e.g. a deleted source, or a world-item origin).
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
export function effectOriginActor(effect) {
  if (!effect?.origin) return null;
  let doc = null;
  try { doc = fromUuidSync(effect.origin); } catch { /* unresolved */ }
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  return doc.actor ?? (doc.parent?.documentName === "Actor" ? doc.parent : null);
}

/** Delete the module-owned AE by uuid, else by scanning the actor. */
export async function deleteFeatureEffect(feature, { casterActorUuid, effectUuid } = {}) {
  if (effectUuid) {
    const ae = await fromUuid(effectUuid).catch(() => null);
    if (ae) { await ae.delete(); return; }
  }
  const actor = casterActorUuid ? fromUuidSync(casterActorUuid) : null;
  if (!actor) return;
  // Delete every matching module AE, not just the first — a feature refresh or a
  // recovery from an earlier broken state can leave more than one behind.
  const ids = [...(actor.effects ?? [])].filter(e => isModuleEffect(e, feature)).map(e => e.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}
