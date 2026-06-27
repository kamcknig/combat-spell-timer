import { ConfirmationDialog, systemDialogClasses } from "./confirmation-dialog.mjs";
import { hasSeen, markSeen } from "../utils/notification-receipts.mjs";
import { dbg } from "../utils/debug.mjs";

const CHECKBOX_NAME = "cst-dont-show-again";

/**
 * Read-receipt notification dialog. Renders everything ConfirmationDialog does,
 * plus a horizontally centered "Don't show again" checkbox (default checked)
 * below the CONFIRM button. On confirm with the box ticked, the notification key
 * is recorded as seen and never shown again for the chosen scope; dismissing or
 * leaving the box unticked saves nothing, so it reappears next session.
 */
export class NotificationDialog extends ConfirmationDialog {
  static DEFAULT_OPTIONS = {
    classes: ["cst-notification-dialog"]
  };

  /**
   * Group the button (footer) and the "Don't show again" toggle into one bottom
   * section, spaced from the content above. The checkbox renders below the button.
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const form = this.element.querySelector("form.dialog-form");
    if (!form || form.querySelector(".cst-dialog-bottom")) return;
    const id = `${CHECKBOX_NAME}-${this.id}`;
    const wrap = document.createElement("div");
    wrap.className = "cst-dont-show-again";
    wrap.innerHTML = `
      <label for="${id}">
        <input id="${id}" type="checkbox" name="${CHECKBOX_NAME}" checked>
        ${game.i18n.localize("COMBAT_SPELL_TIMER.Notification.DontShowAgain")}
      </label>`;
    const bottom = document.createElement("div");
    bottom.className = "cst-dialog-bottom";
    const footer = form.querySelector(".form-footer");
    if (footer) bottom.appendChild(footer);   // move the existing button row in
    bottom.appendChild(wrap);
    form.appendChild(bottom);
  }

  /**
   * Show a notification unless its receipt says otherwise.
   * @param {object} config
   * @param {string} config.key             Stable receipt key (e.g. "ddb-importer-missing").
   * @param {"global"|"gm"} [config.scope]  Receipt strategy (default "global").
   * @param {string} config.title           Window title (already localized).
   * @param {string} [config.message]       Body HTML (already localized; trusted).
   * @param {string} [config.icon]
   * @param {string} [config.confirmLabel]
   * @returns {Promise<{shown:boolean, confirmed:boolean, dontShowAgain:boolean}>}
   */
  static async notify({ key, scope = "global", title, message = "", icon = "fa-solid fa-circle-info", confirmLabel } = {}) {
    if (!key) throw new Error("NotificationDialog.notify requires a key");
    if (hasSeen(key, scope)) {
      dbg("notify", `suppressed — already seen (${scope}): ${key}`);
      return { shown: false, confirmed: false, dontShowAgain: false };
    }
    let dontShowAgain = true;   // checkbox defaults to checked
    const result = await this.wait({
      classes: systemDialogClasses(),   // system theme (dnd5e2 dark) or [] when agnostic
      window: { title, icon },
      content: `<div class="cst-confirm-message">${message}</div>`,
      rejectClose: false,
      buttons: [{
        action: "confirm",
        icon: "fa-solid fa-check",
        label: confirmLabel ?? game.i18n.localize("COMBAT_SPELL_TIMER.Notification.Confirm"),
        default: true,
        callback: (event, button, dialog) => {
          const cb = dialog.element.querySelector(`input[name="${CHECKBOX_NAME}"]`);
          dontShowAgain = cb ? cb.checked : true;
          return true;
        }
      }]
    });
    const confirmed = result === true;
    if (confirmed && dontShowAgain) await markSeen(key, scope);
    dbg("notify", `key=${key} scope=${scope} confirmed=${confirmed} dontShowAgain=${dontShowAgain}`);
    return { shown: true, confirmed, dontShowAgain };
  }
}
