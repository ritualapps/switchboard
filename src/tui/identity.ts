/**
 * Per-line visual identity.
 *
 * Each line gets a stable (pictograph + colour) pair derived
 * deterministically from its session id. The assignment maps 1:1 to the
 * Switchboard robot family so the single-cell pictograph shown here can
 * later scale up to richer block art while keeping the identity the
 * operator has already learned.
 *
 * Slot order follows a colour-wheel sweep (orange -> yellow -> green ->
 * cyan -> blue -> purple -> pink -> earth/neutrals). BUNEEBOT and
 * RAINBOWBOT sit at the diagonal centre of the 3x3 preview grid (slots
 * 6 and 7).
 */

export interface LineIdentity {
  slot: number;
  pictograph: string;
  colour: string;
  name: string;
}

// Every family glyph must be East-Asian-Width unambiguous so terminal
// column math stays aligned (enforced by the glyph-width test). Ambiguous
// chars render 2 cells in many fonts while ink's string-width measurement
// reports 1, which desyncs every column to their right. Add only
// EAW-Neutral / Narrow glyphs here.
export const ROBOT_FAMILY: readonly LineIdentity[] = [
  { slot: 1, pictograph: '⊠', colour: '#FF8C42', name: 'WIDEBOT' },
  { slot: 2, pictograph: '⌬', colour: '#FFD43B', name: 'ANTENNA-BOT' },
  { slot: 3, pictograph: '▴', colour: '#4ADE80', name: 'PEAKBOT' },
  { slot: 4, pictograph: '⩙', colour: '#5DD4FF', name: 'SPIKEBOT' },
  { slot: 5, pictograph: '⊟', colour: '#4DA6FF', name: 'BENBOT' },
  { slot: 6, pictograph: '⑂', colour: '#B967DB', name: 'BUNEEBOT' },
  { slot: 7, pictograph: '◠', colour: '#FF6FAA', name: 'RAINBOWBOT' },
  { slot: 8, pictograph: '⊚', colour: '#D87A3D', name: 'EGGBOT' },
  { slot: 9, pictograph: '↥', colour: '#D8D8D8', name: 'ROCKETBOT' },
] as const;

/**
 * FNV-1a hash. Stable across runs and platforms; we only need an integer
 * for modular slot assignment, not cryptographic quality.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function identityForSession(sessionId: string): LineIdentity {
  const slotIndex = fnv1a(sessionId) % ROBOT_FAMILY.length;
  return ROBOT_FAMILY[slotIndex]!;
}
