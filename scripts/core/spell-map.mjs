import { MODULE_ID } from "../module.mjs";
import { dbg } from "../utils/debug.mjs";

/** World setting key holding the spell-name mapping array. */
export const SPELL_MAP_SETTING = "spellMap";

/**
 * The DataField schema for the mapping setting: an array of { from, to } string
 * pairs. Using a real DataField means every read returns a validated, trimmed,
 * cleaned array. `from` must be non-blank; `to` may be blank transiently but
 * blank rows are dropped by the editor before saving.
 * @returns {foundry.data.fields.ArrayField}
 */
export function spellMapField() {
  const { ArrayField, SchemaField, StringField } = foundry.data.fields;
  return new ArrayField(new SchemaField({
    from: new StringField({ required: true, blank: false, trim: true }),
    to: new StringField({ required: true, blank: true, trim: true })
  }));
}

/** @returns {{from: string, to: string}[]} The stored mapping (never null). */
export function getSpellMap() {
  const value = game.settings.get(MODULE_ID, SPELL_MAP_SETTING);
  return Array.isArray(value) ? value : [];
}

/**
 * GM-only write: persist the full mapping array.
 * @param {{from: string, to: string}[]} entries
 * @returns {Promise<void>}
 */
export async function setSpellMap(entries) {
  dbg("spell-map:set", entries.length);
  return game.settings.set(MODULE_ID, SPELL_MAP_SETTING, entries);
}

/**
 * Resolve a D&D Beyond spell name through the mapping. Matching is
 * case-insensitive and whitespace-trimmed. Returns the mapped Foundry name when a
 * mapping exists, otherwise the original name unchanged.
 * @param {string} name
 * @returns {string}
 */
export function resolveMappedName(name) {
  if (!name) return name;
  const key = String(name).trim().toLowerCase();
  const hit = getSpellMap().find(e => String(e.from).trim().toLowerCase() === key);
  const mapped = hit?.to?.trim();
  if (mapped) dbg("spell-map:resolve", name, "→", mapped);
  return mapped || name;
}
