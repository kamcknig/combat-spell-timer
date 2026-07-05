import { warn } from "../../../module.mjs";

/** Base DDB tokens we currently substitute. Extend as more are implemented. */
const HANDLED_TOKENS = new Set(["classlevel", "scalevalue", "limiteduse", "savedc"]);

/** A token's base name, dropping DDB's `#signed`/`#unsigned` and `@…` suffixes. */
function baseToken(token) {
  return String(token).split("#")[0].split("@")[0].trim().toLowerCase();
}

/**
 * Resolve DDB `{{token}}` template strings in a feature's snippet/description text.
 * `{{classlevel}}` substitutes the numeric class level; `{{scalevalue}}`/`{{limiteduse}}`
 * (DDB uses both names for the same concept) substitute a feature's resolved uses count.
 * `{{savedc:str}}` / `{{savedc:str,dex}}` substitutes a LIVE Foundry inline-roll formula
 * (`[[8 + @abilities.str.mod + @prof]]`, or `[[max(...)]]` across abilities when more than
 * one is listed — DDB's own save-DC token lets the character choose whichever ability
 * applies) rather than a static number, mirroring ddb-importer's own resolution of this
 * exact token (verified against its bundled source: it builds the identical
 * `@abilities.<ability>.mod + @prof` roll-data formula). A live formula is deliberately
 * NOT baked into a plain number at import time like classlevel/scalevalue are — a save DC
 * depends on ability modifiers that change with ASIs, and dnd5e's own item-sheet rendering
 * already enriches descriptions with the owning actor's roll data, so the inline roll
 * always shows the character's current, correct DC. Any other `{{token}}` is left in place
 * and reported via the module warn() helper so it can be implemented later. Returns the
 * text unchanged when it contains no tokens.
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
    } else if (base.startsWith("savedc:")) {
      const abilities = base.slice("savedc:".length).split(",").map((a) => a.trim()).filter(Boolean);
      if (abilities.length) {
        const terms = abilities.map((a) => `8 + @abilities.${a}.mod + @prof`);
        const formula = terms.length > 1 ? `max(${terms.join(", ")})` : terms[0];
        out = out.replace(pattern, `[[${formula}]]`);
      } else {
        unknown.push(token);
      }
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length) {
    warn(`DDB import: unhandled template token(s) in "${featureName ?? "?"}"`, unknown);
  }
  return out;
}
