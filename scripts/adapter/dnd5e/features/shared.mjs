import { MODULE_ID } from "../../../module.mjs";

/**
 * Generic, feature-agnostic ActiveEffect machinery for the feature registry.
 * Generalizes Phase-1's Rage-specific builders so any registered feature can:
 *   - be detected as module-owned (by flag or its status id),
 *   - clone an effect off its source item (Tier 1) or build from hard-coded
 *     changes (Tier 2),
 *   - and be deleted by uuid or by scanning the actor.
 * The original feature/item effect is never mutated.
 */

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

/** Overlay required markers: active, temporary (token icon), flagged, no self-expiry. */
function withMarkers(base, feature, origin) {
  const statusId = feature.effect?.statusId;
  const statuses = [...new Set([...(base.statuses ?? []), ...(statusId ? [statusId] : [])])];
  return {
    name: base.name || feature.label || feature.id,
    img: base.img || feature.effect?.defaultIcon,
    changes: base.changes ?? [],
    statuses, disabled: false, duration: {},
    origin: origin ?? undefined,
    flags: {
      ...(base.flags ?? {}),
      // Foundry v14's ActiveEffect.isTemporary is duration-only (ignores statuses),
      // so a no-duration effect would land in "Passive" and never show a token /
      // combat-tracker icon. `dnd5e.isTemporary` is dnd5e's sanctioned flag to mark
      // an effect temporary without a self-expiring duration (the module timer owns
      // expiry). Harmless on v13, where the status already makes it temporary.
      dnd5e: { ...(base.flags?.dnd5e ?? {}), isTemporary: true },
      [MODULE_ID]: { feature: feature.id },
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
export async function createFeatureEffect(actor, feature, { img, itemUuid } = {}) {
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
  const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [withMarkers(base, feature, origin)]);
  return effect?.uuid ?? null;
}

/** Delete the module-owned AE by uuid, else by scanning the actor. */
export async function deleteFeatureEffect(feature, { casterActorUuid, effectUuid } = {}) {
  if (effectUuid) {
    const ae = await fromUuid(effectUuid).catch(() => null);
    if (ae) { await ae.delete(); return; }
  }
  const actor = casterActorUuid ? fromUuidSync(casterActorUuid) : null;
  if (!actor) return;
  const ae = findModuleEffect(actor, feature);
  if (ae) await ae.delete();
}
