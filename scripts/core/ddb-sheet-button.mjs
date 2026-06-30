import { MODULE_ID } from "../module.mjs";
import { requestImport, ID_FLAG } from "./ddb-import.mjs";
import { dbg } from "../utils/debug.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * renderActorSheetV2 hook: inject an import button into the sheet header for any
 * viewer (GM or player), but only while the dnd5e sheet is in EDIT mode.
 *
 * The dnd5e mode toggle (`_onChangeSheetMode`) re-renders the sheet, re-firing
 * this hook, but the AppV2 window frame (header) persists across content
 * re-renders — so we add the button in edit mode and remove it otherwise.
 *
 * Header DOM verified against Foundry v13 (_renderFrame) + dnd5e v5: order is
 * .window-icon, h1.window-title, slide-toggle.mode-slider, h2.window-subtitle…;
 * we insert right after .window-title.
 *
 * @param {Application} app
 * @param {HTMLElement|jQuery} html
 * @param {object} _data
 */
export function onRenderActorSheetImportButton(app, html, _data) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "character") return;       // PCs only for step 1
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.closest(".application")?.querySelector(".window-header")
              ?? root?.closest(".app")?.querySelector(".window-header");
  if (!header) return;

  // dnd5e edit mode only (MODES.EDIT). The toggle is shown only when the viewer
  // can edit the actor, so players only see this on characters they own.
  const MODES = app.constructor?.MODES;
  const editMode = !!MODES && app._mode === MODES.EDIT;
  const existing = header.querySelector(".cst-ddb-import");
  if (!editMode) {
    if (existing) { existing.remove(); dbg("ddb:sheet", "button removed (not edit mode)", { actor: actor.id }); }
    return;
  }
  if (existing) return;   // already present for this open sheet

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "header-control icon cst-ddb-import fa-solid fa-dungeon";
  btn.dataset.tooltip = game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.HeaderButton");
  btn.addEventListener("click", () => onImportClick(actor));
  header.querySelector(".window-title")?.after(btn);
  dbg("ddb:sheet", "button injected", { actor: actor.id, gm: game.user.isGM });
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
  // Route to the elected cobalt-holding GM (or run locally if that's us). The GM
  // fetches with their cobalt, writes the actor, and the result dialog comes back
  // to whoever clicked.
  await requestImport(actor.uuid, id);
}
