import { NotificationDialog } from "../apps/notification-dialog.mjs";
import { dbg } from "../utils/debug.mjs";

const DDB_IMPORTER_ID = "ddb-importer";
const RECEIPT_KEY = "ddb-importer-missing";

/**
 * Warn the GM (once, world-wide) that this module works best with ddb-importer
 * when that module is not active. No-op for players, for active ddb-importer, and
 * after the GM ticks "Don't show again". Call from `ready`.
 */
export async function maybeWarnDdbImporterMissing() {
  if (!game.user.isGM) { dbg("ddbCheck", "skip — not GM"); return; }
  if (game.modules.get(DDB_IMPORTER_ID)?.active) {
    dbg("ddbCheck", "ddb-importer active — no warning");
    return;
  }
  dbg("ddbCheck", "ddb-importer not active — showing notification");
  await NotificationDialog.notify({
    key: RECEIPT_KEY,
    scope: "global",
    icon: "fa-solid fa-triangle-exclamation",
    title: game.i18n.localize("COMBAT_SPELL_TIMER.Notification.DdbImporter.Title"),
    message: game.i18n.localize("COMBAT_SPELL_TIMER.Notification.DdbImporter.Message")
  });
}
