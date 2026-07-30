/* Studio session — the "where was I?" half of draft recovery.
 *
 * The DESIGN of a registered connector lives on the server (a draft version). Two things
 * cannot live there, and this module holds both in localStorage:
 *
 *   1. The RESUME POINTER — which connector/version/stage the author last had open. It is
 *      per-person and per-machine, not a property of the draft, and it must survive a
 *      closed browser, so sessionStorage (what the Wizard uses) is not enough.
 *   2. The PRE-REGISTRATION SEED — Stage 1 form values typed before `POST /api/connectors`
 *      has run. Until registration there is no draft to save into, and abandoning a
 *      half-typed name should not litter the registry with junk connectors.
 *
 * Both are keyed by user id: a shared machine must not resume someone else's work.
 * Neither ever holds credentials — Stage 5's sample credentials stay in memory only.
 */

const SESSION_KEY = 'synapseStudioSession';
const SEED_KEY = 'synapseStudioSeed';

/* Resume straight into the authoring flow only if the author was there recently. Older
 * than this and silently hijacking their navigation is presumptuous — they get an
 * offer instead. */
export const AUTO_RESUME_MS = 30 * 60 * 1000;

/* A seed is a rescue for work in progress, not an archive. Two weeks is long enough to
 * cover a holiday and short enough that a stale half-typed form does not greet someone
 * forever. */
const SEED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const read = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }        // private mode, quota, or hand-edited junk
};

const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* non-fatal */ }
};

const drop = (key) => {
  try { localStorage.removeItem(key); } catch { /* non-fatal */ }
};

const mine = (row, userId) => !!row && (row.userId ?? null) === (userId ?? null);

// ── Resume pointer ────────────────────────────────────────────────────────
/** The last place this user was in Studio, or null. */
export function readSession(userId) {
  const s = read(SESSION_KEY);
  return mine(s, userId) ? s : null;
}

/** Merge into the pointer — callers update one field (the stage) without re-stating the rest. */
export function writeSession(userId, patch) {
  const prev = readSession(userId) ?? {};
  write(SESSION_KEY, { ...prev, ...patch, userId: userId ?? null, savedAt: new Date().toISOString() });
}

export function clearSession() { drop(SESSION_KEY); }

/** Fresh enough to reopen without asking? */
export function isFresh(session, now = Date.now()) {
  if (!session?.savedAt) return false;
  const at = new Date(session.savedAt).getTime();
  return Number.isFinite(at) && now - at < AUTO_RESUME_MS;
}

// ── Pre-registration seed ─────────────────────────────────────────────────
export function readSeed(userId, now = Date.now()) {
  const s = read(SEED_KEY);
  if (!mine(s, userId)) return null;
  const at = new Date(s.savedAt ?? 0).getTime();
  if (!Number.isFinite(at) || now - at > SEED_TTL_MS) { drop(SEED_KEY); return null; }
  return s;
}

export function writeSeed(userId, seed) {
  write(SEED_KEY, { ...seed, userId: userId ?? null, savedAt: new Date().toISOString() });
}

export function clearSeed() { drop(SEED_KEY); }

/** Compact "47m" / "2h" / "3d" — for card metadata that must never wrap to a second line. */
export function sinceShort(iso) {
  const t = new Date(iso ?? 0).getTime();
  if (!Number.isFinite(t) || t === 0) return 'now';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** Human "4 min ago" for the drafts rail and the resume banner. */
export function sinceLabel(iso) {
  const t = new Date(iso ?? 0).getTime();
  if (!Number.isFinite(t) || t === 0) return 'just now';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
