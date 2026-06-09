/**
 * Convert a dnd5e activity duration ({value, units}) to whole combat rounds.
 * Returns null when the duration is not a finite, trackable time span
 * (instantaneous/special/permanent/dispelled, or a non-numeric value).
 * 1 round = CONFIG.time.roundTime seconds (dnd5e sets this to 6 → 1 min = 10 rounds).
 * @param {{value:number, units:string}} duration
 * @returns {number|null}
 */
export function durationToRounds(duration) {
  const value = Number(duration?.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const roundSeconds = CONFIG.time?.roundTime ?? 6;
  switch (duration.units) {
    case "round":
    case "turn":   return Math.ceil(value);                                  // dnd5e: turn == round == 6s
    case "minute": return Math.ceil((value * 60) / roundSeconds);
    case "hour":   return Math.ceil((value * 3600) / roundSeconds);
    case "day":    return Math.ceil((value * 86400) / roundSeconds);
    case "month":  return Math.ceil((value * 2592000) / roundSeconds);
    case "year":   return Math.ceil((value * 31536000) / roundSeconds);
    default:       return null; // inst, spec, perm, disp, dstr, etc.
  }
}
