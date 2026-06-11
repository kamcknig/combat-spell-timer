import rage from "./rage.mjs";
import zealousPresence from "./zealous-presence.mjs";
import pathToTheGrave from "./path-to-the-grave.mjs";

/** All registered features, keyed by id. Add new features here. */
const FEATURES = new Map([rage, zealousPresence, pathToTheGrave].map(f => [f.id, f]));

export function getFeature(id) { return id ? FEATURES.get(id) ?? null : null; }
export function listFeatures() { return [...FEATURES.values()]; }
