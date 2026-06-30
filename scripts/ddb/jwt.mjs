/**
 * Base64url → standard base64 decode helper.
 * @param {string} seg  a single base64url segment (no padding required)
 * @returns {string}    raw decoded string
 */
function b64urlDecode(seg) {
  const pad = seg.length % 4 ? "=".repeat(4 - (seg.length % 4)) : "";
  return atob(seg.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/**
 * Decode a JWS payload segment (the middle `.`-delimited part of a JWT).
 * Used on the short-lived Bearer token returned by /proxy/auth, which is a
 * readable JWS JWT signed by DDB (iss:"dndbeyond.com").
 *
 * @param {string} jws  full JWT string
 * @returns {object|null}  parsed claims object, or null if decoding fails
 */
export function decodeJwtPayload(jws) {
  try {
    const p = String(jws ?? "").split(".");
    return p.length >= 2 ? JSON.parse(b64urlDecode(p[1])) : null;
  } catch {
    return null;
  }
}

/**
 * Structural sanity check that a value looks like a CobaltSession JWE.
 *
 * The CobaltSession is an encrypted token (compact JWE). Its payload is
 * encrypted with a key only DDB holds — we cannot read the claims.  But we
 * CAN verify the five-segment structure and confirm the protected header
 * declares `alg:"dir"` (direct symmetric encryption), which is the JWE
 * algorithm DDB uses. A wrong paste (truncated value, plain JWT, arbitrary
 * string) will fail this check immediately without a network round-trip.
 *
 * Accepts the raw cookie value with or without the leading `CobaltSession=`
 * prefix and with or without surrounding quotes (pasting the full header
 * pair is common).
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeCobalt(value) {
  const v = String(value ?? "")
    .trim()
    .replace(/^CobaltSession=/, "")
    .replace(/^["']|["']$/g, "");
  const parts = v.split(".");
  if (parts.length !== 5) return false;
  try {
    return JSON.parse(b64urlDecode(parts[0]))?.alg === "dir";
  } catch {
    return false;
  }
}
