import { dbg } from "../../../utils/debug.mjs";
import { buildFeatureItem, featureKey } from "./builders.mjs";

/**
 * DDB represents a Fighter's chosen Weapon Mastery weapon types as
 * `.options.feat[]` entries named "<Weapon> (<Mastery>)" (e.g. "Battleaxe
 * (Topple)"), linked to the "Weapon Mastery" grant in `.feats[]` by
 * `componentId === weaponMasteryFeat.definition.id` — NOT by matching the
 * "Weapon Mastery" classFeature's own id (a different, unrelated id).
 */
function weaponMasteryDefinitionId(ddbData) {
  const grant = (ddbData?.feats ?? []).find(f => f?.definition?.name === "Weapon Mastery");
  return grant?.definition?.id ?? null;
}

/** "Battleaxe (Topple)" -> "battleaxe" (matches DND5E.weaponIds key shape: lowercase, no spaces/punctuation). */
function baseItemKeyFromOptionName(name) {
  return String(name ?? "").split("(")[0].trim().toLowerCase().replace(/[^a-z]/g, "");
}

/** "Battleaxe (Topple)" -> "topple" (matches CONFIG.DND5E.weaponMasteries key shape). */
function masteryKeyFromOptionName(name) {
  const match = String(name ?? "").match(/\(([^)]+)\)/);
  return match ? match[1].trim().toLowerCase().replace(/[^a-z]/g, "") : "";
}

/** The chosen-option entries from `.options.feat[]` for the Weapon Mastery grant, or []. */
function weaponMasteryOptions(ddbData) {
  const definitionId = weaponMasteryDefinitionId(ddbData);
  if (!definitionId) return [];
  return (ddbData?.options?.feat ?? [])
    .filter(o => o?.componentId === definitionId && o?.definition?.name);
}

/**
 * Derive the actor-update payload for `system.traits.weaponProf.mastery.value`
 * from cached DDB `.data`, or null if the character has no Weapon Mastery
 * grant / no resolvable choices. Only recognized dnd5e weapon base-item keys
 * are included (validated against CONFIG.DND5E.weaponIds) — an unrecognized
 * DDB weapon name is logged and skipped rather than written blind.
 * @param {object} ddbData
 * @returns {{"system.traits.weaponProf.mastery.value": string[]}|null}
 */
export function buildWeaponMasteryTraitUpdate(ddbData) {
  const known = new Set(Object.keys(CONFIG.DND5E?.weaponIds ?? {}));
  const chosen = weaponMasteryOptions(ddbData)
    .map(o => baseItemKeyFromOptionName(o.definition.name))
    .filter(key => {
      const ok = known.has(key);
      if (!ok) dbg("ddb:weapon-mastery", "unrecognized weapon base-item, skipped", { key });
      return ok;
    });

  dbg("ddb:weapon-mastery", "chosen types resolved", { chosen });
  if (!chosen.length) return null;
  return { "system.traits.weaponProf.mastery.value": [...new Set(chosen)] };
}

/**
 * Build one `feat` item per chosen Weapon Mastery weapon type, named
 * "Weapon Mastery: <Weapon> <Mastery>" (e.g. "Weapon Mastery: Dart Vex") —
 * one per `.options.feat[]` choice, covering all 8 mastery properties
 * including the cosmetic ones (Nick/Push/Vex), not just the 5 with
 * mechanical implementations. Purely a display item: eligibility for the
 * mechanical masteries (weapon-mastery.mjs#hasMastery) reads
 * system.traits.weaponProf.mastery.value + the equipped weapon's own
 * system.mastery directly, never this item's mere existence.
 *
 * Reuses buildFeatureItem's normal snippet+description handling (the
 * option's own `.definition.snippet`/`.description` already carry DDB's
 * rules text for that specific weapon+mastery pairing) with a custom
 * `imageKey` derived from the MASTERY alone (e.g. "feat:weapon-mastery-vex"),
 * so every "…Vex" choice shares one curated icon regardless of which weapon
 * it's paired with (a full name-derived key would need a separate icon per
 * weapon×mastery combination, which doesn't scale).
 * @param {object} ddbData
 * @param {object} ctx  same shape buildFeatureItem expects (className, classIdentifier, rules, classId, classLevel)
 * @returns {object[]}
 */
export function buildWeaponMasteryFeatureItems(ddbData, ctx) {
  const options = weaponMasteryOptions(ddbData);
  return options.map(o => {
    const def = o.definition;
    const masteryKey = masteryKeyFromOptionName(def.name);
    const displayName = `Weapon Mastery: ${def.name.replace(/[()]/g, "")}`;
    return buildFeatureItem(def, ctx, {
      name: displayName,
      imageKey: masteryKey ? featureKey("feat", `Weapon Mastery ${masteryKey}`) : undefined,
    });
  });
}
