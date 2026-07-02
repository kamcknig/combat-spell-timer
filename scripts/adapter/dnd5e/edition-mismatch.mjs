import { MODULE_ID, warn } from "../../module.mjs";
import { dbg } from "../../utils/debug.mjs";
import { NotificationDialog } from "../../apps/notification-dialog.mjs";

// Mirrors IMPORT_FLAG in scripts/core/ddb-import.mjs (not imported directly — adapter code
// doesn't reach back into core; builders.mjs's importFlag() already duplicates this same key).
const DDB_IMPORT_FLAG = "ddbImport";
const RULES_LABEL = { "2014": "2014 (Legacy)", "2024": "2024 (Modern)" };

/**
 * "2024" when dnd5e's world "Rules Version" setting is "modern", else "2014". Reads the raw
 * world setting directly rather than isModernRules()/the dnd5e.settings cache (which dnd5e only
 * refreshes at its own init hook, since the setting is requiresReload:true) — this audit needs
 * to react to a just-saved change immediately, before the world reloads.
 * @returns {"2014"|"2024"}
 */
export function activeRulesEdition() {
  return game.settings.get("dnd5e", "rulesVersion") === "modern" ? "2024" : "2014";
}

/** This module's DDB-imported items on `actor` whose stamped edition differs from `active`. */
function mismatchedItems(actor, active) {
  return actor.items.filter((item) => {
    if (!item.getFlag(MODULE_ID, DDB_IMPORT_FLAG)) return false;
    const rules = item.system?.source?.rules;
    return rules && rules !== active;
  });
}

/**
 * Scan `actors` for DDB-imported items whose stamped edition doesn't match the world's active
 * dnd5e rules-version setting.
 * @param {Actor[]} actors
 * @returns {{active:("2014"|"2024"), entries:{actor:Actor, items:Item[]}[]}}
 */
export function collectEditionMismatches(actors) {
  const active = activeRulesEdition();
  const entries = [];
  for (const actor of actors ?? []) {
    const items = mismatchedItems(actor, active);
    if (items.length) entries.push({ actor, items });
  }
  return { active, entries };
}

/**
 * Deterministic NotificationDialog receipt key for one exact mismatch state — any change (a
 * new mismatch, a resolved one, or a different active edition) produces a new key and
 * re-prompts, even if a prior mismatch state was dismissed with "Don't show again".
 */
function receiptKey(active, entries) {
  const parts = entries
    .map((e) => `${e.actor.id}:${e.items.map((i) => i.id).sort().join(",")}`)
    .sort();
  return `edition-mismatch:${active}:${parts.join("|")}`;
}

/** Every item in one `entries` group shares the same (non-active) stamped rules value — only
 * two edition values exist, so "not active" is unambiguous. */
function formatMessage(active, entries) {
  const activeLabel = RULES_LABEL[active] ?? active;
  const rows = entries.map((e) => {
    const importedLabel = RULES_LABEL[e.items[0].system.source.rules] ?? e.items[0].system.source.rules;
    const names = e.items.map((i) => i.name).join(", ");
    return `<li><strong>${e.actor.name}</strong> (${importedLabel}): ${names}</li>`;
  }).join("");
  return game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Import.EditionMismatchBody", { active: activeLabel })
    + `<ul>${rows}</ul>`;
}

/**
 * Audit `actors` for a DDB-import edition mismatch against the world's active dnd5e rules
 * setting. Logs full detail via console.warn unconditionally, and shows the GM an
 * acknowledgeable NotificationDialog (suppressible via "Don't show again", keyed to the exact
 * mismatch content). No-op for non-GMs and when nothing mismatches.
 * @param {Actor[]} actors
 * @returns {Promise<void>}
 */
export async function runEditionMismatchAudit(actors) {
  if (!game.user.isGM) return;
  const { active, entries } = collectEditionMismatches(actors);
  if (!entries.length) { dbg("dnd5e:edition-audit", "no mismatches", { active }); return; }
  warn("DDB import edition mismatch", entries.map((e) => ({
    actor: e.actor.name,
    items: e.items.map((i) => i.name),
    importedRules: e.items[0].system.source.rules,
    activeRules: active,
  })));
  await NotificationDialog.notify({
    key: receiptKey(active, entries),
    scope: "global",
    icon: "fa-solid fa-triangle-exclamation",
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.EditionMismatchTitle"),
    message: formatMessage(active, entries),
  });
}

/**
 * Re-run the audit (over every world actor) whenever dnd5e's "Rules Version" world setting
 * changes. The setting has no onChange and is requiresReload:true, so this is the only signal
 * available, and warns the GM about the consequence of their choice immediately — before the
 * world reload that setting prompts for. Call once from `ready`.
 */
export function registerEditionMismatchWatchHooks() {
  Hooks.on("updateSetting", (setting) => {
    if (setting.key !== "dnd5e.rulesVersion") return;
    dbg("dnd5e:edition-audit", "rulesVersion changed — re-auditing all actors");
    runEditionMismatchAudit(game.actors.contents);
  });
}
