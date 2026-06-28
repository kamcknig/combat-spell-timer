import rage from "./rage.mjs";
import zealousPresence from "./zealous-presence.mjs";
import pathToTheGrave from "./path-to-the-grave.mjs";
import symbioticEntity from "./symbiotic-entity.mjs";
import wrathOfTheSea from "./wrath-of-the-sea.mjs";
import moonlightStep from "./moonlight-step.mjs";
import giantsMight from "./giants-might.mjs";

/** All registered features, keyed by id. Add new features here. */
const FEATURES = new Map([rage, zealousPresence, pathToTheGrave, symbioticEntity, wrathOfTheSea, moonlightStep, giantsMight].map(f => [f.id, f]));

export function getFeature(id) { return id ? FEATURES.get(id) ?? null : null; }
export function listFeatures() { return [...FEATURES.values()]; }
