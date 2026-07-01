import { dbg } from "../../utils/debug.mjs";
import { isWriter } from "../../core/socket.mjs";

/**
 * dnd5e senses -> token vision bridge.
 *
 * Base dnd5e does NOT sync an actor's `system.attributes.senses` onto its
 * tokens' vision: the senses value is only a character-sheet/rules figure,
 * while a token actually "sees" via its own per-token `detectionModes` array.
 * The two are completely decoupled (confirmed against dnd5e 5.3.3 — the only
 * `detectionModes` writes in the system are the polymorph/transform paths and
 * the one-time registration of the blindsight mode). So an ActiveEffect that
 * adds e.g. `system.attributes.senses.blindsight +10` (our Blind Fighting
 * fighting style) updates the sheet but leaves every token blind.
 *
 * This module closes that gap the same way a dedicated vision module would:
 * whenever an actor's derived senses could have changed, it recomputes the
 * detection modes those senses imply and writes them onto the actor's
 * prototype token (so future placements are correct) AND every already-placed
 * token across every scene (so existing tokens update live). Only the
 * detection modes we manage are touched — any other modes on the token
 * (basicSight, lightPerception, a manually-added darkvision, etc.) are left
 * untouched. GM-only; player clients no-op.
 *
 * Only the "pure detection mode" senses are handled here. Darkvision is
 * deliberately excluded — it's a vision-mode + sight.range concern, not a
 * detection mode, and conflating it risks clobbering a token's normal sight.
 */

/**
 * dnd5e sense key -> Foundry detection-mode id. `blindsight` is registered by
 * dnd5e itself; `feelTremor` / `seeAll` are core. Matches ddb-importer's own
 * senses->detection map.
 */
const SENSE_DETECTION_MODES = {
  blindsight: "blindsight",
  tremorsense: "feelTremor",
  truesight: "seeAll",
};

/** The detection-mode ids this bridge owns (and is therefore allowed to add/remove). */
const MANAGED_MODE_IDS = new Set(Object.values(SENSE_DETECTION_MODES));

/** True when an effect change targets the senses subtree (flat or `.ranges.` form). */
function changeAffectsSenses(change) {
  return String(change?.key ?? "").startsWith("system.attributes.senses.");
}

/** True when any of the effect's changes touch senses. */
function effectAffectsSenses(effect) {
  return (effect?.changes ?? []).some(changeAffectsSenses);
}

/** True when any of the item's (transfer) effects touch senses. */
function itemAffectsSenses(item) {
  return (item?.effects ?? []).some(effectAffectsSenses);
}

/** Resolve the owning actor of an effect, whether it lives on the Actor or on one of its Items. */
function actorOfEffect(effect) {
  const p = effect?.parent;
  if (!p) return null;
  if (p.documentName === "Actor") return p;
  if (p.documentName === "Item") return p.actor ?? null;
  return null;
}

/**
 * The managed detection modes implied by an actor(-like)'s derived senses:
 * a map of detection-mode id -> range (in scene distance units). Only senses
 * with a positive range are included.
 * @param {Actor|Actor5e} actor
 * @returns {Record<string, number>}
 */
function computeManagedModes(actor) {
  const ranges = actor?.system?.attributes?.senses?.ranges ?? {};
  const managed = {};
  for (const [sense, modeId] of Object.entries(SENSE_DETECTION_MODES)) {
    const r = ranges[sense];
    if (typeof r === "number" && r > 0) managed[modeId] = r;
  }
  return managed;
}

/**
 * Normalize a document's detectionModes to a flat array of {id, enabled, range},
 * regardless of the two Foundry storage shapes:
 *  - Foundry 13: `ArrayField` -> already an array of {id, enabled, range}.
 *  - Foundry 14: `TypedObjectField` -> a keyed object {id: {enabled, range}}.
 * @param {Array|object|null} modes
 * @returns {Array<{id:string,enabled:boolean,range:number|null}>}
 */
function readModes(modes) {
  if (!modes) return [];
  if (Array.isArray(modes)) return modes.map((m) => ({ id: m.id, enabled: m.enabled, range: m.range }));
  return Object.entries(modes).map(([id, m]) => ({ id, enabled: m?.enabled, range: m?.range }));
}

/**
 * A forced-deletion operator for a TypedObjectField key. Only ever reached on
 * Foundry 14 (the only version whose detectionModes is object-shaped), where
 * `foundry.data.operators.ForcedDeletion` exists — so no version guard needed.
 */
function detectionDeletion() {
  return new foundry.data.operators.ForcedDeletion();
}

/**
 * Merge managed detection modes into an existing (v13-array) set without
 * disturbing modes we don't own: granted managed modes are set to their range
 * (enabled); revoked managed modes are dropped; unmanaged modes pass through.
 */
function mergeManagedArray(existing, managed) {
  const out = [];
  const seen = new Set();
  for (const dm of existing) {
    if (MANAGED_MODE_IDS.has(dm.id)) {
      if (dm.id in managed) {
        out.push({ id: dm.id, enabled: true, range: managed[dm.id] });
        seen.add(dm.id);
      }
      // else: this managed sense is no longer granted — drop the mode.
    } else {
      out.push({ id: dm.id, enabled: dm.enabled, range: dm.range });
    }
  }
  for (const [id, range] of Object.entries(managed)) {
    if (!seen.has(id)) out.push({ id, enabled: true, range });
  }
  return out;
}

/** Order-insensitive equality for two normalized detectionModes arrays. */
function modesEqual(a, b) {
  if (a.length !== b.length) return false;
  const norm = (arr) => arr.map((m) => `${m.id}:${m.enabled ? 1 : 0}:${m.range ?? ""}`).sort();
  const na = norm(a);
  const nb = norm(b);
  return na.every((v, i) => v === nb[i]);
}

/**
 * Compute the value to write to a document's `detectionModes` so it reflects
 * `managed`, in the shape the running Foundry expects. Returns the update value
 * (a full array on v13, a partial merge/delete patch on v14) or null when no
 * detection-mode change is needed.
 * @param {Array|object|null} rawModes  The document's current detectionModes.
 * @param {Record<string, number>} managed
 */
function buildDetectionModesUpdate(rawModes, managed) {
  const current = readModes(rawModes);

  // Foundry 13 — ArrayField: arrays replace wholesale, so emit the full set.
  if (Array.isArray(rawModes)) {
    const next = mergeManagedArray(current, managed);
    return modesEqual(current, next) ? null : next;
  }

  // Foundry 14 — TypedObjectField: updates merge by key, so only touch the
  // managed keys (grant/update -> {enabled, range}; revoke -> ForcedDeletion).
  const currentById = new Map(current.map((m) => [m.id, m]));
  const patch = {};
  let changed = false;
  for (const id of MANAGED_MODE_IDS) {
    const range = managed[id];
    const existing = currentById.get(id);
    if (range != null) {
      if (!existing || existing.enabled !== true || existing.range !== range) {
        patch[id] = { enabled: true, range };
        changed = true;
      }
    } else if (existing) {
      patch[id] = detectionDeletion();
      changed = true;
    }
  }
  return changed ? patch : null;
}

/**
 * Plan a vision update for a source carrying `detectionModes` + `sight`.
 * Returns `{ detectionModes, enableSight }` (detectionModes null when only the
 * sight-enable flag needs to change) or null when nothing needs to change.
 */
function planVisionUpdate(rawModes, sightEnabled, managed) {
  const detectionModes = buildDetectionModesUpdate(rawModes, managed);
  // Detection modes only function when the token actually has vision enabled.
  const enableSight = Object.keys(managed).length > 0 && !sightEnabled;
  if (detectionModes === null && !enableSight) return null;
  return { detectionModes, enableSight };
}

/** Sync the actor's prototype token so future placements carry the right vision. */
async function syncPrototypeToken(actor) {
  const proto = actor.prototypeToken;
  const plan = planVisionUpdate(proto.detectionModes, proto.sight?.enabled, computeManagedModes(actor));
  if (!plan) return;
  const update = {};
  if (plan.detectionModes !== null) update["prototypeToken.detectionModes"] = plan.detectionModes;
  if (plan.enableSight) update["prototypeToken.sight.enabled"] = true;
  dbg("dnd5e:vision:proto", actor.name, update);
  await actor.update(update);
}

/** Sync a single placed token, using its own (possibly delta-adjusted) senses. */
async function syncPlacedToken(tokenDoc, baseActor) {
  const tActor = tokenDoc.actor ?? baseActor;
  const plan = planVisionUpdate(tokenDoc.detectionModes, tokenDoc.sight?.enabled, computeManagedModes(tActor));
  if (!plan) return;
  const update = {};
  if (plan.detectionModes !== null) update.detectionModes = plan.detectionModes;
  if (plan.enableSight) update["sight.enabled"] = true;
  dbg("dnd5e:vision:token", tokenDoc.parent?.name, tokenDoc.name, update);
  await tokenDoc.update(update);
}

/**
 * Bring an actor's prototype token and all of its placed tokens (every scene)
 * in line with its current derived senses. GM-only.
 * @param {Actor} actor
 */
async function syncActorVision(actor) {
  if (!actor) return;
  if (!isWriter()) { dbg("dnd5e:vision", "skip — not active GM", actor?.name); return; }
  await syncPrototypeToken(actor);
  for (const scene of game.scenes ?? []) {
    for (const tokenDoc of scene.tokens ?? []) {
      if (tokenDoc.actorId !== actor.id) continue;
      await syncPlacedToken(tokenDoc, actor);
    }
  }
}

/**
 * Register the senses -> token-vision bridge. Recomputes on any change that
 * could alter derived senses: a direct senses edit (updateActor), a
 * sense-granting item gained/lost/edited (create/delete/updateItem — e.g. the
 * Blind Fighting feat's transfer effect), or a sense-granting effect applied
 * directly to the actor (create/update/deleteActiveEffect). Each handler is
 * gated so the full-scene scan only runs for genuinely sense-relevant changes,
 * and syncActorVision itself no-ops per document when nothing differs.
 * Call once during setup.
 */
export function registerVisionSyncHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.attributes.senses")) return;
    dbg("dnd5e:vision:updateActor", actor.name);
    syncActorVision(actor);
  });

  for (const hook of ["createItem", "deleteItem", "updateItem"]) {
    Hooks.on(hook, (item) => {
      if (!item.actor || !itemAffectsSenses(item)) return;
      dbg(`dnd5e:vision:${hook}`, item.actor.name, item.name);
      syncActorVision(item.actor);
    });
  }

  for (const hook of ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect"]) {
    Hooks.on(hook, (effect) => {
      if (!effectAffectsSenses(effect)) return;
      const actor = actorOfEffect(effect);
      if (!actor) return;
      dbg(`dnd5e:vision:${hook}`, actor.name, effect.name);
      syncActorVision(actor);
    });
  }
}
