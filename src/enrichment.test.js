import { describe, expect, test } from 'vitest';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED, REVEALING,
  applyEnriched, applyStates, applyWaterfall, enrichmentLabel, enrichmentSummary, idsToEnrich, idsToReveal,
  markState, mergeCandidate, reconcile, revealSummary, stateOf
} from './enrichment.js';

const states = (entries) => new Map(entries);

describe('enrichment lifecycle', () => {
  test('labels each state for the Enriched column', () => {
    expect(enrichmentLabel(NOT_ENRICHED)).toBe('Not enriched');
    expect(enrichmentLabel(ENRICHING)).toBe('Enriching...');
    expect(enrichmentLabel(ENRICHED)).toBe('Enriched');
    expect(enrichmentLabel(FAILED)).toBe('Enrichment failed');
  });

  test('defaults an unknown candidate to not_enriched', () => {
    expect(stateOf(states([]), 'person-1')).toBe(NOT_ENRICHED);
    expect(stateOf(states([]), null)).toBe(NOT_ENRICHED);
  });

  test('holds back candidates already enriched this session', () => {
    const current = states([['person-1', ENRICHED], ['person-2', NOT_ENRICHED]]);
    expect(idsToEnrich(['person-1', 'person-2'], current)).toEqual(['person-2']);
  });

  test('re-sends an enriched candidate only on an explicit refresh', () => {
    const current = states([['person-1', ENRICHED]]);
    expect(idsToEnrich(['person-1'], current)).toEqual([]);
    expect(idsToEnrich(['person-1'], current, { refresh: true })).toEqual(['person-1']);
  });

  test('never re-sends a candidate whose request is still in flight', () => {
    const current = states([['person-1', ENRICHING]]);
    expect(idsToEnrich(['person-1'], current)).toEqual([]);
    expect(idsToEnrich(['person-1'], current, { refresh: true })).toEqual([]);
  });

  test('allows a failed candidate to be retried', () => {
    expect(idsToEnrich(['person-1'], states([['person-1', FAILED]]))).toEqual(['person-1']);
  });

  test('drops candidates with no Apollo person ID', () => {
    expect(idsToEnrich([null, undefined, '', 'person-1'], states([]))).toEqual(['person-1']);
  });

  test('markState does not mutate the previous map', () => {
    const before = states([['person-1', NOT_ENRICHED]]);
    const after = markState(before, ['person-1'], ENRICHING);
    expect(before.get('person-1')).toBe(NOT_ENRICHED);
    expect(after.get('person-1')).toBe(ENRICHING);
  });
});

describe('reconcile', () => {
  const requested = ['person-1', 'person-2', 'person-3'];

  test('buckets matches by the ID we asked about, not the ID Apollo echoed', () => {
    const outcome = reconcile(requested, {
      candidates: [{ requestedId: 'person-1', id: 'apollo-canonical-1', name: 'Test Candidate' }],
      failedIds: ['person-2', 'person-3']
    });
    expect(outcome.matchedIds).toEqual(['person-1']);
    expect(outcome.candidatesByKey.get('person-1').name).toBe('Test Candidate');
    expect(outcome.matched).toBe(1);
  });

  test('treats every unmatched requested ID as failed', () => {
    const outcome = reconcile(requested, { candidates: [{ requestedId: 'person-1', id: 'person-1' }], failedIds: ['person-2'] });
    expect(outcome.failedIds).toEqual(['person-2', 'person-3']);
    expect(outcome.failed).toBe(2);
  });

  test('separates IDs the backend skipped from IDs Apollo declined', () => {
    const outcome = reconcile(requested, {
      candidates: [{ requestedId: 'person-1', id: 'person-1' }],
      failedIds: ['person-2'],
      skippedIds: ['person-3']
    });
    expect(outcome.failedIds).toEqual(['person-2']);
    expect(outcome.skippedIds).toEqual(['person-3']);
  });

  test('every requested ID lands in exactly one bucket', () => {
    const outcome = reconcile(requested, {
      candidates: [{ requestedId: 'person-1', id: 'person-1' }],
      skippedIds: ['person-3']
    });
    const all = [...outcome.matchedIds, ...outcome.failedIds, ...outcome.skippedIds];
    expect(all.sort()).toEqual([...requested].sort());
    expect(new Set(all).size).toBe(requested.length);
  });
});

describe('applying an outcome', () => {
  test('records matches enriched, failures failed, and skipped back to square one', () => {
    const outcome = reconcile(['person-1', 'person-2', 'person-3'], {
      candidates: [{ requestedId: 'person-1', id: 'person-1' }],
      failedIds: ['person-2'],
      skippedIds: ['person-3']
    });
    const next = applyStates(states([['person-3', ENRICHING]]), outcome);
    expect(next.get('person-1')).toBe(ENRICHED);
    expect(next.get('person-2')).toBe(FAILED);
    expect(next.get('person-3')).toBe(NOT_ENRICHED);
  });

  test('keeps candidates enriched by earlier requests', () => {
    const outcome = reconcile(['person-1'], { candidates: [{ requestedId: 'person-1', id: 'person-1', name: 'New Candidate' }] });
    const priorStates = states([['person-9', ENRICHED]]);
    const priorEnriched = new Map([['person-9', { id: 'person-9', name: 'Earlier Candidate' }]]);
    expect(applyStates(priorStates, outcome).get('person-9')).toBe(ENRICHED);
    const nextEnriched = applyEnriched(priorEnriched, outcome);
    expect(nextEnriched.get('person-9').name).toBe('Earlier Candidate');
    expect(nextEnriched.get('person-1').name).toBe('New Candidate');
  });

  test('two overlapping responses both survive, in either order', () => {
    const first = reconcile(['person-1'], { candidates: [{ requestedId: 'person-1', id: 'person-1', name: 'First' }] });
    const second = reconcile(['person-2'], { candidates: [{ requestedId: 'person-2', id: 'person-2', name: 'Second' }] });
    for (const order of [[first, second], [second, first]]) {
      let s = states([]);
      let e = new Map();
      for (const outcome of order) { s = applyStates(s, outcome); e = applyEnriched(e, outcome); }
      expect(s.get('person-1')).toBe(ENRICHED);
      expect(s.get('person-2')).toBe(ENRICHED);
      expect(e.get('person-1').name).toBe('First');
      expect(e.get('person-2').name).toBe('Second');
    }
  });
});

describe('enrichmentSummary', () => {
  test('reports completion, partial failure and the per-request cap', () => {
    expect(enrichmentSummary({ matched: 4, failed: 0, skipped: 0 })).toBe('Enrichment complete. 4 candidates enriched.');
    expect(enrichmentSummary({ matched: 1, failed: 0, skipped: 0 })).toBe('Enrichment complete. 1 candidate enriched.');
    expect(enrichmentSummary({ matched: 4, failed: 1, skipped: 0 })).toContain('Unable to enrich this candidate.');
    expect(enrichmentSummary({ matched: 25, failed: 0, skipped: 5 })).toContain('per-request limit');
  });
});

test('a reveal skips candidates whose address we already hold', () => {
  const states = new Map([['p1', ENRICHED], ['p2', ENRICHED]]);
  const revealed = new Map([
    ['p1', { id: 'p1', email: 'work@example-co.com', contactRevealed: true }],
    ['p2', { id: 'p2', email: null, contactRevealed: true }]
  ]);

  // p1 is already paid for; p2 was revealed too, and Apollo had nothing.
  expect(idsToReveal(['p1', 'p2'], states, revealed)).toEqual([]);

  // Enriched but never revealed: holds a work address, yet Apollo has not been
  // asked for contact data, so paying to ask is still allowed.
  const enrichedOnly = new Map([['p1', { id: 'p1', email: 'work@example-co.com' }]]);
  expect(idsToReveal(['p1'], states, enrichedOnly)).toEqual(['p1']);

  // An explicit refresh overrides the guard.
  expect(idsToReveal(['p1', 'p2'], states, revealed, { refresh: true })).toEqual(['p1', 'p2']);

  // Anything already in flight is never sent twice, refresh or not.
  const inFlight = new Map([['p1', REVEALING], ['p2', ENRICHING]]);
  expect(idsToReveal(['p1', 'p2'], inFlight, new Map(), { refresh: true })).toEqual([]);

  // Unknown candidates are eligible; empty IDs never are.
  expect(idsToReveal(['p3', '', null], new Map(), new Map())).toEqual(['p3']);
});

test('the reveal summary says whether a PERSONAL address was found', () => {
  const outcome = (candidates) => reconcile(candidates.map((c) => c.requestedId), { candidates, skippedIds: [] });

  // A work address only: useful, but not what the recruiter asked for.
  expect(revealSummary(outcome([
    { requestedId: 'p1', id: 'p1', email: 'work@example-co.com', emailType: 'work', personalEmail: null }
  ]))).toMatch(/1 work address found, but Apollo holds no personal email for this candidate/i);

  // A personal address alongside the work one.
  expect(revealSummary(outcome([
    { requestedId: 'p1', id: 'p1', email: 'work@example-co.com', emailType: 'work', personalEmail: 'p@gmail.com' }
  ]))).toMatch(/1 personal email found, and 1 work address/i);

  // Personal only, carried in the primary slot.
  expect(revealSummary(outcome([
    { requestedId: 'p1', id: 'p1', email: 'p@gmail.com', emailType: 'personal', personalEmail: null }
  ]))).toMatch(/1 personal email found/i);

  // Nothing at all.
  expect(revealSummary(outcome([
    { requestedId: 'p1', id: 'p1', email: null, emailType: null, personalEmail: null }
  ]))).toMatch(/Apollo returned no email address/i);
});

// --- Merging a waterfall answer into the row it answers ----------------------
//
// A waterfall answer carries the person id and whatever the vendors found, and
// nothing else. Applied the way an enrichment answer is applied, it replaced a
// full candidate with that husk and the row lost its name. These lock that out.

// The sparse record Apollo's waterfall really returns, normalized.
const waterfallAnswer = (id, overrides = {}) => ({
  id, requestedId: id, name: null, title: null, headline: null, company: null,
  location: null, seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, emailType: null, personalEmail: null, hasEmailOnFile: null, phone: null,
  emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: true,
  vendors: [], waterfallChecked: true, ...overrides
});

const searchRow = (id, name) => ({
  id, requestedId: null, name, title: 'Java Developer', company: 'Example Co',
  location: 'Hyderabad', linkedinUrl: 'https://www.linkedin.com/in/example',
  skills: ['Java'], employmentHistory: [{ organization: 'Example Co', title: 'Java Developer', current: true }],
  email: 'work@example-co.test', emailType: 'work', personalEmail: null,
  emailAvailable: true, phoneAvailable: false, phone: null, enriched: false
});

test('a waterfall answer that found nothing leaves the row it answers intact', () => {
  const outcome = reconcile(['person-1'], { candidates: [waterfallAnswer('person-1')] });
  const baseById = new Map([['person-1', searchRow('person-1', 'Test Candidate')]]);

  const merged = applyWaterfall(new Map(), outcome, { baseById, checkedIds: ['person-1'] }).get('person-1');

  // The husk must not have overwritten any of this.
  expect(merged.name).toBe('Test Candidate');
  expect(merged.title).toBe('Java Developer');
  expect(merged.company).toBe('Example Co');
  expect(merged.location).toBe('Hyderabad');
  expect(merged.linkedinUrl).toBe('https://www.linkedin.com/in/example');
  expect(merged.skills).toEqual(['Java']);
  expect(merged.employmentHistory).toHaveLength(1);
  // The work address the row already held is not erased by a search that was
  // looking for a different kind of address.
  expect(merged.email).toBe('work@example-co.test');
  expect(merged.emailAvailable).toBe(true);
  // Apollo found no personal address, so there is none - not a placeholder.
  expect(merged.personalEmail).toBeNull();
  expect(merged.waterfallChecked).toBe(true);
  expect(merged.id).toBe('person-1');
});

test('a waterfall answer that found an address writes only that', () => {
  const outcome = reconcile(['person-1'], {
    candidates: [waterfallAnswer('person-1', {
      email: 'work@example-co.test', emailType: 'work',
      personalEmail: 'found@example-mail.test', emailAvailable: true,
      phone: '+1 555 0100 999', phoneAvailable: true
    })]
  });
  const baseById = new Map([['person-1', searchRow('person-1', 'Test Candidate')]]);

  const merged = applyWaterfall(new Map(), outcome, { baseById, checkedIds: ['person-1'] }).get('person-1');

  expect(merged.name).toBe('Test Candidate', 'still the candidate it was about');
  expect(merged.personalEmail).toBe('found@example-mail.test');
  expect(merged.phone).toBe('+1 555 0100 999');
  expect(merged.phoneAvailable).toBe(true);
});

test('an id Apollo returned no record for is still marked as answered', () => {
  // Apollo finished and sent nothing back for this person. That is an answer
  // about them - "none found" - not silence, and the row must be able to say so
  // rather than looking as though nobody ever asked.
  const outcome = reconcile(['person-1'], { candidates: [] });
  const baseById = new Map([['person-1', searchRow('person-1', 'Test Candidate')]]);

  const merged = applyWaterfall(new Map(), outcome, { baseById, checkedIds: ['person-1'] }).get('person-1');
  expect(merged.name).toBe('Test Candidate');
  expect(merged.waterfallChecked).toBe(true);
  expect(merged.personalEmail).toBeNull();
});

test('an id with nothing known about it at all is not conjured into a row', () => {
  const outcome = reconcile(['person-9'], { candidates: [] });
  const next = applyWaterfall(new Map(), outcome, { baseById: new Map(), checkedIds: ['person-9'] });
  expect(next.has('person-9')).toBe(false);
});

test('each answer in a batch is merged into its own candidate', () => {
  const outcome = reconcile(['person-1', 'person-2', 'person-3'], {
    candidates: [
      waterfallAnswer('person-2', { personalEmail: 'two@example-mail.test' }),
      waterfallAnswer('person-1', { personalEmail: 'one@example-mail.test' })
    ]
  });
  const baseById = new Map([
    ['person-1', searchRow('person-1', 'Candidate One')],
    ['person-2', searchRow('person-2', 'Candidate Two')],
    ['person-3', searchRow('person-3', 'Candidate Three')]
  ]);

  const next = applyWaterfall(new Map(), outcome, { baseById, checkedIds: ['person-1', 'person-2', 'person-3'] });

  // Order in the response is not the order of the request, so a positional
  // merge would have crossed these two over.
  expect(next.get('person-1').name).toBe('Candidate One');
  expect(next.get('person-1').personalEmail).toBe('one@example-mail.test');
  expect(next.get('person-2').name).toBe('Candidate Two');
  expect(next.get('person-2').personalEmail).toBe('two@example-mail.test');
  // Answered with no record: checked, still itself, still no address.
  expect(next.get('person-3').name).toBe('Candidate Three');
  expect(next.get('person-3').personalEmail).toBeNull();
  expect(next.get('person-3').waterfallChecked).toBe(true);
});

test('a waterfall answer merges over what a reveal already put on the row', () => {
  const revealed = new Map([['person-1', {
    ...searchRow('person-1', 'Test Candidate'), enriched: true, contactRevealed: true, headline: 'Senior Java Developer'
  }]]);
  const outcome = reconcile(['person-1'], { candidates: [waterfallAnswer('person-1', { personalEmail: 'found@example-mail.test' })] });

  const merged = applyWaterfall(revealed, outcome, { baseById: new Map(), checkedIds: ['person-1'] }).get('person-1');
  expect(merged.headline).toBe('Senior Java Developer', 'the enriched record wins over the search row');
  expect(merged.personalEmail).toBe('found@example-mail.test');
});

test('mergeCandidate never lets an absence overwrite a known value', () => {
  const base = { id: 'person-1', name: 'Test Candidate', email: 'work@example-co.test', skills: ['Java'], emailAvailable: true };
  const merged = mergeCandidate(base, {
    id: 'person-1', name: null, email: undefined, skills: [], emailAvailable: false, phone: ''
  });
  expect(merged.name).toBe('Test Candidate');
  expect(merged.email).toBe('work@example-co.test');
  expect(merged.skills).toEqual(['Java']);
  // Every flag on a candidate is a positive assertion, so a false on a sparse
  // answer is an absence rather than a correction.
  expect(merged.emailAvailable).toBe(true);
  expect(merged.phone).toBeUndefined();
});
