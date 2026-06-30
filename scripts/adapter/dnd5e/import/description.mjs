import { resolveTemplateStrings } from "./templates.mjs";

/** Loose equality so an identical snippet/description pair doesn't double-render. */
function kindaEqual(a, b) {
  const norm = (s) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Build a `system.description.value` from a DDB definition's snippet + full description.
 * Not feature-specific — any DDB definition (feature, spell, item, trait) shares this
 * snippet/full shape. The snippet is shown, with the full description collapsed under a
 * native <details>More Details</details>; falls back to whichever single text exists when
 * one is empty (or they're effectively equal). Both candidate texts are run through the
 * DDB `{{token}}` substitution pass first, so e.g. `{{classlevel}}` resolves in the
 * snippet that's actually displayed.
 * @param {string} snippet  DDB `.definition.snippet`
 * @param {string} full     DDB `.definition.description`
 * @param {object} [ctx]    { classLevel, featureName } for the template pass
 * @returns {string} HTML
 */
export function buildDdbDescription(snippet, full, ctx = {}) {
  const s = resolveTemplateStrings(snippet, ctx).trim();
  const f = resolveTemplateStrings(full, ctx).trim();
  if (s && f && !kindaEqual(s, f)) {
    return `${s}<br>\n  <details>\n    <summary>\n      More Details\n    </summary>\n    <p>\n      ${f}\n    </p>\n  </details>`;
  }
  return f || s || "";
}
