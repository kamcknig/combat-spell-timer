import { SOCKET, MODULE_ID, warn } from "../module.mjs";
import { getCobalt, IMPORTER_FLAG } from "../ddb/settings.mjs";
import { fetchCharacter, DdbImportError } from "../ddb/client.mjs";
import DdbConfig from "../apps/ddb-config.mjs";
import { dbg } from "../utils/debug.mjs";
import { getAdapter } from "../adapter/index.mjs";

/** Per-actor flag: the DDB character id (pre-fills the prompt next time). */
export const ID_FLAG = "ddbCharacterId";
/** Per-actor flag: the cached raw `.data` character object. */
export const SRC_FLAG = "ddbSource";
/** Per-item flag: marks an item this module created during a DDB import. */
export const IMPORT_FLAG = "ddbImport";

/** Delete items this module created on a prior import (clean-slate re-import). */
async function removePriorImportItems(actor) {
  const ids = actor.items.filter((i) => i.getFlag(MODULE_ID, IMPORT_FLAG)).map((i) => i.id);
  if (!ids.length) return;
  dbg("ddb:import", "removing prior import items", { actor: actor.id, count: ids.length });
  await actor.deleteEmbeddedDocuments("Item", ids);
}

/**
 * Create parsed feature items on the actor. Tries one batched create first; if that
 * throws, falls back to creating items one at a time so a single bad item doesn't sink
 * the rest — items that still fail are logged as a console warning.
 * @param {Actor} actor
 * @param {object[]} items
 * @returns {Promise<number>} count of items actually created
 */
async function createFeatureItems(actor, items) {
  try {
    await actor.createEmbeddedDocuments("Item", items, { keepId: true });
    return items.length;
  } catch (batchErr) {
    dbg("ddb:import", "batch feature create failed, retrying individually", { error: batchErr?.message });
  }

  let created = 0;
  const failed = [];
  for (const item of items) {
    try {
      await actor.createEmbeddedDocuments("Item", [item], { keepId: true });
      created++;
    } catch (itemErr) {
      failed.push({ name: item?.name, type: item?.type, error: itemErr?.message });
    }
  }
  if (failed.length) {
    warn(`DDB import: ${failed.length} feature item(s) failed to create`, failed);
  }
  return created;
}

/** Online GMs, lowest-id first (deterministic across clients). */
function onlineGms() {
  return game.users.filter((u) => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The single GM that already holds a cobalt: the lowest-id online GM advertising
 * the `IMPORTER_FLAG`. null if none.
 * @returns {User|null}
 */
export function pickImporter() {
  return onlineGms().find((u) => u.getFlag(MODULE_ID, IMPORTER_FLAG)) ?? null;
}

/**
 * Who should handle an import: the cobalt-holding GM if there is one, otherwise
 * any online GM (who will be prompted to enter a cobalt). null if no GM online.
 * Computed identically on every client, so exactly one GM ever acts, and it
 * fails over automatically as GMs connect/disconnect.
 * @returns {User|null}
 */
export function pickImportHandler() {
  return pickImporter() ?? onlineGms()[0] ?? null;
}

/**
 * Requester side: route an import to the handler GM (or run it here if that's
 * us). Shows a local notification when no GM is connected.
 * @param {string} actorUuid
 * @param {string|number} characterId
 */
export function requestImport(actorUuid, characterId) {
  const handler = pickImportHandler();
  if (!handler) {
    dbg("ddb:import", "no GM online");
    return showImportResult({ ok: false, code: "no-importer" });
  }
  const msg = { action: "ddbImport", actorUuid, characterId: String(characterId), userId: game.user.id };
  if (handler.isSelf) return gmImport(msg);
  dbg("ddb:import", "routing to handler", { handler: handler.name });
  game.socket.emit(SOCKET, msg);
  ui.notifications?.info(game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Import.Routed", { gm: handler.name }));
}

/**
 * Handler side: use our cobalt if we have one, otherwise prompt for it first
 * (showing who's requesting), then perform the import.
 * @param {{actorUuid:string, characterId:string, userId:string}} msg
 */
async function gmImport(msg) {
  if (getCobalt()) return doImport(msg);

  // No cobalt on this GM — open the cobalt dialog, flagged with the requester's
  // name when someone else asked. Reuses the normal config modal.
  const requesterName =
    msg.userId !== game.user.id ? (game.users.get(msg.userId)?.name ?? null) : null;
  dbg("ddb:import", "prompting handler for cobalt", { requesterName });
  const saved = await DdbConfig.requestCobalt(requesterName);
  if (!saved || !getCobalt()) {
    dbg("ddb:import", "handler declined / no cobalt entered");
    return sendResult(msg.userId, { ok: false, code: "declined" });
  }
  return doImport(msg);
}

/** Handler side: fetch the character and write it onto the actor; return the outcome. */
async function doImport(msg) {
  const actor = await fromUuid(msg.actorUuid).catch(() => null);
  if (!actor) return sendResult(msg.userId, { ok: false, code: "no-actor" });
  dbg("ddb:import", "importing", { actor: actor.id, requestedBy: msg.userId });
  try {
    const data = await fetchCharacter(msg.characterId);
    await actor.setFlag(MODULE_ID, ID_FLAG, msg.characterId);
    await actor.setFlag(MODULE_ID, SRC_FLAG, data);
    dbg("ddb:import", "imported", { actor: actor.id, name: data?.name });

    let created = 0;
    try {
      const parsed = await getAdapter().parseImportedFeatures(actor, data);
      await removePriorImportItems(actor);
      if (parsed.items?.length) {
        created = await createFeatureItems(actor, parsed.items);
      }
      dbg("ddb:import", "features created", { actor: actor.id, created });
    } catch (featErr) {
      // Non-fatal: the raw data is already cached; report a partial result.
      dbg("ddb:import", "feature creation failed", { error: featErr?.message });
    }

    sendResult(msg.userId, {
      ok: true,
      name: data?.name ?? "?",
      cls: data?.classes?.[0]?.definition?.name ?? "?",
      level: (data?.classes ?? []).reduce((n, c) => n + (c.level ?? 0), 0) || "?",
      created,
    });
  } catch (err) {
    const code = err instanceof DdbImportError ? err.code : "unknown";
    dbg("ddb:import", "import failed", { code, status: err?.status });
    sendResult(msg.userId, { ok: false, code });
  }
}

/** Deliver a result to the requesting user — locally if it's us, else over the socket. */
function sendResult(userId, payload) {
  if (userId === game.user.id) return showImportResult(payload);
  game.socket.emit(SOCKET, { action: "ddbImportResult", userId, ...payload });
}

/**
 * Requester side: notify success or (code-specific) failure.
 * @param {{ok:boolean, code?:string, name?:string, cls?:string, level?:(string|number), created?:number}} payload
 */
export function showImportResult(payload) {
  if (payload.ok) {
    const body = game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Import.SuccessBody", {
      name: payload.name ?? "?",
      cls: payload.cls ?? "?",
      level: payload.level ?? "?",
    });
    const created = payload.created ?? 0;
    const featureLine = created
      ? game.i18n.format("COMBAT_SPELL_TIMER.Ddb.Import.FeaturesAdded", { count: created })
      : "";
    ui.notifications?.info(featureLine ? `${body} ${featureLine}` : body);
    return;
  }
  const code = payload.code ?? "unknown";
  ui.notifications?.error(
    game.i18n.localize(`COMBAT_SPELL_TIMER.Ddb.Import.Error.${code}`) ||
      game.i18n.localize("COMBAT_SPELL_TIMER.Ddb.Import.Error.unknown")
  );
}

/**
 * Socket delegate for DDB import traffic. Returns true if the message was a DDB
 * action (so the timer socket handler can ignore it).
 * - `ddbImport`: only the elected handler GM acts.
 * - `ddbImportResult`: only the addressed requester acts.
 * @param {object} msg
 * @returns {boolean}
 */
export function handleDdbSocket(msg) {
  if (msg?.action === "ddbImport") {
    if (pickImportHandler()?.isSelf) gmImport(msg);
    return true;
  }
  if (msg?.action === "ddbImportResult") {
    if (msg.userId === game.user.id) showImportResult(msg);
    return true;
  }
  return false;
}
