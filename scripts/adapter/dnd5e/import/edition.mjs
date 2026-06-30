// 2024 ("modern") DnD Beyond class definitions carry very large ids (e.g. Fighter 2024 =
// 2190879); 2014 classes carry small legacy ids (Fighter 2014 = 10). A threshold cleanly
// splits them. Extend with an explicit override set if any class ever breaks the pattern.
const ID_2024_THRESHOLD = 1_000_000;
const KNOWN_2024_IDS = new Set([2190879 /* Fighter 2024 */]);
const KNOWN_2014_IDS = new Set([10      /* Fighter 2014 */]);

/**
 * Edition of a DDB class from its `definition.id`. "2014" | "2024" for system.source.rules.
 * @param {number} definitionId  ddbClass.definition.id
 */
export function classEditionRules(definitionId) {
  const id = Number(definitionId);
  if (KNOWN_2024_IDS.has(id)) return "2024";
  if (KNOWN_2014_IDS.has(id)) return "2014";
  return Number.isFinite(id) && id >= ID_2024_THRESHOLD ? "2024" : "2014";
}

/** Strip a trailing "(2014)"/"(2024)" parenthetical DDB may include in a name. */
export function cleanDdbName(name) {
  return String(name ?? "").replace(/\s*\((?:2014|2024)\)\s*$/i, "").trim();
}
