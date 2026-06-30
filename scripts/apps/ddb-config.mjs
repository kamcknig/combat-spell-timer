import { dbg } from "../utils/debug.mjs";
import { getCobalt, setCobalt } from "../ddb/settings.mjs";
import { looksLikeCobalt } from "../ddb/jwt.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * GM-only configuration dialog for the D&D Beyond cobalt session cookie.
 * Allows the GM to paste, save, clear, and validate the CobaltSession value
 * used to authenticate with the DDB import proxy.
 *
 * Opened from the module settings menu entry registered by `registerDdbImporterSettings`.
 */
export default class DdbConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "combat-spell-timer-ddb-config",
    tag: "form",
    classes: ["combat-spell-timer", "cst-ddb-config"],
    window: {
      title: "COMBAT_SPELL_TIMER.Ddb.Config.Title",
      icon: "fa-solid fa-dungeon"
    },
    position: { width: 480, height: "auto" },
    form: { handler: DdbConfig.#onSubmit, closeOnSubmit: true },
    actions: {
      clearCobalt: DdbConfig.#onClearCobalt,
      validate: DdbConfig.#onValidate
    }
  };

  static PARTS = {
    form: { template: "modules/combat-spell-timer/templates/ddb-config.hbs" }
  };

  /** When opened on a player's behalf: `{ requesterName }`; otherwise null. */
  #requestContext = null;
  /** Resolver for the `requestCobalt()` promise, if opened in request mode. */
  #requestResolve = null;
  /** Guards against resolving the request promise more than once. */
  #settled = false;

  /**
   * Open the cobalt dialog and resolve when it closes: `true` if a cobalt was
   * saved, `false` if dismissed. Used to prompt a GM to enter a cobalt on a
   * player's behalf — pass the requesting player's name to show the banner.
   * @param {string|null} [requesterName]
   * @returns {Promise<boolean>}
   */
  static requestCobalt(requesterName = null) {
    return new Promise((resolve) => {
      const app = new this();
      app.#requestContext = { requesterName };
      app.#requestResolve = resolve;
      app.render(true);
    });
  }

  /** Resolve the request promise once (no-op on subsequent calls). */
  #settle(result) {
    if (this.#settled) return;
    this.#settled = true;
    const resolve = this.#requestResolve;
    this.#requestResolve = null;
    resolve?.(result);
  }

  /** Resolve a pending request as "not provided" when the dialog is dismissed. */
  _onClose(options) {
    super._onClose(options);
    this.#settle(false);
  }

  /**
   * Supply the render context. The textarea is intentionally left empty — we
   * never echo the saved cobalt back to the page. `hasCobalt` controls the
   * "currently saved" hint; `requesterName` (request mode) shows the banner.
   * @param {object} _options
   * @returns {Promise<{hasCobalt: boolean, requesterName: (string|null)}>}
   */
  async _prepareContext(_options) {
    return { hasCobalt: !!getCobalt(), requesterName: this.#requestContext?.requesterName ?? null };
  }

  /**
   * Form submit handler (Save button). Strip the `CobaltSession=` prefix and
   * any surrounding quotes that may appear when pasting the raw cookie pair.
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} formData
   */
  static async #onSubmit(event, form, formData) {
    await setCobalt(DdbConfig.#normalizeCobalt(formData.object.cobalt));
    dbg("ddb:config", "saved");
    ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.Saved"));
    this.#settle(true);   // request mode: a cobalt was provided
  }

  /**
   * Normalize a pasted cobalt: trim, drop a leading `CobaltSession=` and any
   * surrounding quotes left over from copying the raw cookie pair.
   * @param {string} raw
   * @returns {string}
   */
  static #normalizeCobalt(raw) {
    return (raw ?? "")
      .trim()
      .replace(/^CobaltSession=/, "")
      .replace(/^["']|["']$/g, "");
  }

  /**
   * Clear the saved cobalt and re-render so the "currently saved" hint
   * disappears without requiring a full close/reopen.
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onClearCobalt(event, target) {
    await setCobalt("");
    dbg("ddb:config", "cleared");
    this.render();
  }

  /**
   * Validate the currently-saved cobalt.
   *
   * Phase 1: performs the local structural check via `looksLikeCobalt`.  If
   * that passes, attempts a dynamic import of `validateCobalt` from
   * `../ddb/client.mjs` (Phase 2).  The import will fail until Phase 2 is
   * built — the catch block shows "proxy not configured" so the button is
   * still informative and the app continues to function.
   *
   * Never logs the cobalt value itself.
   *
   * @param {Event} event
   * @param {HTMLElement} target
   */
  static async #onValidate(event, target) {
    dbg("ddb:config", "validate requested");

    // Validate what's typed in the textarea; fall back to the saved value only
    // when the field is empty (e.g. reopening to re-check an already-saved cobalt).
    const typed = DdbConfig.#normalizeCobalt(
      this.element.querySelector('textarea[name="cobalt"]')?.value
    );
    const cobalt = typed || getCobalt();

    if (!cobalt) {
      dbg("ddb:config", "validate: nothing to validate");
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidBad"));
      return;
    }
    // Local structural check — no network required.
    if (!looksLikeCobalt(cobalt)) {
      // Most common mistake: pasting the 3-part cobalt-token/bearer (a JWS)
      // instead of the 5-part CobaltSession cookie (a JWE with a `..` in it).
      const segs = cobalt.split(".").length;
      console.warn(
        `${"combat-spell-timer"} | cobalt failed shape check: ${segs} dot-segment(s) (CobaltSession has 5, with an empty 2nd). Did you paste the cobalt-token instead?`
      );
      dbg("ddb:config", "validate: structural fail", { segments: segs, fromInput: !!typed });
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidBad"));
      return;
    }

    // Shape is valid. A real (live) check requires the proxy round-trip, which
    // needs client.mjs (Phase 2) and a configured PROXY_BASE. Until both exist,
    // a shape-valid cobalt is reported as a (pending) success, not a failure.
    let validateCobalt;
    try {
      ({ validateCobalt } = await import("../ddb/client.mjs"));
    } catch {
      // client.mjs not yet built — nothing to round-trip against.
      dbg("ddb:config", "validate: client.mjs unavailable — format ok, live check pending");
      ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidFormatOk"));
      return;
    }

    ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.Validating"));
    const result = await validateCobalt(cobalt);
    if (result.ok) {
      dbg("ddb:config", "validate: ok");
      ui.notifications?.info(
        game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Config.ValidOk", { name: result.name ?? "?" })
      );
      return;
    }

    const code = result.code ?? "unknown";
    dbg("ddb:config", "validate: failed", { code });
    if (code === "no-proxy") {
      // Shape ok, proxy not configured yet — a pending success, not a failure.
      ui.notifications?.info(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidFormatOk"));
    } else if (code === "proxy-unreachable") {
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidUnreachable"));
    } else {
      // auth / bad-cobalt / unknown → expired or rejected
      ui.notifications?.warn(game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Config.ValidAuth"));
    }
  }
}
