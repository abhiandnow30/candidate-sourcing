// Per-candidate enrichment lifecycle, keyed by Apollo Person ID.
export const NOT_ENRICHED = 'not_enriched';
export const ENRICHING = 'enriching';
export const ENRICHED = 'enriched';
export const FAILED = 'failed';

const LABELS = {
  [NOT_ENRICHED]: 'Not enriched',
  [ENRICHING]: 'Enriching...',
  [ENRICHED]: 'Yes',
  [FAILED]: 'Enrichment failed'
};

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
    if (state === ENRICHING) return false;
    if (state === ENRICHED) return refresh;
    return true;
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

export function applyEnriched(enriched, outcome) {
  const next = new Map(enriched);
  for (const [key, candidate] of outcome.candidatesByKey) next.set(key, candidate);
  return next;
}

export function enrichmentSummary({ matched, failed, skipped }) {
  const parts = [`Enrichment complete. ${matched} candidate${matched === 1 ? '' : 's'} enriched.`];
  if (failed) parts.push('Unable to enrich this candidate.');
  if (skipped) parts.push(`${skipped} candidate${skipped === 1 ? '' : 's'} were not sent because of the per-request limit. Enrich them in a second batch.`);
  return parts.join(' ');
}
