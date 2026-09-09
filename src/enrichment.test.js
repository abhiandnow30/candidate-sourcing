import { describe, expect, test } from 'vitest';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED,
  applyEnriched, applyStates, enrichmentLabel, enrichmentSummary, idsToEnrich, markState, reconcile, stateOf
} from './enrichment.js';

const states = (entries) => new Map(entries);

describe('enrichment lifecycle', () => {
  test('labels each state for the Enriched column', () => {
    expect(enrichmentLabel(NOT_ENRICHED)).toBe('Not enriched');
    expect(enrichmentLabel(ENRICHING)).toBe('Enriching...');
    expect(enrichmentLabel(ENRICHED)).toBe('Yes');
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
