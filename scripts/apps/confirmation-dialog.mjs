import { getAdapter } from "../adapter/index.mjs";
import { dbg } from "../utils/debug.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * System-native dialog classes (e.g. dnd5e "dnd5e2"). Returns [] when no adapter
 * is loaded yet or the system is agnostic → plain AppV2 + Foundry default styling.
 * @returns {string[]}
 */
export function systemDialogClasses() {
  try { return getAdapter().dialogClasses ?? []; }
  catch { return []; }
}

/**
 * Reusable confirmation dialog: title, message, and a single horizontally
 * centered CONFIRM button. General-purpose — use anywhere an acknowledge prompt
 * is needed. Renders in the active system's style (or Foundry defaults when
 * agnostic). `message` may contain trusted (module-authored / i18n) HTML; it is
 * passed through Foundry's content sanitiser, not escaped.
 */
export class ConfirmationDialog extends DialogV2 {
  static DEFAULT_OPTIONS = {
    classes: ["cst-confirm-dialog"]
  };

  /**
   * Render the title as a centered header inside the form — native dnd5e dialog
   * placement (`form > header`), in normal flow. dnd5e's own window-title is
   * absolutely positioned for a sheet banner, so we keep the title bar clear (see
   * CSS) and show the title here instead.
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const form = this.element.querySelector("form.dialog-form");
    if (!form || form.querySelector("header.cst-dialog-title")) return;
    const title = this.options.window?.title;
    if (!title) return;
    const header = document.createElement("header");
    header.className = "cst-dialog-title";
    header.textContent = game.i18n.localize(title);
    form.prepend(header);   // first child, before .dialog-content
  }

  /**
   * Show the dialog and resolve when the user confirms or dismisses it.
   * @param {object} config
   * @param {string} config.title           Window title (already localized).
   * @param {string} [config.message]       Body HTML (already localized; trusted).
   * @param {string} [config.icon]          FontAwesome classes for the window icon.
   * @param {string} [config.confirmLabel]  Override the CONFIRM button label.
   * @returns {Promise<boolean>}            true if CONFIRM was pressed, false if dismissed.
   */
  static async show({ title, message = "", icon = "fa-solid fa-circle-info", confirmLabel } = {}) {
    dbg("confirm:show", title);
    const result = await this.wait({
      classes: systemDialogClasses(),   // concatenated onto the static classes
      window: { title, icon },
      content: `<div class="cst-confirm-message">${message}</div>`,
      rejectClose: false,            // dismissing resolves null → treated as "not confirmed"
      buttons: [{
        action: "confirm",
        icon: "fa-solid fa-check",
        label: confirmLabel ?? game.i18n.localize("COMBAT_SPELL_TIMER.Notification.Confirm"),
        default: true,
        callback: () => true
      }]
    });
    return result === true;
  }
}
