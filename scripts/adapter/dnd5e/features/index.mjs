import rage from "./rage.mjs";

/** All registered features, keyed by id. Add new features here. */
const FEATURES = new Map([rage].map(f => [f.id, f]));

export function getFeature(id) { return id ? FEATURES.get(id) ?? null : null; }
export function listFeatures() { return [...FEATURES.values()]; }
