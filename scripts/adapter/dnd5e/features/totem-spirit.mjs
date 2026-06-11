import { MODULE_ID } from "../../../module.mjs";
import { dbg } from "../../../utils/debug.mjs";
import { FEATURE_SENTINEL_ROUNDS } from "./shared.mjs";

/**
 * Barbarian Path of the Totem Warrior — "Totem Spirit" (level 3) and
 * "Totemic Attunement" (level 14) rage augmentations.
 * While raging, a totem warrior gains their chosen animal's boon; the module
 * creates a temporary AE on the rager when the rage starts and removes it when
 * the rage ends by any path. One table entry per supported animal per tier.
 *
 * Effect modeling mirrors ddb-importer (`dist/main.mjs`, class TotemSpiritBear):
 * the effect is named after the feat ("Totem Spirit: Bear") and Bear's changes
 * are damage resistance to every type except psychic. ddb ships the item with a
 * DISABLED transfer effect instead (manual-toggle style); that template lives
 * on the item, never on the actor, so our flag-scoped cleanup cannot touch it.
 *
 * Marker-only entries (changes: () => []):
 *   Spirit tier  — Eagle, Tiger, Wolf (action-economy / positional riders)
 *   Attunement tier — Bear, Elk, Tiger, Wolf (action-economy / positional riders)
 * Real-change entries:
 *   Spirit tier  — Bear (all-damage resistance), Elk (+15 ft walk)
 *   Attunement tier — Eagle (fly speed = current walking speed, live-synced)
 *
 * Eagle attunement: dnd5e's prepareMovement resolves each movement value via
 * simplifyBonus(value, rollData) on every data preparation, so the formula
 * "@attributes.movement.walk" re-derives fly from the current walk each time
 * anything about the actor changes — no updateActor hook needed. This mirrors
 * ddb's TotemicAttunementEagle: upgradeChange("@attributes.movement.walk", 20,
 * "system.attributes.movement.fly").
 */

/** Module flag marking an AE this module created for a totem spirit. */
const TOTEM_FLAG = "totemSpirit";

const TOTEM_SPIRITS = [
  // ── Spirit tier (level 3) ────────────────────────────────────────────────
  {
    key: "spirit-bear",
    nameParts: ["totem spirit", "bear"],
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
  {
    key: "spirit-elk",
    nameParts: ["totem spirit", "elk"],
    statusId: "cst-totem-elk",
    fallbackImg: "icons/creatures/mammals/elk-moose-marked-green.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemSpirit.ElkDescription",
    // +15 ft walking speed (ddb: unsignedAddChange("15", 20,
    // "system.attributes.movement.walk")). The no-heavy-armor condition lives
    // in the description, as in ddb's modeling.
    changes: () => [
      { key: "system.attributes.movement.walk", mode: CONST.ACTIVE_EFFECT_MODES.ADD, value: "15", priority: 20 },
    ],
  },
  {
    key: "spirit-eagle",
    nameParts: ["totem spirit", "eagle"],
    statusId: "cst-totem-eagle",
    fallbackImg: "icons/creatures/birds/raptor-hawk-flying.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemSpirit.EagleDescription",
    // Marker only (matches ddb's TotemSpiritEagle): the rider is action
    // economy (Dash as a bonus action, OA disadvantage) — nothing to change.
    changes: () => [],
  },
  {
    key: "spirit-tiger",
    nameParts: ["totem spirit", "tiger"],
    statusId: "cst-totem-tiger",
    fallbackImg: "icons/creatures/mammals/cat-hunched-glowing-red.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemSpirit.TigerDescription",
    // Marker only (matches ddb's TotemSpiritTiger): jump distances.
    changes: () => [],
  },
  {
    key: "spirit-wolf",
    nameParts: ["totem spirit", "wolf"],
    statusId: "cst-totem-wolf",
    fallbackImg: "icons/creatures/mammals/wolf-howl-moon-black.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemSpirit.WolfDescription",
    // Marker only (matches ddb's TotemSpiritWolf): ally melee advantage near you.
    changes: () => [],
  },
  // ── Attunement tier (level 14) ───────────────────────────────────────────
  {
    key: "attunement-bear",
    nameParts: ["totemic attunement", "bear"],
    statusId: "cst-attunement-bear",
    fallbackImg: "icons/creatures/abilities/bear-roar-bite-brown.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemicAttunement.BearDescription",
    // Marker only: hostile creatures near you attack others at disadvantage.
    changes: () => [],
  },
  {
    key: "attunement-eagle",
    nameParts: ["totemic attunement", "eagle"],
    statusId: "cst-attunement-eagle",
    fallbackImg: "icons/creatures/birds/raptor-hawk-flying.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemicAttunement.EagleDescription",
    // Fly speed = CURRENT walking speed. The formula value re-derives on every
    // data preparation (dnd5e prepareMovement resolves movement formulas via
    // simplifyBonus + roll data), so it tracks walk changes live — no hook.
    // Mirrors ddb's TotemicAttunementEagle: upgradeChange("@attributes.movement.walk").
    changes: () => [
      { key: "system.attributes.movement.fly", mode: CONST.ACTIVE_EFFECT_MODES.UPGRADE, value: "@attributes.movement.walk", priority: 20 },
    ],
  },
  {
    key: "attunement-elk",
    nameParts: ["totemic attunement", "elk"],
    statusId: "cst-attunement-elk",
    fallbackImg: "icons/creatures/mammals/elk-moose-marked-green.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemicAttunement.ElkDescription",
    // Marker only: bonus-action pass-through knockdown.
    changes: () => [],
  },
  {
    key: "attunement-tiger",
    nameParts: ["totemic attunement", "tiger"],
    statusId: "cst-attunement-tiger",
    fallbackImg: "icons/creatures/mammals/cat-hunched-glowing-red.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemicAttunement.TigerDescription",
    // Marker only: bonus-action attack after a 20-ft straight-line charge.
    changes: () => [],
  },
  {
    key: "attunement-wolf",
    nameParts: ["totemic attunement", "wolf"],
    statusId: "cst-attunement-wolf",
    fallbackImg: "icons/creatures/mammals/wolf-howl-moon-black.webp",
    descriptionKey: "COMBAT_SPELL_TIMER.TotemicAttunement.WolfDescription",
    // Marker only: bonus-action knockdown on a melee hit.
    changes: () => [],
  },
];

/** The actor's feat item for a totem entry, or null. Matches every name part
 *  (e.g. ["totemic attunement", "eagle"]) case-insensitively. */
function findTotemFeat(actor, entry) {
  return actor?.items?.find(i => {
    if (i?.type !== "feat") return false;
    const n = i.name?.toLowerCase() ?? "";
    return entry.nameParts.every(part => n.includes(part));
  }) ?? null;
}

/**
 * Rage started → create the AE for every totem spirit the actor has (in
 * practice one). Deduped: any stale flagged AE is removed first.
 * @param {Actor} actor
 */
export async function applyTotemSpiritEffects(actor) {
  for (const totem of TOTEM_SPIRITS) {
    const item = findTotemFeat(actor, totem);
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
