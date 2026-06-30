import { MODULE_ID } from "../module.mjs";
import { dbg } from "../utils/debug.mjs";
import DdbConfig from "../apps/ddb-config.mjs";

/** Client-scoped setting key for the stored CobaltSession value. */
export const COBALT_SETTING = "ddbCobaltCookie";

/**
 * Register the cobalt setting and the GM-only config menu entry. Call once from
 * the `init` hook (translations are not yet loaded — pass raw i18n keys for
 * name/hint/label; the settings UI localizes them at render time).
 */
export function registerDdbImporterSettings() {
  // CLIENT scope: the cobalt is a live DDB credential, so keep it off the server.
  // Foundry persists client-scoped settings in the browser's localStorage — it's
  // never written to the world DB and never leaves the importing user's machine.
  // config:false keeps it off the standard settings panel.
  game.settings.register(MODULE_ID, COBALT_SETTING, {
    scope: "client",
    config: false,
    type: String,
    default: ""
  });

  // GM-only settings-menu button that opens the cobalt config app.
  // restricted:true hides the row from non-GM players.
  game.settings.registerMenu(MODULE_ID, "ddbImporterMenu", {
    name: "COMBAT_SPELL_TIMER.Ddb.Config.MenuName",
    label: "COMBAT_SPELL_TIMER.Ddb.Config.MenuLabel",
    hint: "COMBAT_SPELL_TIMER.Ddb.Config.MenuHint",
    icon: "fa-solid fa-dungeon",
    type: DdbConfig,
    restricted: true
  });

  dbg("ddb:settings", "registered");
}

/**
 * Read the saved cobalt value, trimmed.
 * @returns {string}  empty string if nothing is saved
 */
export const getCobalt = () => (game.settings.get(MODULE_ID, COBALT_SETTING) || "").trim();

/**
 * Persist a new cobalt value (trimmed). Pass `""` or `null` to clear.
 * @param {string|null} v
 * @returns {Promise<void>}
 */
export const setCobalt = (v) => game.settings.set(MODULE_ID, COBALT_SETTING, (v ?? "").trim());
