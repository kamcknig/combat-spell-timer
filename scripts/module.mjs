/** Canonical module id; matches module.json "id" and the flag scope. */
export const MODULE_ID = "combat-spell-timer";

/** Socket channel name Foundry routes module messages on. */
export const SOCKET = `module.${MODULE_ID}`;

/** Namespaced console logger. */
export const log = (...args) => console.log(`${MODULE_ID} |`, ...args);
export const warn = (...args) => console.warn(`${MODULE_ID} |`, ...args);
