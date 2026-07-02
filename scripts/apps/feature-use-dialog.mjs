import { ConfirmationDialog, systemDialogClasses } from "./confirmation-dialog.mjs";
import { dbg } from "../utils/debug.mjs";

/**
 * Reusable two-button prompt for "use this feature" flows: title, message, and
 * two horizontally centered buttons — USE (consumes the feature's resource and
 * announces it) and CHAT (posts the same announcement without consuming
 * anything, e.g. for narration). Extends ConfirmationDialog purely to reuse its
 * title-header rendering and dialog CSS — NOT its NotificationDialog sibling's
 * "don't show again" receipt semantics, which don't apply to a resource-use
 * prompt. This is the standard shape for any feature needing its own
 * activation dialog instead of dnd5e's native Ability Use dialog — see
 * CLAUDE.md's "Feature activation dialogs" section.
 */
export class FeatureUseDialog extends ConfirmationDialog {
  static DEFAULT_OPTIONS = {
    classes: ["cst-feature-use-dialog"]
  };

  /**
   * @param {object} config
   * @param {string} config.title           Window title (already localized).
   * @param {string} [config.message]       Body HTML (already localized; trusted).
   * @param {string} [config.icon]          FontAwesome classes for the window icon.
   * @param {string} [config.useLabel]      Override the USE button label.
   * @param {string} [config.chatLabel]     Override the CHAT button label.
   * @param {boolean} [config.canUse]       Whether USE is available (e.g. uses remain).
   *   Disables the USE button (CHAT is unaffected — it never consumes anything)
   *   rather than letting the caller find out only after clicking. Default true.
   * @returns {Promise<"use"|"chat"|null>}  null when dismissed.
   */
  static async prompt({ title, message = "", icon = "fa-solid fa-bolt", useLabel, chatLabel, canUse = true } = {}) {
    dbg("feature-use:prompt", title, { canUse });
    const result = await this.wait({
      classes: systemDialogClasses(),
      window: { title, icon },
      content: `<div class="cst-confirm-message">${message}</div>`,
      rejectClose: false,
      buttons: [
        {
          action: "use",
          icon: "fa-solid fa-check",
          label: useLabel ?? game.i18n.localize("COMBAT_SPELL_TIMER.Notification.Use"),
          default: canUse,
          disabled: !canUse,
          callback: () => "use",
        },
        {
          action: "chat",
          icon: "fa-solid fa-comment",
          label: chatLabel ?? game.i18n.localize("COMBAT_SPELL_TIMER.Notification.Chat"),
          default: !canUse,
          callback: () => "chat",
        },
      ],
    });
    return result ?? null;
  }
}
