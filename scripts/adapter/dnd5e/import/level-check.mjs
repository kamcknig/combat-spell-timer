/** A feature is allowed at a given class level when requiredLevel ≤ level. */
export function featureMeetsLevel(requiredLevel, classLevel) {
  const req = Number.parseInt(requiredLevel);
  return !Number.isInteger(req) || req <= Number(classLevel ?? 0);
}

/**
 * Split granted DDB features into {kept, skipped} by class level.
 * @param {Array<{definition:object}>} features  classFeatures[]
 * @param {number} classLevel
 */
export function filterByLevel(features, classLevel) {
  const kept = [], skipped = [];
  for (const f of features ?? []) {
    (featureMeetsLevel(f?.definition?.requiredLevel, classLevel) ? kept : skipped).push(f);
  }
  return { kept, skipped };
}

/**
 * Future manual-add guard: can this actor receive a feature requiring `requiredLevel`
 * in the class identified by `classIdentifier`? Reads the actor's existing class item.
 * @returns {{ok:boolean, have:number, need:number}}
 */
export function canActorReceiveFeature(actor, classIdentifier, requiredLevel) {
  const cls = actor?.items?.find((i) => i.type === "class" && i.system?.identifier === classIdentifier);
  const have = cls?.system?.levels ?? 0;
  const need = Number.parseInt(requiredLevel) || 0;
  return { ok: have >= need, have, need };
}
