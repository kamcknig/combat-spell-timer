import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";

/**
 * Barbarian Path of the Beast — "Form of the Beast" (legacy/2014 rules).
 * When Rage starts, the barbarian may manifest a natural weapon (Bite, Claws,
 * or Tail) that lasts until the rage ends. This module owns the weapon Item:
 * created on rage start (after a form-selection dialog), deleted when the
 * raging AE is deleted by any path.
 *
 * Weapon modeling mirrors ddb-importer (`dist/main.mjs`, class FormOfTheBeastWeapons):
 * natural weapons as character items, Tail with 10 ft reach, `mgc` property when
 * the actor has Bestial Soul (L6). Riders (Bite heal 1/turn, Claws extra attack,
 * Tail reaction AC) are description text only — see plan "What We're NOT Doing".
 */

const FEATURE_FLAG = "featureWeapon"; // flags[MODULE_ID][FEATURE_FLAG] = featureId

const FORMS = {
  bite:  { icon: "icons/creatures/abilities/fangs-teeth-bite.webp",   denomination: 8, types: ["piercing"], reach: null },
  claws: { icon: "icons/creatures/claws/claw-curved-jagged-gray.webp", denomination: 6, types: ["slashing"], reach: null },
  tail:  { icon: "icons/creatures/abilities/tail-swipe-green.webp",    denomination: 8, types: ["piercing"], reach: 10 },
};

const FORM_KEYS = { bite: "Bite", claws: "Claws", tail: "Tail" };

const isFeat = (i, name, identifier) => i?.type === "feat"
  && (i.name?.toLowerCase() === name || i.system?.identifier?.toLowerCase() === identifier);

/** Does the actor have the Form of the Beast feature? */
export function hasFormOfTheBeast(actor) {
  return !!actor?.items?.find(i => isFeat(i, "form of the beast", "form-of-the-beast"));
}

const hasBestialSoul = (actor) =>
  !!actor?.items?.find(i => isFeat(i, "bestial soul", "bestial-soul"));

/**
 * Ask which form to manifest. Returns "bite" | "claws" | "tail", or null for
 * "don't transform" (explicit button or dialog dismissed).
 */
export async function promptBeastForm(actor) {
  const name = foundry.utils.escapeHTML(actor.name);
  const choice = await foundry.applications.api.DialogV2.wait({
    rejectClose: false,
    window: { title: game.i18n.localize("COMBAT_SPELL_TIMER.FormOfTheBeast.Title"), icon: "fa-solid fa-paw" },
    content: `<p>${game.i18n.format("COMBAT_SPELL_TIMER.FormOfTheBeast.Prompt", { name })}</p>`,
    buttons: [
      { action: "bite",  icon: "fa-solid fa-tooth",       label: game.i18n.localize("COMBAT_SPELL_TIMER.FormOfTheBeast.Bite"), default: true },
      { action: "claws", icon: "fa-solid fa-hand-back-fist", label: game.i18n.localize("COMBAT_SPELL_TIMER.FormOfTheBeast.Claws") },
      { action: "tail",  icon: "fa-solid fa-staff-snake",  label: game.i18n.localize("COMBAT_SPELL_TIMER.FormOfTheBeast.Tail") },
      { action: "none",  icon: "fa-solid fa-xmark",        label: game.i18n.localize("COMBAT_SPELL_TIMER.FormOfTheBeast.None") },
    ],
  });
  return choice && choice !== "none" ? choice : null;
}

/**
 * Create the chosen form's natural weapon on the actor. dnd5e auto-creates the
 * default Attack activity for a weapon with no activities (WeaponData._preCreate),
 * so plain weapon data is enough — it attacks with STR and is proficient.
 */
export async function createBeastWeapon(actor, form, featureId) {
  const cfg = FORMS[form];
  if (!actor || !cfg) return null;
  await removeBeastWeapons(actor, featureId); // defensive: never stack stale weapons
  const key = FORM_KEYS[form];
  const data = {
    name: game.i18n.localize(`COMBAT_SPELL_TIMER.FormOfTheBeast.${key}Weapon`),
    type: "weapon",
    img: cfg.icon,
    system: {
      description: { value: `<p>${game.i18n.localize(`COMBAT_SPELL_TIMER.FormOfTheBeast.${key}Description`)}</p>` },
      type: { value: "natural", baseItem: "" },
      damage: { base: { number: 1, denomination: cfg.denomination, types: cfg.types } },
      range: { reach: cfg.reach, units: "ft" },
      proficient: 1,   // "counts as a simple melee weapon for you"
      equipped: true,
      properties: [
        ...(cfg.reach ? ["rch"] : []),
        ...(hasBestialSoul(actor) ? ["mgc"] : []),  // Bestial Soul (L6): attacks count as magical
      ],
    },
    flags: { [MODULE_ID]: { [FEATURE_FLAG]: featureId } },
  };
  const [item] = await actor.createEmbeddedDocuments("Item", [data]);
  dbg("dnd5e:beast-weapon-created", form, actor.name, item?.uuid);
  return item ?? null;
}

/** Delete every module-owned beast weapon for the feature (none is fine). */
export async function removeBeastWeapons(actor, featureId) {
  const ids = [...(actor?.items ?? [])]
    .filter(i => i.flags?.[MODULE_ID]?.[FEATURE_FLAG] === featureId)
    .map(i => i.id);
  if (!ids.length) return;
  dbg("dnd5e:beast-weapon-removed", actor.name, ids.length);
  await actor.deleteEmbeddedDocuments("Item", ids);
}
