// Per-candidate enrichment lifecycle, keyed by Apollo Person ID.
export const NOT_ENRICHED = 'not_enriched';
export const ENRICHING = 'enriching';
export const REVEALING = 'revealing';
export const SEARCHING_SOURCES = 'searching_sources';
export const REVEALING_PHONE = 'revealing_phone';
export const ENRICHED = 'enriched';
export const FAILED = 'failed';

const LABELS = {
  [NOT_ENRICHED]: 'Not enriched',
  [ENRICHING]: 'Enriching...',
  [REVEALING]: 'Revealing contact details...',
  [SEARCHING_SOURCES]: 'Searching other sources...',
  [REVEALING_PHONE]: 'Revealing phone number...',
  [ENRICHED]: 'Yes',
  [FAILED]: 'Enrichment failed'
};

// A candidate Apollo is already working on is never sent twice, whichever of
// the two paths put it in flight.
const IN_FLIGHT = new Set([ENRICHING, REVEALING, SEARCHING_SOURCES, REVEALING_PHONE]);

export function stateOf(states, id) {
  return (id && states.get(id)) || NOT_ENRICHED;
}

export function enrichmentLabel(state) {
  return LABELS[state] || LABELS[NOT_ENRICHED];
}

// Which selected IDs actually go to Apollo. Already-enriched people are held
// back unless the recruiter explicitly asks for a refresh, and anything
// already in flight is never sent twice.
export function idsToEnrich(ids, states, { refresh = false } = {}) {
  return ids.filter((id) => {
    if (!id) return false;
    const state = stateOf(states, id);
    if (IN_FLIGHT.has(state)) return false;
    if (state === ENRICHED) return refresh;
    return true;
  });
}

// Which selected IDs a reveal actually sends to Apollo. Every reveal spends
// credits, so a candidate Apollo has already been asked about is not paid for
// twice unless the recruiter explicitly refreshes.
//
// The test is contactRevealed, not "has an email". A candidate enriched earlier
// holds a work address, but nobody ever asked Apollo for their contact data, so
// they must stay eligible - otherwise enriching first would permanently block
// the reveal that is the only way to get a personal address. Work already in
// flight is never sent twice.
export function idsToReveal(ids, states, revealed = new Map(), { refresh = false } = {}) {
  return ids.filter((id) => {
    if (!id || IN_FLIGHT.has(stateOf(states, id))) return false;
    if (refresh) return true;
    return !revealed.get(id)?.contactRevealed;
  });
}

// Which selected IDs a phone reveal sends to Apollo. Mobile credits are the
// dearest thing this app spends, so a candidate whose number is already in hand
// is never paid for twice, and one Apollo has already answered "none" for is not
// asked again unless the recruiter explicitly refreshes.
export function idsToRevealPhone(ids, states, revealed = new Map(), { refresh = false } = {}) {
  return ids.filter((id) => {
    if (!id || IN_FLIGHT.has(stateOf(states, id))) return false;
    if (refresh) return true;
    const candidate = revealed.get(id);
    return !candidate?.phone && !candidate?.phoneChecked;
  });
}

export function markState(states, ids, state) {
  const next = new Map(states);
  for (const id of ids) if (id) next.set(id, state);
  return next;
}

// Sorts one /enrich response into outcomes. Pure and independent of any
// previous state, so the callers below can apply it inside a functional
// update and never reconcile against a stale snapshot.
export function reconcile(requestedIds, data = {}) {
  const candidatesByKey = new Map();
  for (const candidate of data.candidates || []) {
    const key = candidate.requestedId || candidate.id;
    if (key) candidatesByKey.set(key, candidate);
  }
  const skippedIds = (data.skippedIds || []).filter(Boolean);
  const skipped = new Set(skippedIds);
  const failedIds = requestedIds.filter((id) => !candidatesByKey.has(id) && !skipped.has(id));
  return {
    candidatesByKey,
    matchedIds: [...candidatesByKey.keys()],
    failedIds,
    skippedIds,
    matched: candidatesByKey.size,
    failed: failedIds.length,
    skipped: skippedIds.length
  };
}

export function applyStates(states, outcome) {
  let next = markState(states, outcome.matchedIds, ENRICHED);
  next = markState(next, outcome.failedIds, FAILED);
  // Skipped by the backend credit cap: never asked, so back to square one.
  return markState(next, outcome.skippedIds, NOT_ENRICHED);
}

// contactRevealed records that this record came back from a request that asked
// Apollo for contact data. Plain enrichment does not ask, so its silence about a
// personal address is not evidence there is none - only a reveal's is.
export function applyEnriched(enriched, outcome, { contactRevealed = false } = {}) {
  const next = new Map(enriched);
  for (const [key, candidate] of outcome.candidatesByKey) {
    next.set(key, contactRevealed ? { ...candidate, contactRevealed: true } : candidate);
  }
  return next;
}

// A waterfall answer carries the person id and whatever the vendors found, and
// nothing else: no name, no title, no company, no employment history. Applying
// it the way an enrichment answer is applied replaced a full candidate record
// with that husk, which is what left rows showing a null name after a search of
// other sources. So a waterfall result is merged over what the row already
// holds, and only fields Apollo actually returned a value for may overwrite.
//
// A boolean is never merged as false: every flag on a candidate record is a
// positive assertion, so a false arriving on a sparse answer is an absence
// rather than a correction. An empty array is an absence for the same reason.
function present(value) {
  if (value === null || value === undefined || value === '' || value === false) return false;
  return Array.isArray(value) ? value.length > 0 : true;
}

export function mergeCandidate(base, incoming) {
  if (!base) return incoming;
  if (!incoming) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (present(value)) merged[key] = value;
  }
  // The row's identity is the ID the recruiter selected, never one echoed back
  // inside an answer.
  merged.id = base.id || incoming.id || null;
  return merged;
}

// Applies a waterfall outcome. `baseById` supplies the record to merge each
// result over when the row has nothing enriched yet - the candidate the search
// returned - so a sparse answer adds contact data instead of erasing the rest.
//
// `checkedIds` are the IDs this answer covers. Apollo finishing with no record
// at all for an ID is still an answer about that ID, so they are marked as
// checked; that is what lets the UI say "no personal email found" for them
// rather than leaving them looking unasked.
export function applyWaterfall(enriched, outcome, { baseById = new Map(), checkedIds = [], mark = { contactRevealed: true, waterfallChecked: true } } = {}) {
  const next = new Map(enriched);

  for (const [key, candidate] of outcome.candidatesByKey) {
    const base = next.get(key) || baseById.get(key) || null;
    next.set(key, { ...mergeCandidate(base, candidate), ...mark });
  }
  for (const id of checkedIds) {
    if (!id || outcome.candidatesByKey.has(id)) continue;
    const base = next.get(id) || baseById.get(id);
    // Nothing known about this row at all: there is no record to annotate, and
    // inventing one would put a candidate on screen that Apollo never returned.
    if (base) next.set(id, { ...base, ...mark });
  }
  return next;
}

// Reveal reports on addresses, not just matches: a candidate Apollo matched but
// has no email for is a real, useful outcome and must not read as a failure.
export function revealSummary(outcome) {
  const { matched, failed, skipped } = outcome;
  const revealed = [...outcome.candidatesByKey.values()];
  const withEmail = revealed.filter((candidate) => candidate.email).length;
  // Reported separately because it is the whole point of a reveal for a
  // recruiter: "an address was found" is not news if it is the work one they
  // could already see.
  const withPersonal = revealed.filter((candidate) => candidate.personalEmail || candidate.emailType === 'personal').length;

  const parts = [`Contact details requested for ${matched} candidate${matched === 1 ? '' : 's'}.`];
  if (!withEmail) parts.push('Apollo returned no email address for these candidates.');
  else if (withPersonal) parts.push(`${withPersonal} personal email${withPersonal === 1 ? '' : 's'} found, and ${withEmail} work address${withEmail === 1 ? '' : 'es'}.`);
  else parts.push(`${withEmail} work address${withEmail === 1 ? '' : 'es'} found, but Apollo holds no personal email for ${matched === 1 ? 'this candidate' : 'any of them'}.`);
  if (failed) parts.push(`${failed} could not be matched.`);
  if (skipped) parts.push(`${skipped} candidate${skipped === 1 ? '' : 's'} were not sent because of the per-request limit. Reveal them in a second batch.`);
  return parts.join(' ');
}

export function enrichmentSummary({ matched, failed, skipped }) {
  const parts = [`Enrichment complete. ${matched} candidate${matched === 1 ? '' : 's'} enriched.`];
  if (failed) parts.push('Unable to enrich this candidate.');
  if (skipped) parts.push(`${skipped} candidate${skipped === 1 ? '' : 's'} were not sent because of the per-request limit. Enrich them in a second batch.`);
  return parts.join(' ');
}
