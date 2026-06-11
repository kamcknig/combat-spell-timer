import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { FEATURE_SENTINEL_ROUNDS } from "./shared.mjs";

/**
 * Barbarian Path of the Totem Warrior — "Totem Spirit" rage augmentations.
 * While raging, a totem warrior gains their chosen animal's boon; the module
 * creates a temporary AE on the rager when the rage starts and removes it when
 * the rage ends by any path. One table entry per supported animal.
 *
 * Effect modeling mirrors ddb-importer (`dist/main.mjs`, class TotemSpiritBear):
 * the effect is named after the feat ("Totem Spirit: Bear") and Bear's changes
 * are damage resistance to every type except psychic. ddb ships the item with a
 * DISABLED transfer effect instead (manual-toggle style); that template lives
 * on the item, never on the actor, so our flag-scoped cleanup cannot touch it.
 */

/** Module flag marking an AE this module created for a totem spirit. */
const TOTEM_FLAG = "totemSpirit";

const TOTEM_SPIRITS = [
  {
    key: "bear",
    statusId: "cst-totem-bear",
    fallbackImg: "icons/creatures/abilities/bear-roar-bite-brown.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemSpirit.BearDescription",
    // Resistance to all damage except psychic (ddb: allDamageTypes(["psychic"])
    // → damageResistanceChange each). Enumerated at runtime so new system
    // damage types are covered automatically.
    changes: () => Object.keys(CONFIG.DND5E?.damageTypes ?? {})
      .filter(type => type !== "psychic")
      .map(type => ({ key: "system.traits.dr.value", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: type, priority: 20 })),
  },
];

/** The actor's feat item for a totem animal, or null. Matches ddb's
 *  "Totem Spirit: Bear" naming and hand-made variants leniently. */
function findTotemFeat(actor, key) {
  return actor?.items?.find(i => {
    if (i?.type !== "feat") return false;
    const n = i.name?.toLowerCase() ?? "";
    return n.includes("totem spirit") && n.includes(key);
  }) ?? null;
}

/**
 * Rage started → create the AE for every totem spirit the actor has (in
 * practice one). Deduped: any stale flagged AE is removed first.
 * @param {Actor} actor
 */
export async function applyTotemSpiritEffects(actor) {
  for (const totem of TOTEM_SPIRITS) {
    const item = findTotemFeat(actor, totem.key);
    if (!item) continue;
    await removeTotemSpiritEffects(actor, totem.key); // never stack stale copies
    const data = {
      name: item.name,
      img: item.img || totem.fallbackImg,
      statuses: [totem.statusId],
      disabled: false,
      origin: item.uuid,
      description: `<p>${game.i18n.localize(totem.descriptionKey)}</p>`,
      changes: totem.changes(),
      // Same v14 quirk as feature AEs (shared.mjs): a temporary-flagged effect
      // with no finite duration gets suppressed by the expiry registry, so it
      // carries the sentinel; rage end deletes it (boundFeature drives display).
      duration: { rounds: FEATURE_SENTINEL_ROUNDS },
      flags: {
        dnd5e: { isTemporary: true },
        [MODULE_ID]: { [TOTEM_FLAG]: totem.key, boundFeature: "rage" },
      },
    };
    dbg("dnd5e:totem-spirit-applied", totem.key, actor.name);
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  }
}

/**
 * Remove the module-created totem AE(s) from the actor (none is fine).
 * @param {Actor} actor
 * @param {string|null} key  A specific animal, or null for all.
 */
export async function removeTotemSpiritEffects(actor, key = null) {
  const ids = [...(actor?.effects ?? [])]
    .filter(e => {
      const k = e.flags?.[MODULE_ID]?.[TOTEM_FLAG];
      return k != null && (!key || k === key);
    })
    .map(e => e.id);
  if (!ids.length) return;
  dbg("dnd5e:totem-spirit-removed", actor.name, ids.length);
  await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}
