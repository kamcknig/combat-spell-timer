import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { slugIdentifier } from "./identifier.mjs";
import { classEditionRules, cleanDdbName } from "./edition.mjs";
import { buildDdbDescription } from "./description.mjs";
import { imageFor } from "./images.mjs";
import { buildFeatureEffects } from "./effects.mjs";
import { buildFeatureUses, buildSuperiorityDicePool } from "./uses.mjs";

const DEFAULT_CLASS_IMG = "icons/skills/melee/weapons-crossed-swords-yellow.webp";
const DEFAULT_FEAT_IMG  = "icons/sundries/books/book-embossed-jewel-gold-purple.webp";

/** Stable image/registry key, e.g. "class:fighter" or "feat:fighting-style-archery". */
export function featureKey(type, name) { return `${type}:${slugIdentifier(name)}`; }

/** DDB definitionKey ("class-feature:2992711") or a synthetic fallback. */
function defKey(def, fallbackType) {
  return def?.definitionKey ?? `${fallbackType}:${def?.id ?? slugIdentifier(def?.name)}`;
}

/**
 * Module bookkeeping flag attached to every imported item. `name`, when given, is the
 * item's final resolved display name (e.g. "Fighting Style: Archery" for a chosen
 * option) — falls back to the definition's own name so featureKey matches the icon
 * lookup key used when building the item.
 */
function importFlag(def, fallbackType, classIdentifier, name) {
  return {
    [MODULE_ID]: {
      ddbImport: {
        definitionKey: defKey(def, fallbackType),
        featureKey: featureKey(fallbackType, name ?? def?.name),
        classIdentifier: classIdentifier ?? null,
        requiredLevel: def?.requiredLevel ?? null,
      },
    },
  };
}

function sourceField(def, rules) {
  const src = def?.sources?.[0] ?? {};
  return { book: src.sourceBook ?? "", page: src.pageNumber ? String(src.pageNumber) : "", rules, revision: 1 };
}

/**
 * Build the dnd5e `class` item from a DDB `.classes[]` entry.
 * @param {object} ddbClass
 * @param {object} [opts]
 * @param {string} [opts.id]  explicit `_id` (so feature items can reference it via
 *   `flags.dnd5e.advancementOrigin` for the sheet's "Fighter Features" grouping)
 */
export function buildClassItem(ddbClass, { id } = {}) {
  const def = ddbClass?.definition ?? {};
  const rules = classEditionRules(def.id);                   // edition from class definition.id
  const identifier = slugIdentifier(def.name);
  const name = cleanDdbName(def.name);                       // plain "Fighter" (no suffix)
  return {
    _id: id ?? foundry.utils.randomID(),
    name,
    type: "class",
    img: imageFor(featureKey("class", def.name), DEFAULT_CLASS_IMG),
    effects: [],
    system: {
      identifier,
      levels: ddbClass.level ?? 1,
      hd: { denomination: `d${def.hitDice ?? 10}`, spent: ddbClass.hitDiceUsed ?? 0, additional: "" },
      primaryAbility: { value: [], all: true },
      spellcasting: { progression: "none", ability: "", preparation: { formula: "" } },
      properties: [],
      description: {
        value: buildDdbDescription(def.snippet, def.description, {
          classLevel: ddbClass.level, featureName: def.name,
        }),
        chat: "",
      },
      source: sourceField(def, rules),
      advancement: {},        // empty + explicit _id ⇒ no auto-advancement injection
    },
    flags: importFlag(def, "class", identifier),
  };
}

/** Build the dnd5e `subclass` item (forward-compat; no subclass at Fighter L1). */
export function buildSubclassItem(ddbClass) {
  const def = ddbClass?.subclassDefinition;
  if (!def) return null;
  const classIdentifier = slugIdentifier(ddbClass?.definition?.name);
  const rules = classEditionRules(ddbClass?.definition?.id);     // subclass rules follow the parent class
  const identifier = slugIdentifier(def.name);
  return {
    _id: foundry.utils.randomID(),
    name: cleanDdbName(def.name),
    type: "subclass",
    img: imageFor(featureKey("subclass", def.name), DEFAULT_FEAT_IMG),
    effects: [],
    system: {
      identifier,
      classIdentifier,
      spellcasting: { progression: "none", ability: "", preparation: { formula: "" } },
      description: {
        value: buildDdbDescription(def.snippet, def.description, {
          classLevel: ddbClass?.level, featureName: def.name,
        }),
        chat: "",
      },
      source: sourceField(def, rules),
      advancement: {},
    },
    flags: importFlag(def, "subclass", classIdentifier),
  };
}

/** Map a known class-feature name → dnd5e feature subtype (subset; extend as needed). */
function featureSubtype(name) {
  const n = String(name ?? "");
  if (n === "Fighting Style" || n.startsWith("Fighting Style:")) return "fightingStyle";
  return "";
}

/**
 * Build one `feat` (class feature) item from a DDB feature definition.
 * @param {object} def        a `.classFeatures[].definition` (or chosen-option definition)
 * @param {object} ctx        { className, classIdentifier, rules, classId, actions }
 *   (`actions` is ddbData.actions?.class ?? [], for reading a feature's current
 *   `system.uses.spent` via buildFeatureUses — see uses.mjs)
 * @param {object} [overrides] e.g. { name, subtype } for a chosen choice option.
 *   `imageKey`, when given, is used for the FEATURE_IMAGES lookup INSTEAD of a key
 *   derived from `name` — for choice items whose name varies per-instance (e.g.
 *   "Weapon Mastery: Dart Vex" vs "Weapon Mastery: Longbow Slow") but which should
 *   still share one curated icon per underlying option (per mastery, not per weapon).
 */
export function buildFeatureItem(def, ctx, overrides = {}) {
  const name = cleanDdbName(overrides.name ?? def.name);
  const subtype = overrides.subtype ?? featureSubtype(name);
  const req = Number.parseInt(def.requiredLevel);
  const flags = importFlag(def, "feat", ctx.classIdentifier, name);
  // Links this feature back to its class item so the sheet groups it under
  // "<Class> Features" instead of "Other Features" (dnd5e reads this even though we
  // never ran the real Advancement Manager).
  if (ctx.classId) flags.dnd5e = { advancementOrigin: `${ctx.classId}.ddbImport` };
  const key = overrides.imageKey ?? featureKey("feat", name);
  const img = imageFor(key, DEFAULT_FEAT_IMG);
  const uses = buildFeatureUses(key, ctx.rules, { actions: ctx.actions, name });
  return {
    _id: foundry.utils.randomID(),
    name,
    type: "feat",
    img,
    effects: buildFeatureEffects(key, { name, img }),
    system: {
      type: { value: "class", subtype },
      requirements: ctx.className ? `${ctx.className} ${Number.isInteger(req) ? req : 1}` : "",
      description: {
        value: buildDdbDescription(def.snippet, def.description, {
          classLevel: ctx.classLevel, featureName: overrides.name ?? def.name, scaleValue: uses.max,
        }),
        chat: "",
      },
      source: sourceField(def, ctx.rules),
      prerequisites: { items: ctx.classIdentifier ? [`class:${ctx.classIdentifier}`] : [], level: Number.isInteger(req) ? req : null, repeatable: false },
      properties: [],
      activities: {},
      uses,
      advancement: {},
    },
    flags,
  };
}

/**
 * Choice features (e.g. "Fighting Style") → one feat per chosen option, named
 * "Parent: Option" (e.g. "Fighting Style: Archery"). The generic parent feature is
 * dropped by the caller. Chosen options come from two DDB shapes, both matched to the
 * parent class feature by componentId:
 *  - `ddbData.options.class[]` — the 2014-rules shape, a plain "chosen option."
 *  - `ddbData.feats[]` — the 2024-rules shape, where the choice is a genuine granted
 *    Feat (e.g. "Blind Fighting" for Fighter's 2024 "Fighting Style" class feature).
 *    Additionally scoped by componentTypeId === the parent's own entityTypeId, so only
 *    grants FROM this specific class feature are picked up (ddbData.feats[] also
 *    carries unrelated feat-granted-by-feat entries, e.g. Weapon Mastery, with a
 *    different componentTypeId).
 * @returns {object[]}  feat items for the chosen options ([] if none chosen)
 */
export function buildChoiceFeatureItems(parentDef, ddbData, ctx) {
  dbg("ddb:choices", "resolving options for", {
    parent: parentDef?.name,
    parentId: parentDef?.id,
    parentEntityTypeId: parentDef?.entityTypeId,
    optionsClass: (ddbData?.options?.class ?? []).map((o) => ({
      name: o?.definition?.name, componentId: o?.componentId, hasDefinition: !!o?.definition,
    })),
    feats: (ddbData?.feats ?? []).map((f) => ({
      name: f?.definition?.name, componentId: f?.componentId, componentTypeId: f?.componentTypeId, hasDefinition: !!f?.definition,
    })),
  });
  const fromOptions = (ddbData?.options?.class ?? [])
    .filter((o) => o?.componentId === parentDef?.id && o?.definition)
    .map((o) => o.definition);
  const fromFeats = (ddbData?.feats ?? [])
    .filter((f) => f?.componentId === parentDef?.id && f?.componentTypeId === parentDef?.entityTypeId && f?.definition)
    .map((f) => f.definition);
  dbg("ddb:choices", "matched", {
    parent: parentDef?.name,
    fromOptions: fromOptions.map((d) => d.name),
    fromFeats: fromFeats.map((d) => d.name),
  });
  return [...fromOptions, ...fromFeats].map((od) => {
    const optName = `${parentDef.name}: ${od.name}`;         // "Fighting Style: Archery"
    return buildFeatureItem(
      { ...od, requiredLevel: parentDef.requiredLevel, sources: od.sources ?? parentDef.sources },
      ctx,
      { name: optName, subtype: "fightingStyle" }
    );
  });
}

/**
 * Combat Superiority (2014 Battle Master): a normal feat item, but stamped with
 * the superiority-dice pool (system.uses), a `superiorityDie` flag for runtime
 * die rolls, and a leading description line naming the dice. Maneuvers spend
 * from THIS item's uses.
 * @param {object} feature  the classFeatures[] entry (needs .definition + .levelScale)
 */
export function buildCombatSuperiorityItem(feature, ddbData, ctx) {
  const item = buildFeatureItem(feature?.definition ?? {}, ctx);   // key: feat:combat-superiority
  const { uses, dieSize, count } = buildSuperiorityDicePool(feature, ctx.actions);
  item.system.uses = uses;
  item.flags[MODULE_ID] = {
    ...(item.flags[MODULE_ID] ?? {}),
    superiorityDie: dieSize,
    superiorityDiceCount: count,
  };
  // Guarantee the dice are visible on the sheet even if DDB token substitution didn't resolve.
  const line = `<p><strong>Superiority Dice:</strong> ${count}${dieSize} (recover on a short rest)</p>`;
  item.system.description.value = line + (item.system.description.value ?? "");
  dbg("ddb:battle-master", "combat superiority", { count, dieSize, spent: uses.spent });
  return item;
}

/**
 * Maneuvers (2014 Battle Master) → one "Maneuver: <name>" feat per chosen option.
 * Same options.class[] fan-out as buildChoiceFeatureItems, but singular "Maneuver:"
 * prefix and a "maneuver" subtype, and a per-maneuver icon key ("feat:maneuver-<name>",
 * matching the weapon-mastery convention) so each maneuver gets its own curated art
 * instead of sharing one generic icon.
 * All imported cosmetic; Commander's Strike, Disarming Attack, Distracting
 * Strike, Evasive Footwork, Feinting Attack, and Goading Attack are wired at
 * runtime — see their own adapter modules.
 */
export function buildManeuverFeatureItems(parentDef, ddbData, ctx) {
  const chosen = (ddbData?.options?.class ?? [])
    .filter((o) => o?.componentId === parentDef?.id && o?.definition)
    .map((o) => o.definition);
  dbg("ddb:battle-master", "maneuvers chosen", { names: chosen.map((d) => d.name) });
  return chosen.map((od) => buildFeatureItem(
    { ...od, requiredLevel: parentDef.requiredLevel, sources: od.sources ?? parentDef.sources },
    ctx,
    { name: `Maneuver: ${od.name}`, subtype: "maneuver", imageKey: featureKey("feat", `Maneuver ${od.name}`) }
  ));
}

/**
 * Resolve a `ddbData.choices.class[]` selection's chosen option label. Unlike
 * Fighting Style/Maneuvers (a full granted sub-feature in `options.class[]`),
 * a plain "pick one from a list" choice (e.g. Student of War's artisan's
 * tool) is recorded as a lightweight `{componentId, optionValue}` pair, whose
 * `optionValue` is an id resolved against `choices.choiceDefinitions[].options[]`.
 * Returns null if no choice was made or it can't be resolved (name falls
 * back to the plain feature name).
 */
function resolveChosenOptionLabel(ddbData, componentId) {
  const choice = (ddbData?.choices?.class ?? []).find((c) => c?.componentId === componentId);
  if (!choice || choice.optionValue == null) return null;
  for (const def of ddbData?.choices?.choiceDefinitions ?? []) {
    const opt = def?.options?.find((o) => o?.id === choice.optionValue);
    if (opt) return opt.label ?? null;
  }
  return null;
}

/**
 * Student of War (2014 Battle Master): "you gain proficiency with one type of
 * artisan's tools of your choice" — a normal feat item, but named
 * "Student of War: <chosen tool>" when the choice is resolvable. All
 * instances share one icon key regardless of the chosen tool (same rationale
 * as Weapon Mastery's shared per-option icon).
 */
export function buildStudentOfWarItem(def, ddbData, ctx) {
  const toolName = resolveChosenOptionLabel(ddbData, def.id);
  const name = toolName ? `${def.name}: ${toolName}` : def.name;
  dbg("ddb:battle-master", "student of war resolved", { toolName, name });
  return buildFeatureItem(def, ctx, { name, imageKey: featureKey("feat", def.name) });
}

/** Names whose granted feature is a pure choice container — emit the chosen options, drop the parent. */
export const CHOICE_FEATURE_NAMES = new Set(["Fighting Style"]);

/**
 * Class features that are pure narrative/bookkeeping entries with no
 * mechanical automation in this module — dropped entirely rather than
 * imported as inert feat items. "Ability Score Improvement" is matched by
 * suffix because 2024 data prefixes it with the granting level (e.g. "6:
 * Ability Score Improvement").
 */
const EXCLUDED_FEATURE_NAMES = new Set(["Proficiencies", "Equipment", "Hit Points", "Martial Archetype"]);

export function isExcludedFeatureName(name) {
  if (!name) return false;
  if (EXCLUDED_FEATURE_NAMES.has(name)) return true;
  return name.endsWith("Ability Score Improvement");
}
