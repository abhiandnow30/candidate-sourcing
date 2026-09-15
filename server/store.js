import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// A local record of what Apollo has already been paid for.
//
// Enrichment, a revealed email and a phone number each cost credits, and each
// answer is the same the next time it is asked for. Holding them means a
// candidate looked at twice - tomorrow, or by the same recruiter after a
// restart - is paid for once. The app already avoided asking twice inside a
// single session; everything here is about surviving the end of one.
//
// Nothing derived is stored: the row is Apollo's own answer, normalised, and it
// is served back only for the kind of request that paid for it. An enrichment
// never satisfies a reveal, because it never held a personal address to begin
// with.
//
// It is a cache, not a source of truth. Every entry carries the time it was
// written and expires, because people change jobs and addresses stop working;
// and "Refresh from Apollo" ignores it entirely, so a recruiter who suspects a
// record is stale is never stuck with it.

// Three months. Long enough that a role worked over weeks costs one credit,
// short enough that an address is unlikely to have died in the meantime.
const DEFAULT_TTL_DAYS = 90;

// Which timestamp a request needs, by what it would otherwise pay for.
// Whether an incoming field actually says something, and so may overwrite what
// is already stored.
//
// A sparse answer - a waterfall husk, a phone webhook payload, a plain search
// row - carries empty arrays and `false` for every field it simply does not
// speak to. Treating those as statements is what let a phone result wipe the
// skills and employment history of a candidate already paid for, while leaving
// `enriched: true` on the row so the details panel showed "Not available" for
// all of it.
//
// Same rule as `present()` on the client, so both sides of the wire merge a
// sparse record identically: every flag on a candidate is a positive assertion,
// so a `false` arriving on a sparse answer is an absence, not a correction.
export function present(value) {
  if (value === null || value === undefined || value === '' || value === false) return false;
  return Array.isArray(value) ? value.length > 0 : true;
}

// The fields where `false` is Apollo's own assertion rather than an absence.
//
// Everywhere else a `false` on a sparse answer means "this record does not
// speak to that", so it must not overwrite. These two are tri-state - `null` is
// the unknown - so `false` is a statement, and it has to be allowed to correct
// a stored `true`. Without this a stale `hasPhoneOnFile: true` survives every
// later search, and the client's credit guard (`hasPhoneOnFile !== false`) then
// spends a mobile credit on somebody Apollo has just said it holds no number
// for - the dearest thing this app can get wrong.
const ASSERTED_WHEN_FALSE = new Set(['hasEmailOnFile', 'hasPhoneOnFile']);

// Only the fields an answer actually states, for merging over a stored record.
export function stated(candidate) {
  return Object.fromEntries(Object.entries(candidate)
    .filter(([key, value]) => present(value) || (value === false && ASSERTED_WHEN_FALSE.has(key))));
}

export const NEEDS_ENRICHED = 'enriched_at';
export const NEEDS_REVEALED = 'revealed_at';
export const NEEDS_PHONE = 'phone_at';

const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;

function ttlMs() {
  const days = Number(process.env.CANDIDATE_CACHE_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
}

export function cacheDisabled() {
  return process.env.CANDIDATE_CACHE === 'off';
}

function connection() {
  if (db) return db;
  // Tests get a database that never touches the disk, so a suite cannot leave
  // rows behind for the next run to trip over.
  const file = process.env.NODE_ENV === 'test'
    ? ':memory:'
    : process.env.CANDIDATE_CACHE_PATH || path.join(here, 'data', 'candidates.sqlite');
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      enriched_at INTEGER,
      revealed_at INTEGER,
      phone_at INTEGER
    );
  `);
  return db;
}

// The candidates already paid for, out of the ones asked about. `need` says
// which credit this request would spend, so a row that was only ever enriched
// does not answer a reveal.
export function readCached(ids, need) {
  if (cacheDisabled() || !ids.length) return new Map();
  const cutoff = Date.now() - ttlMs();
  const rows = connection()
    .prepare(`SELECT id, data, ${need} AS stamp FROM candidates WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const found = new Map();
  for (const row of rows) {
    if (!row.stamp || row.stamp < cutoff) continue;
    try {
      found.set(row.id, { ...JSON.parse(row.data), fromCache: true });
    } catch {
      // A row we cannot read is a row we do not have: the candidate is asked
      // for again rather than served as a corrupt record.
    }
  }
  return found;
}

// Writes what Apollo just answered. `marks` says which credits this answer
// covers, and only those timestamps move: a phone job must not make the record
// look like a revealed email.
export function saveCandidates(candidates, marks = {}) {
  if (cacheDisabled()) return;
  // Keyed by the id the client asked about, never the canonical one Apollo may
  // echo back in its place. `requestedId` exists precisely because those differ,
  // and `readCached` looks rows up by what the client sent - so a row written
  // under Apollo's id was stored where nothing would ever look for it, and the
  // candidate was paid for again on every future request.
  const keyOf = (candidate) => {
    const key = candidate.requestedId || candidate.id;
    return typeof key === 'string' && key !== '' ? key : null;
  };
  const usable = candidates.filter((candidate) => candidate && keyOf(candidate));
  if (!usable.length) return;
  const now = Date.now();
  const database = connection();
  // The stored row is merged over whatever is already there, so a phone number
  // arriving later joins the enrichment rather than replacing it with a record
  // that has lost its employment history.
  const read = database.prepare('SELECT data FROM candidates WHERE id = ?');
  const write = database.prepare(`
    INSERT INTO candidates (id, data, enriched_at, revealed_at, phone_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      enriched_at = COALESCE(excluded.enriched_at, candidates.enriched_at),
      revealed_at = COALESCE(excluded.revealed_at, candidates.revealed_at),
      phone_at = COALESCE(excluded.phone_at, candidates.phone_at)
  `);
  for (const candidate of usable) {
    const key = keyOf(candidate);
    let merged = candidate;
    const existing = read.get(key);
    if (existing?.data) {
      try {
        const previous = JSON.parse(existing.data);
        merged = { ...previous, ...stated(candidate) };
      } catch { /* unreadable row: this answer replaces it outright */ }
    }
    // `fromCache` describes how a record reached the client, not the record, so
    // it is never written.
    const { fromCache, ...stored } = merged;
    write.run(
      key,
      JSON.stringify(stored),
      marks.enriched ? now : null,
      marks.revealed ? now : null,
      marks.phone ? now : null
    );
  }
}

// Test seam: the suite shares one process, so each case starts from empty.
export function clearCache() {
  if (!db) return;
  db.exec('DELETE FROM candidates');
}
