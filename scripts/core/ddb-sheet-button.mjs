import { MODULE_ID } from "../module.mjs";
import { fetchCharacter, DdbImportError } from "../ddb/client.mjs";
import { ConfirmationDialog } from "../apps/confirmation-dialog.mjs";
import { dbg } from "../utils/debug.mjs";

const ID_FLAG = "ddbCharacterId";   // per-actor: the DDB character id (pre-fills the prompt)
const SRC_FLAG = "ddbSource";       // per-actor: cached raw .data character object

const { DialogV2 } = foundry.applications.api;

/**
 * renderActorSheetV2 hook: inject a GM-only import button into the sheet header.
 *
 * Verified against local Foundry v13 source (_renderFrame) and dnd5e v5 source:
 * - v13 window-header order: .window-icon, h1.window-title, [toggleControls btn], [close btn]
 * - dnd5e extends: inserts h2.window-subtitle after .window-title; prepends slide-toggle.mode-slider
 * - We insert after .window-title (between title and subtitle) — icon-only button fits the flex row.
 * - No getHeaderControls hook is used (it is suffixed with the class name, not practical from modules).
 *
 * @param {Application} app
 * @param {HTMLElement|jQuery} html
 * @param {object} _data
 */
export function onRenderActorSheetImportButton(app, html, _data) {
  if (!game.user.isGM) return;
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "character") return;       // PCs only for step 1
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.closest(".application")?.querySelector(".window-header")
              ?? root?.closest(".app")?.querySelector(".window-header");
  if (!header || header.querySelector(".cst-ddb-import")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control icon cst-ddb-import fa-solid fa-dungeon";
  btn.dataset.tooltip = game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.HeaderButton");
  btn.addEventListener("click", () => onImportClick(actor));
  header.querySelector(".window-title")?.after(btn);
  dbg("ddb:sheet", "button injected", { actor: actor.id });
}

async function promptCharacterId(prefill) {
  return DialogV2.prompt({
    window: { title: game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.Title") },
    content: `<input type="text" name="cid" value="${foundry.utils.escapeHTML(prefill ?? "")}"
              placeholder="${game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.UrlLabel")}" autofocus>`,
    ok: { label: game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.Button"),
          callback: (_e, btn) => btn.form.elements.cid.value.trim() },
    rejectClose: false
  }); // resolves to the entered string, or null on cancel/close
}

async function onImportClick(actor) {
  dbg("ddb:sheet", "import clicked", { actor: actor.id });
  const id = await promptCharacterId(actor.getFlag(MODULE_ID, ID_FLAG) ?? "");
  if (!id) { dbg("ddb:sheet", "prompt cancelled"); return; }
  await actor.setFlag(MODULE_ID, ID_FLAG, id);
  try {
    const data = await fetchCharacter(id);
    await actor.setFlag(MODULE_ID, SRC_FLAG, data);
    dbg("ddb:sheet", "imported", { actor: actor.id, name: data?.name });
    await ConfirmationDialog.show({
      title: game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.SuccessTitle"),
      icon: "fa-solid fa-circle-check",
      message: game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Import.SuccessBody", {
        name: data?.name ?? "?",
        cls:  data?.classes?.[0]?.definition?.name ?? "?",
        level: (data?.classes ?? []).reduce((n, c) => n + (c.level ?? 0), 0) || "?"
      })
    });
  } catch (err) {
    const code = err instanceof DdbImportError ? err.code : "unknown";
    dbg("ddb:sheet", "failed", { actor: actor.id, code, status: err?.status });
    await ConfirmationDialog.show({
      title: game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.ErrorTitle"),
      icon: "fa-solid fa-triangle-exclamation",
      message: game.i18n.localize(`COMBAT_SPELL_TIMER.Ddb.Import.Error.${code}`)
            || game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.Error.unknown")
    });
  }
}
