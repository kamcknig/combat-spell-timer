import { dbg } from "../utils/debug.mjs";
import { getCobalt } from "./settings.mjs";
import { decodeJwtPayload, looksLikeCobalt } from "./jwt.mjs";

// Our own proxy (foundry-modules-install-tracker, /ddb-importer/* routes). It does
// the CobaltSession→bearer exchange + character fetch server-side (a browser can't).
// LOCAL DEV: pointing at the docker-compose proxy (host 8202 → container 3000).
// Switch back to "https://foundry.turkeysunite-local.org" before release.
const PROXY_BASE = "http://localhost:8202";

const NAMEID = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

/** Typed importer error. `code` selects a user-facing message in the dialog layer. */
export class DdbImportError extends Error {
  /** @param {"invalid-id"|"no-proxy"|"no-cobalt"|"bad-cobalt"|"proxy-unreachable"|"auth"|"not-found"|"ddb"|"http"|"bad-response"} code */
  constructor(code, { status, ddbMessage } = {}) {
    super(`DdbImportError:${code}${status ? ` (${status})` : ""}`);
    this.code = code; this.status = status; this.ddbMessage = ddbMessage;
  }
}

/** Accept a raw numeric id or any dndbeyond URL containing /characters/<id>. */
export function parseCharacterId(input) {
  const s = String(input ?? "").trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/characters\/(\d+)/);   // mirrors ddb-importer's parser
  if (m) return m[1];
  throw new DdbImportError("invalid-id");
}

async function postJson(path, payload) {
  if (!PROXY_BASE) throw new DdbImportError("no-proxy");
  let res;
  try {
    res = await fetch(`${PROXY_BASE}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
  } catch { throw new DdbImportError("proxy-unreachable"); }
  if (res.status === 401 || res.status === 403) throw new DdbImportError("auth", { status: res.status });
  if (res.status === 404)                       throw new DdbImportError("not-found", { status: res.status });
  if (!res.ok)                                  throw new DdbImportError("http", { status: res.status });
  try { return await res.json(); } catch { throw new DdbImportError("bad-response"); }
}

/**
 * Exchange the cobalt for a Bearer and validate its claims.
 * @returns {Promise<{token:string, claims:object, ttl?:number}>}
 * @throws {DdbImportError} no-cobalt | bad-cobalt | no-proxy | proxy-unreachable | auth
 */
export async function authenticate(explicitCobalt) {
  const cobalt = explicitCobalt ?? getCobalt();
  if (!cobalt) throw new DdbImportError("no-cobalt");
  if (!looksLikeCobalt(cobalt)) throw new DdbImportError("bad-cobalt");
  const body = await postJson("/ddb-importer/auth", { cobalt });
  const token = body?.data ?? body?.token;
  if (body?.success === false || !token) throw new DdbImportError("auth", { ddbMessage: body?.message });
  const claims = decodeJwtPayload(token);
  if (!claims || claims.iss !== "dndbeyond.com" || typeof claims.exp !== "number" || !claims[NAMEID]) {
    throw new DdbImportError("auth");
  }
  dbg("ddb:auth", "ok", { user: claims.displayName, exp: claims.exp });
  return { token, claims, ttl: body?.ttl };
}

/**
 * Validate a cobalt (explicit value, else the saved one) for the config UI.
 * Never throws — returns a result.
 * @param {string} [explicitCobalt]
 * @returns {Promise<{ok:boolean, code?:string, name?:string}>}
 */
export async function validateCobalt(explicitCobalt) {
  try { const { claims } = await authenticate(explicitCobalt); return { ok: true, name: claims.displayName ?? claims[NAMEID] }; }
  catch (err) { return { ok: false, code: err instanceof DdbImportError ? err.code : "unknown" }; }
}

/**
 * Fetch a character's raw JSON via the proxy.
 * @param {string|number} input  numeric id or dndbeyond character URL
 * @returns {Promise<object>}    the DDB `.data` character object
 * @throws {DdbImportError}
 */
export async function fetchCharacter(input) {
  const characterId = parseCharacterId(input);
  const cobalt = getCobalt();
  if (!cobalt) throw new DdbImportError("no-cobalt");
  if (!looksLikeCobalt(cobalt)) throw new DdbImportError("bad-cobalt");
  dbg("ddb:fetch", "POST /proxy/character", { characterId });
  const body = await postJson("/ddb-importer/character", { cobalt, characterId, betaKey: "" });
  if (!body || body.success !== true || !body.data) {
    if (body && body.success === false) {
      const msg = String(body.message ?? "");
      throw new DdbImportError(/auth|cobalt|login|expire/i.test(msg) ? "auth" : "ddb", { ddbMessage: msg });
    }
    throw new DdbImportError("bad-response");
  }
  dbg("ddb:fetch", "ok", { name: body.data?.name, id: characterId });
  return body.data;
}
