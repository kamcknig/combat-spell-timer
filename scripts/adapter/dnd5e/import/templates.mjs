import { warn } from "../../../module.mjs";

/** Base DDB tokens we currently substitute. Extend as more are implemented. */
const HANDLED_TOKENS = new Set(["classlevel", "scalevalue", "limiteduse"]);

/** A token's base name, dropping DDB's `#signed`/`#unsigned` and `@…` suffixes. */
function baseToken(token) {
  return String(token).split("#")[0].split("@")[0].trim().toLowerCase();
}

/**
 * Resolve DDB `{{token}}` template strings in a feature's snippet/description text.
 * `{{classlevel}}` substitutes the numeric class level; `{{scalevalue}}`/`{{limiteduse}}`
 * (DDB uses both names for the same concept) substitute a feature's resolved uses count.
 * Any other `{{token}}` is left in place and reported via the module warn() helper so it
 * can be implemented later. Returns the text unchanged when it contains no tokens.
 * @param {string} text
 * @param {object} [ctx]
 * @param {number} [ctx.classLevel]   value substituted for {{classlevel}}
 * @param {string|number} [ctx.scaleValue]  value substituted for {{scalevalue}}/{{limiteduse}}
 * @param {string} [ctx.featureName]  shown in the unhandled-token warning
 * @returns {string}
 */
export function resolveTemplateStrings(text, { classLevel, scaleValue, featureName } = {}) {
  const src = String(text ?? "");
  if (!src.includes("{{")) return src;

  const tokens = [...new Set(Array.from(src.matchAll(/{{(.*?)}}/g), (m) => m[1].trim()))];
  const unknown = [];
  let out = src;

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`{{\\s*${escaped}\\s*}}`, "g");
    const base = baseToken(token);
    if (base === "classlevel") {
      out = out.replace(pattern, String(classLevel ?? ""));
    } else if (base === "scalevalue" || base === "limiteduse") {
      out = out.replace(pattern, String(scaleValue ?? ""));
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length) {
    warn(`DDB import: unhandled template token(s) in "${featureName ?? "?"}"`, unknown);
  }
  return out;
}
