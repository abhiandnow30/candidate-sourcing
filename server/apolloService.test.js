import assert from 'node:assert/strict';
import test from 'node:test';
import { BULK_MATCH_BATCH_SIZE, batchIds, enrichPeople, matchPerson, normalizeCandidate, normalizeWaterfallCandidate, pollWaterfallResult, requestPhoneNumbers, requestWaterfallEmails, searchPeople } from './apolloService.js';

// Every test drives Apollo through a stub. No real Apollo call is made and no
// real candidate personal data appears anywhere in this file.
function stubApollo(handler) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.APOLLO_API_KEY;
  process.env.APOLLO_API_KEY = 'test-only-key';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), headers: options?.headers || {}, body });
    return handler({ url: String(url), body, index: calls.length - 1 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.APOLLO_API_KEY;
      else process.env.APOLLO_API_KEY = originalKey;
    }
  };
}

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });
const fail = (status) => new Response(JSON.stringify({ error: 'upstream detail that must not leak' }), { status });

test('normalizes Apollo people without inventing unavailable fields', () => {
  const candidate = normalizeCandidate({
    id: 'person-1', first_name: 'Test', last_name: 'Candidate', title: 'Engineer',
    organization: { name: 'Example Co' }, city: 'Hyderabad',
    linkedin_url: 'https://www.linkedin.com/in/apollo-result'
  });
  assert.deepEqual(candidate, {
    id: 'person-1', requestedId: null, name: 'Test Candidate', title: 'Engineer', headline: null,
    company: 'Example Co', location: 'Hyderabad', seniority: null, departments: [], skills: [],
    linkedinUrl: 'https://www.linkedin.com/in/apollo-result', email: null, emailType: null, personalEmail: null, hasEmailOnFile: null, phone: null,
    hasPhoneOnFile: null, emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: false
  });
});

test('treats the email_status enum as a value, not a truthy string', () => {
  assert.equal(normalizeCandidate({ id: 'a', email_status: 'unavailable' }).emailAvailable, false);
  assert.equal(normalizeCandidate({ id: 'a', email_status: '  Unavailable ' }).emailAvailable, false);
  assert.equal(normalizeCandidate({ id: 'a', email_status: 'verified' }).emailAvailable, true);
  assert.equal(normalizeCandidate({ id: 'a', phone_available: 'false' }).phoneAvailable, false);
});

test('never surfaces Apollo masked-email sentinels as a real address', () => {
  const candidate = normalizeCandidate({ id: 'a', email: 'email_not_unlocked@domain.com' });
  assert.equal(candidate.email, null);
  assert.equal(candidate.emailAvailable, false);
});

test('falls back to the personal_emails and contact_emails Apollo already sent', () => {
  assert.equal(normalizeCandidate({ id: 'a', email: null, personal_emails: ['  stella@example.com  '] }).email, 'stella@example.com');
  assert.equal(normalizeCandidate({ id: 'a', contact_emails: [{ email: 'work@example.com', email_status: 'verified' }] }).email, 'work@example.com');
  // No status is not a claim of unavailability, so the address stays eligible.
  assert.equal(normalizeCandidate({ id: 'a', contact_emails: [{ email: 'work@example.com' }] }).email, 'work@example.com');
  // A real `email` still wins over the arrays.
  assert.equal(normalizeCandidate({ id: 'a', email: 'direct@example.com', personal_emails: ['other@example.com'] }).email, 'direct@example.com');
  assert.equal(normalizeCandidate({ id: 'a', personal_emails: ['fallback@example.com'] }).emailAvailable, true);
});

test('applies the masked and unavailable rules to every email source, not just `email`', () => {
  assert.equal(normalizeCandidate({ id: 'a', personal_emails: ['email_not_unlocked@domain.com'] }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', contact_emails: [{ email: 'stale@example.com', email_status: 'bounced' }] }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', contact_emails: [{ email: 'stale@example.com', email_status: 'unavailable' }] }).email, null);
  // Skips the unusable entry rather than stopping at it.
  assert.equal(normalizeCandidate({
    id: 'a',
    contact_emails: [{ email: 'stale@example.com', email_status: 'bounced' }, { email: 'good@example.com', email_status: 'verified' }]
  }).email, 'good@example.com');
  // Apollo's real answer for a person it has no address for stays "not available".
  const none = normalizeCandidate({ id: 'a', email: null, email_status: 'unavailable', contact_emails: [] });
  assert.equal(none.email, null);
  assert.equal(none.emailAvailable, false);
});

test('ignores placeholder and malformed values in every email source', () => {
  for (const filler of ['n/a', 'NONE', ' unknown ', 'not available', 'null']) {
    assert.equal(normalizeCandidate({ id: 'a', email: filler }).email, null, `${filler} is not an address`);
  }
  assert.equal(normalizeCandidate({ id: 'a', email: 'nonsense' }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', email: 'missing@tld' }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', personal_emails: ['n/a', 'real@example.com'] }).email, 'real@example.com');
  assert.equal(normalizeCandidate({ id: 'a', email: '  spaced@example.com  ' }).email, 'spaced@example.com');
});

test('only asks Apollo to reveal personal emails when explicitly told to', async () => {
  const stub = stubApollo(() => ok({ matches: [{ id: 'p1', email: 'revealed@example.com' }] }));
  try {
    await enrichPeople(['p1']);
    assert.equal(stub.calls[0].body.reveal_personal_emails, false, 'plain enrichment never spends contact credits');

    await enrichPeople(['p1'], { revealPersonalEmails: true });
    assert.equal(stub.calls[1].body.reveal_personal_emails, true, 'an explicit reveal asks Apollo for the address');

    // Phone reveal is a separate task: the flag is not sent at all, and this
    // email-only request needs no webhook_url either.
    for (const call of stub.calls) {
      assert.equal(call.body.reveal_phone_number, undefined, 'reveal_phone_number is never sent');
      assert.equal(call.body.webhook_url, undefined, 'no webhook is required to reveal an email');
      assert.ok(call.url.startsWith('https://api.apollo.io/'), 'every request goes to Apollo only');
    }
  } finally { stub.restore(); }
});

test('a reveal still batches person IDs in groups of ten', async () => {
  const ids = Array.from({ length: 23 }, (_, index) => `p${index}`);
  const stub = stubApollo(({ body }) => ok({ matches: body.details.map((detail) => ({ id: detail.id, email: `${detail.id}@example.com` })) }));
  try {
    const { candidates, failedIds } = await enrichPeople(ids, { revealPersonalEmails: true });
    assert.equal(stub.calls.length, 3, '23 IDs become 10 + 10 + 3');
    assert.deepEqual(stub.calls.map((call) => call.body.details.length), [BULK_MATCH_BATCH_SIZE, BULK_MATCH_BATCH_SIZE, 3]);
    assert.ok(stub.calls.every((call) => call.body.reveal_personal_emails === true), 'every batch carries the reveal');
    assert.equal(candidates.length, 23, 'no candidate is lost between batches');
    assert.equal(failedIds.length, 0);
    assert.deepEqual([...new Set(candidates.map((candidate) => candidate.requestedId))].length, 23, 'and none is duplicated');
  } finally { stub.restore(); }
});

test('a reveal returns partial results: an address for one, nothing for the next', async () => {
  const stub = stubApollo(() => ok({
    matches: [
      { id: 'p1', name: 'Candidate One', email: 'one@example.com', email_status: 'verified' },
      { id: 'p2', name: 'Candidate Two', email: null, email_status: 'unavailable', personal_emails: [], contact_emails: [] }
    ]
  }));
  try {
    const { candidates, failedIds } = await enrichPeople(['p1', 'p2'], { revealPersonalEmails: true });
    assert.equal(failedIds.length, 0, 'Apollo matched both, so neither is a failure');
    assert.equal(candidates[0].email, 'one@example.com');
    assert.equal(candidates[0].emailAvailable, true);
    assert.equal(candidates[1].email, null, 'the second is reported as having no address, never invented');
    assert.equal(candidates[1].emailAvailable, false);
  } finally { stub.restore(); }
});

test('surfaces Apollo 401, 403, 429 and 500 without leaking upstream detail', async () => {
  for (const [status, expected] of [[401, 'APOLLO_AUTH'], [403, 'APOLLO_AUTH'], [429, 'APOLLO_RATE_LIMIT'], [500, 'APOLLO_UNAVAILABLE']]) {
    const stub = stubApollo(() => fail(status));
    try {
      await assert.rejects(enrichPeople(['p1'], { revealPersonalEmails: true }), new RegExp(`^Error: ${expected}$`), `Apollo ${status}`);
    } finally { stub.restore(); }
  }
});

test('prefers a work address and labels which kind it returned', () => {
  // person.email is Apollo's professional address.
  const work = normalizeCandidate({ id: 'a', email: 'first.last@example-co.com' });
  assert.equal(work.email, 'first.last@example-co.com');
  assert.equal(work.emailType, 'work');

  // A work address in contact_emails wins over a personal one in the list.
  const both = normalizeCandidate({
    id: 'a',
    contact_emails: [{ email: 'work@example-co.com', email_status: 'verified' }],
    personal_emails: ['someone@gmail.com']
  });
  assert.equal(both.email, 'work@example-co.com', 'the professional address is preferred');
  assert.equal(both.emailType, 'work');

  // Only a personal one available: returned, and labelled honestly.
  const personal = normalizeCandidate({ id: 'a', personal_emails: ['someone@gmail.com'] });
  assert.equal(personal.email, 'someone@gmail.com');
  assert.equal(personal.emailType, 'personal');

  // A consumer mailbox in the work slot is still the candidate's own address.
  assert.equal(normalizeCandidate({ id: 'a', email: 'someone@gmail.com' }).emailType, 'personal');

  // Nothing available at all.
  const none = normalizeCandidate({ id: 'a' });
  assert.equal(none.email, null);
  assert.equal(none.emailType, null);
});

test('carries a work address and a personal one together when Apollo sends both', () => {
  // Exactly the shape Apollo returned once Primary Email Address was set to Any.
  const candidate = normalizeCandidate({
    id: 'a', name: 'Test Candidate',
    email: 'first.last@example-co.com', email_status: 'verified',
    personal_emails: ['first.last.personal@gmail.com']
  }, { enriched: true, requestedId: 'a' });
  assert.equal(candidate.email, 'first.last@example-co.com', 'the work address stays primary');
  assert.equal(candidate.emailType, 'work');
  assert.equal(candidate.personalEmail, 'first.last.personal@gmail.com', 'the personal one is not dropped');

  // Only a personal address: it becomes the primary and is not repeated.
  const personalOnly = normalizeCandidate({ id: 'a', personal_emails: ['someone@gmail.com'] });
  assert.equal(personalOnly.email, 'someone@gmail.com');
  assert.equal(personalOnly.emailType, 'personal');
  assert.equal(personalOnly.personalEmail, null, 'the same address is never shown twice');

  // The same address in both fields is de-duplicated.
  const same = normalizeCandidate({ id: 'a', email: 'someone@gmail.com', personal_emails: ['SOMEONE@gmail.com'] });
  assert.equal(same.email, 'someone@gmail.com');
  assert.equal(same.personalEmail, null);

  // Masked and placeholder rules still apply to the personal slot.
  assert.equal(normalizeCandidate({ id: 'a', email: 'w@example-co.com', personal_emails: ['n/a'] }).personalEmail, null);
  assert.equal(normalizeCandidate({ id: 'a', email: 'w@example-co.com', personal_emails: ['email_not_unlocked@x.com'] }).personalEmail, null);

  // Nothing at all.
  assert.equal(normalizeCandidate({ id: 'a' }).personalEmail, null);
});

test('never constructs an address from a name and a company domain', () => {
  const person = {
    id: 'a', first_name: 'First', last_name: 'Last', name: 'First Last',
    organization: { name: 'Example Co', primary_domain: 'example-co.com', website_url: 'https://example-co.com' },
    email: null, email_status: 'unavailable', personal_emails: [], contact_emails: []
  };
  const candidate = normalizeCandidate(person, { enriched: true, requestedId: 'a' });
  assert.equal(candidate.email, null, 'an absent address stays absent');
  assert.equal(candidate.emailType, null);
  // The guessable forms must appear nowhere in the normalized record.
  const serialized = JSON.stringify(candidate);
  for (const guess of ['first.last@example-co.com', 'firstlast@example-co.com', 'first@example-co.com', 'flast@example-co.com']) {
    assert.ok(!serialized.includes(guess), `must not invent ${guess}`);
  }
});

test('treats blank and whitespace-only addresses as unavailable', () => {
  for (const blank of ['', '   ', '\t', '\n']) {
    const candidate = normalizeCandidate({ id: 'a', email: blank });
    assert.equal(candidate.email, null, JSON.stringify(blank));
    assert.equal(candidate.emailAvailable, false);
  }
  assert.equal(normalizeCandidate({ id: 'a', email: undefined }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', personal_emails: ['   '] }).email, null);
  assert.equal(normalizeCandidate({ id: 'a', contact_emails: [{ email: '  ' }] }).email, null);
});

test('an Apollo 400 and a network failure both stay generic', async () => {
  const bad = stubApollo(() => fail(400));
  try {
    await assert.rejects(enrichPeople(['p1'], { revealPersonalEmails: true }), /APOLLO_UNAVAILABLE/, 'Apollo 400');
  } finally { bad.restore(); }

  const offline = stubApollo(() => { throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:443'); });
  try {
    await assert.rejects(enrichPeople(['p1'], { revealPersonalEmails: true }), (error) => {
      // The transport error must not carry host or infrastructure detail onward.
      assert.ok(!/10\.0\.0\.1/.test(error.message) || error instanceof TypeError);
      return true;
    }, 'network failure');
  } finally { offline.restore(); }
});

test('a batch that fails keeps the batches that succeeded', async () => {
  const ids = Array.from({ length: 20 }, (_, index) => `p${index}`);
  // First batch of ten succeeds, second fails outright.
  const stub = stubApollo(({ body, index }) => (index === 0
    ? ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}`, email: `${id}@example-co.com` })) })
    : fail(500)));
  try {
    const { candidates, failedIds } = await enrichPeople(ids, { revealPersonalEmails: true });
    assert.equal(stub.calls.length, 2);
    assert.equal(candidates.length, 10, 'the successful batch survives');
    assert.deepEqual(failedIds, ids.slice(10), 'the failed batch is reported, not dropped');
    assert.equal(candidates.length + failedIds.length, 20, 'every ID is accounted for');
  } finally { stub.restore(); }
});

test('the Apollo key is sent as a header and never logged', async () => {
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = methods.map((name) => [name, console[name]]);
  for (const name of methods) console[name] = (...args) => logged.push(args.map(String).join(' '));
  const stub = stubApollo(() => ok({ matches: [{ id: 'p1', email: 'work@example-co.com' }] }));
  try {
    await enrichPeople(['p1'], { revealPersonalEmails: true });
    assert.equal(stub.calls[0].headers['x-api-key'], 'test-only-key', 'the key travels in the header');
    assert.ok(!JSON.stringify(stub.calls[0].body).includes('test-only-key'), 'never in the request body');
    assert.ok(!logged.join(' ').includes('test-only-key'), 'never written to a log');
  } finally {
    stub.restore();
    for (const [name, original] of originals) console[name] = original;
  }
});

test('a 64-bit request_id survives instead of being rounded away', async () => {
  // A real id Apollo returned. It is wider than Number.MAX_SAFE_INTEGER, so
  // JSON.parse rounds it and polling the rounded value answers
  // request_id_unknown forever - which reads as "found nothing".
  const exact = '4681616607779935463';
  assert.notEqual(String(JSON.parse(`{"id":${exact}}`).id), exact, 'JSON.parse really does lose it');

  const stub = stubApollo(() => new Response(`{"request_id":${exact},"matches":[{"id":"p1","name":"Candidate One"}]}`, { status: 200 }));
  try {
    const { requests } = await requestWaterfallEmails(['p1'], 'https://example.test/hook');
    assert.deepEqual(requests, [{ requestId: exact, ids: ['p1'] }], 'the id Apollo sent, digit for digit');
  } finally { stub.restore(); }
});

test('a waterfall asks for the right things and refuses without a webhook URL', async () => {
  const stub = stubApollo(() => ok({ request_id: 12, matches: [] }));
  try {
    await requestWaterfallEmails(['p1'], 'https://example.test/hook');
    assert.equal(stub.calls[0].body.run_waterfall_email, true);
    assert.equal(stub.calls[0].body.reveal_personal_emails, true);
    assert.equal(stub.calls[0].body.webhook_url, 'https://example.test/hook');
    assert.equal(stub.calls[0].body.run_waterfall_phone, undefined, 'phone waterfall is a separate, costlier task');

    await assert.rejects(requestWaterfallEmails(['p1'], ''), /MISSING_APOLLO_WEBHOOK_URL/);
    assert.equal(stub.calls.length, 1, 'nothing more was sent, so nothing more could be charged');
  } finally { stub.restore(); }
});

test('polling separates still-running from finished and from expired', async () => {
  const cases = [
    [new Response(JSON.stringify({ error_code: 'result_pending', retry_after_seconds: 5 }), { status: 404 }), 'pending'],
    [new Response(JSON.stringify({ error_code: 'request_id_unknown' }), { status: 404 }), 'expired'],
    [new Response(JSON.stringify({ error_code: 'request_id_expired' }), { status: 410 }), 'expired'],
    // Only a personal address: it becomes the primary and is labelled as such.
    [ok({ people: [{ id: 'p1', name: 'Candidate One', personal_emails: ['found@gmail.com'] }] }), 'ready',
      (candidate) => {
        assert.equal(candidate.email, 'found@gmail.com');
        assert.equal(candidate.emailType, 'personal');
        assert.equal(candidate.personalEmail, null, 'never the same address twice');
      }],
    // Both: the work address stays primary and the found one rides alongside.
    [ok({ people: [{ id: 'p1', name: 'Candidate One', email: 'work@example-co.com', personal_emails: ['found@gmail.com'] }] }), 'ready',
      (candidate) => {
        assert.equal(candidate.email, 'work@example-co.com');
        assert.equal(candidate.personalEmail, 'found@gmail.com', 'what the waterfall was run to find');
        assert.equal(candidate.requestedId, 'p1');
      }]
  ];
  for (const [response, expected, check] of cases) {
    const stub = stubApollo(() => response.clone());
    try {
      const result = await pollWaterfallResult('4681616607779935463');
      assert.equal(result.status, expected);
      assert.ok(stub.calls[0].url.endsWith('/webhook_result/4681616607779935463'), 'the exact id is polled');
      if (check) check(result.candidates[0]);
    } finally { stub.restore(); }
  }
});

test('normalizes enriched professional fields and employment history', () => {
  const candidate = normalizeCandidate({
    id: 'person-9', name: 'Test Candidate', headline: 'Senior Java Developer | Java | Spring Boot',
    seniority: 'senior', departments: ['engineering'], skills: ['Java', ' Spring Boot ', '', 'SQL'],
    employment_history: [
      { organization_name: 'ABC Technologies', title: 'Senior Java Developer', current: true, start_date: '2021-01-01' },
      { organization_name: 'XYZ Technologies', title: 'Java Developer', current: false, start_date: '2018-01-01', end_date: '2020-12-01' },
      { organization_name: '', title: '' }
    ]
  }, { enriched: true, requestedId: 'person-9' });
  assert.equal(candidate.headline, 'Senior Java Developer | Java | Spring Boot');
  assert.equal(candidate.seniority, 'senior');
  assert.deepEqual(candidate.departments, ['engineering']);
  assert.deepEqual(candidate.skills, ['Java', 'Spring Boot', 'SQL']);
  assert.equal(candidate.enriched, true);
  assert.equal(candidate.requestedId, 'person-9');
  assert.equal(candidate.employmentHistory.length, 2, 'entries with neither org nor title are dropped');
  assert.deepEqual(candidate.employmentHistory[0], { organization: 'ABC Technologies', title: 'Senior Java Developer', startDate: '2021-01-01', endDate: null, current: true });
  assert.equal(candidate.employmentHistory[1].current, false);
});

test('leaves skills empty rather than guessing when Apollo omits them', () => {
  assert.deepEqual(normalizeCandidate({ id: 'a' }).skills, []);
  assert.deepEqual(normalizeCandidate({ id: 'a', skills: [] }).skills, []);
  assert.deepEqual(normalizeCandidate({ id: 'a', skills: 'Java' }).skills, [], 'a non-array is not coerced into a skill');
});

test('maps search filters and pagination to Apollo', async (t) => {
  const apollo = stubApollo(() => ok({ people: [{ id: 'person-2', name: 'Another Candidate' }], total_entries: 101 }));
  t.after(() => apollo.restore());
  const result = await searchPeople({ jobTitle: 'Java Developer', location: 'Hyderabad', seniority: 'senior', keywords: 'Java Spring Boot', company: 'Example Co', industry: 'Software' }, 3, 25);
  assert.equal(apollo.calls[0].url, 'https://api.apollo.io/api/v1/mixed_people/api_search');
  assert.deepEqual(apollo.calls[0].body, { page: 3, per_page: 25, person_titles: ['Java Developer'], person_locations: ['Hyderabad'], person_seniorities: ['senior'], q_keywords: 'Java Spring Boot', organization_names: ['Example Co'], organization_industries: ['Software'] });
  assert.equal(result.total, 101);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].enriched, false, 'search results are never marked enriched');
});

test('search sends no filter keys when the recruiter supplies none', async (t) => {
  const apollo = stubApollo(() => ok({ people: [] }));
  t.after(() => apollo.restore());
  const result = await searchPeople({ jobTitle: '', location: '', seniority: '', keywords: '', company: '', industry: '' }, 1, 25);
  assert.deepEqual(apollo.calls[0].body, { page: 1, per_page: 25 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.total, null);
});

test('batchIds splits without losing or duplicating IDs', () => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  const batches = batchIds(ids);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3]);
  assert.deepEqual(batches.flat(), ids);
  assert.equal(new Set(batches.flat()).size, 23);
  assert.equal(BULK_MATCH_BATCH_SIZE, 10);
});

test('enriches only the supplied person IDs', async (t) => {
  const apollo = stubApollo(() => ok({ matches: [{ id: 'person-3', name: 'Enriched Candidate', linkedin_url: 'https://www.linkedin.com/in/result' }] }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(['person-3']);
  assert.equal(apollo.calls.length, 1);
  assert.equal(apollo.calls[0].url, 'https://api.apollo.io/api/v1/people/bulk_match');
  assert.deepEqual(apollo.calls[0].body.details, [{ id: 'person-3' }]);
  assert.deepEqual(failedIds, []);
  assert.equal(candidates[0].email, null, 'a field Apollo withheld is not reconstructed');
  assert.equal(candidates[0].enriched, true);
});

test('splits a large selection across several Apollo batches', async (t) => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  const apollo = stubApollo(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(ids);
  assert.equal(apollo.calls.length, 3);
  assert.deepEqual(apollo.calls.map((call) => call.body.details.length), [10, 10, 3]);
  assert.deepEqual(failedIds, []);
  assert.equal(candidates.length, 23);
  assert.deepEqual(candidates.map((candidate) => candidate.requestedId), ids, 'no candidate lost or duplicated across batches');
});

test('reports partial enrichment when Apollo matches only some IDs', async (t) => {
  const apollo = stubApollo(({ body }) => ok({
    matches: body.details.map(({ id }) => (id === 'person-3' ? null : { id, name: `Candidate ${id}` }))
  }));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(['person-1', 'person-2', 'person-3', 'person-4', 'person-5']);
  assert.equal(candidates.length, 4);
  assert.deepEqual(failedIds, ['person-3']);
  assert.ok(!candidates.some((candidate) => candidate.requestedId === 'person-3'));
});

test('keeps successful batches when a later batch fails', async (t) => {
  const ids = Array.from({ length: 15 }, (_, index) => `person-${index}`);
  const apollo = stubApollo(({ body, index }) => (index === 1
    ? fail(429)
    : ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) })));
  t.after(() => apollo.restore());
  const { candidates, failedIds } = await enrichPeople(ids);
  assert.equal(candidates.length, 10, 'the batch that succeeded is not discarded');
  assert.deepEqual(failedIds, ids.slice(10));
});

test('surfaces the Apollo failure when no batch succeeds', async (t) => {
  const apollo = stubApollo(() => fail(429));
  t.after(() => apollo.restore());
  await assert.rejects(() => enrichPeople(['person-1']), /APOLLO_RATE_LIMIT/);
});

test('maps Apollo HTTP failures to internal error codes', async () => {
  for (const [status, code] of [[401, 'APOLLO_AUTH'], [403, 'APOLLO_AUTH'], [429, 'APOLLO_RATE_LIMIT'], [500, 'APOLLO_UNAVAILABLE']]) {
    const apollo = stubApollo(() => fail(status));
    try {
      await assert.rejects(() => searchPeople({}, 1), new RegExp(code), `HTTP ${status}`);
    } finally {
      apollo.restore();
    }
  }
});

test('refuses to call Apollo without a server-side key', async (t) => {
  const originalKey = process.env.APOLLO_API_KEY;
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return ok({}); };
  delete process.env.APOLLO_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = originalKey;
  });
  await assert.rejects(() => searchPeople({}, 1), /MISSING_APOLLO_API_KEY/);
  assert.equal(called, false, 'no request is attempted without a key');
});

test('the application only ever calls Apollo, never LinkedIn', async (t) => {
  const apollo = stubApollo(({ url, body }) => (url.includes('bulk_match')
    ? ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}`, linkedin_url: 'https://www.linkedin.com/in/example' })) })
    : ok({ people: [{ id: 'person-1', name: 'Candidate', linkedin_url: 'https://www.linkedin.com/in/example' }] })));
  t.after(() => apollo.restore());
  const search = await searchPeople({ jobTitle: 'Java Developer' }, 1);
  await enrichPeople(['person-1']);
  assert.ok(apollo.calls.length >= 2);
  for (const call of apollo.calls) {
    assert.equal(new URL(call.url).host, 'api.apollo.io', `unexpected host in ${call.url}`);
    assert.doesNotMatch(call.url, /linkedin/i);
    assert.doesNotMatch(JSON.stringify(call.body), /linkedin/i, 'a LinkedIn URL is never sent anywhere');
  }
  assert.equal(search.candidates[0].linkedinUrl, 'https://www.linkedin.com/in/example', 'the URL is passed through for manual use only');
});

// --- Apollo's waterfall response shape --------------------------------------
//
// Every payload below is the shape Apollo really answers a waterfall with,
// mocked. No Apollo call is made, no credit is spent, and no real address or
// number appears: the domains are reserved example domains and the digits are
// placeholders.

// The payload a finished waterfall returned for a candidate no vendor had
// anything for. This shape is why waterfall rows used to come back blank: not
// one of the fields the enrichment normalizer reads is present in it.
const NOT_FOUND_PERSON = {
  id: 'person-1',
  waterfall: {
    emails: [{
      vendors: [{
        id: 'apollo-1', name: 'Apollo', status: 'NOT_FOUND', emails: [],
        usedForVerification: false, statusCode: 'no_apollo_data', statusMessage: null, authMechanism: 'native'
      }]
    }]
  },
  phone_numbers: [],
  emails: []
};

test('a waterfall answer that found nothing keeps the person and invents no contact data', () => {
  const candidate = normalizeWaterfallCandidate(NOT_FOUND_PERSON, { requestedId: 'person-1' });

  assert.equal(candidate.id, 'person-1');
  assert.equal(candidate.requestedId, 'person-1', 'the id the recruiter selected survives');
  assert.equal(candidate.email, null, 'nothing was found, so nothing is claimed');
  assert.equal(candidate.emailType, null);
  assert.equal(candidate.personalEmail, null);
  assert.equal(candidate.phone, null);
  assert.equal(candidate.emailAvailable, false);
  assert.equal(candidate.phoneAvailable, false);
  // A completed lookup with no result, which the UI must be able to tell apart
  // from a candidate nobody has asked about yet.
  assert.equal(candidate.waterfallChecked, true);
});

test('a NOT_FOUND vendor is a completed lookup, not an error', () => {
  const candidate = normalizeWaterfallCandidate(NOT_FOUND_PERSON, { requestedId: 'person-1' });
  // Reported exactly as Apollo sent it, so the recruiter can be told which
  // source was checked without any vendor being named that Apollo did not name.
  assert.deepEqual(candidate.vendors, [{ name: 'Apollo', status: 'NOT_FOUND', statusCode: 'no_apollo_data' }]);
  assert.equal(candidate.email, null, 'and no address is fabricated to fill the gap');
});

test('a waterfall address in person.emails is read, whether string or object', () => {
  const asStrings = normalizeWaterfallCandidate({ id: 'person-1', emails: ['found@example-mail.test'] });
  assert.equal(asStrings.email, 'found@example-mail.test');

  const asObjects = normalizeWaterfallCandidate({
    id: 'person-1',
    emails: [{ email: 'stated.personal@example-mail.test', type: 'personal' }]
  });
  assert.equal(asObjects.email, 'stated.personal@example-mail.test');
  assert.equal(asObjects.emailType, 'personal', 'Apollo stated the kind, so it is used');
});

test('a vendor-level address inside waterfall.emails is read', () => {
  const candidate = normalizeWaterfallCandidate({
    id: 'person-1',
    emails: [],
    waterfall: {
      emails: [{
        vendors: [
          { id: 'apollo-1', name: 'Apollo', status: 'NOT_FOUND', emails: [] },
          { id: 'vendor-2', name: 'Other Source', status: 'FOUND', emails: [{ email: 'from.vendor@example-mail.test', type: 'personal' }] }
        ]
      }]
    }
  }, { requestedId: 'person-1' });

  assert.equal(candidate.email, 'from.vendor@example-mail.test', 'a vendor that found one is not ignored');
  assert.equal(candidate.emailType, 'personal');
  assert.deepEqual(candidate.vendors.map((vendor) => vendor.name), ['Apollo', 'Other Source']);
});

test('an address Apollo stated no kind for is never reported as a work address', () => {
  // Apollo returned it without a type. Calling it "work" would be our claim,
  // not Apollo's, so the kind stays unstated.
  const unstated = normalizeWaterfallCandidate({ id: 'person-1', emails: ['someone@example-co.test'] });
  assert.equal(unstated.email, 'someone@example-co.test');
  assert.equal(unstated.emailType, 'unknown');
  assert.equal(unstated.personalEmail, null, 'and it is not promoted to a personal address either');

  // A consumer mailbox domain is data Apollo sent, and the enrichment path
  // already treats an address on one as the candidate's own, so this agrees.
  const consumer = normalizeWaterfallCandidate({ id: 'person-1', emails: ['someone@gmail.com'] });
  assert.equal(consumer.emailType, 'personal');
});

test('a stated work address stays primary and a found personal one rides alongside', () => {
  const candidate = normalizeWaterfallCandidate({
    id: 'person-1',
    email: 'work@example-co.test',
    emails: [{ email: 'found.personal@example-mail.test', type: 'personal' }]
  }, { requestedId: 'person-1' });

  assert.equal(candidate.email, 'work@example-co.test');
  assert.equal(candidate.emailType, 'work');
  assert.equal(candidate.personalEmail, 'found.personal@example-mail.test', 'what the waterfall was run to find');
});

test('waterfall phone numbers are read from every shape Apollo sends', () => {
  const flat = normalizeWaterfallCandidate({ id: 'person-1', phone_numbers: ['+1 555 0100 999'] });
  assert.equal(flat.phone, '+1 555 0100 999');
  assert.equal(flat.phoneAvailable, true);

  const objects = normalizeWaterfallCandidate({
    id: 'person-1',
    phone_numbers: [{ raw_number: '+1 555 0100 888', sanitized_number: '+15550100888' }]
  });
  assert.equal(objects.phone, '+15550100888', 'the sanitized form is preferred');

  const nested = normalizeWaterfallCandidate({
    id: 'person-1',
    phone_numbers: [],
    waterfall: { phone_numbers: [{ vendors: [{ name: 'Apollo', status: 'FOUND', phone_numbers: ['+1 555 0100 777'] }] }] }
  });
  assert.equal(nested.phone, '+1 555 0100 777');
});

test('nothing that is not a contact value is ever presented as one', () => {
  const candidate = normalizeWaterfallCandidate({
    id: 'person-1',
    emails: ['n/a', 'not available', 'email_not_unlocked@domain.test', 'plainly-not-an-address', '', '   '],
    phone_numbers: ['n/a', 'unknown', '', '12', 'not available']
  }, { requestedId: 'person-1' });

  assert.equal(candidate.email, null, 'placeholders and non-addresses are not addresses');
  assert.equal(candidate.phone, null, 'and a fragment of digits is not a number');
});

test('a malformed or half-missing waterfall answer does not crash the parser', () => {
  const payloads = [
    {},
    { id: 'person-1' },
    { id: 'person-1', emails: null, phone_numbers: null, waterfall: null },
    { id: 'person-1', waterfall: {} },
    { id: 'person-1', waterfall: { emails: null } },
    { id: 'person-1', waterfall: { emails: [null, 'nonsense', 42] } },
    { id: 'person-1', waterfall: { emails: [{ vendors: null }] } },
    { id: 'person-1', waterfall: { emails: [{ vendors: [null, 'nonsense', { emails: null }] }] } },
    { id: 'person-1', emails: [null, 42, [], {}, { email: null }] },
    { id: 'person-1', phone_numbers: [null, 42, [], {}, { number: null }] }
  ];

  for (const payload of payloads) {
    const candidate = normalizeWaterfallCandidate(payload, { requestedId: 'person-1' });
    assert.equal(candidate.email, null, JSON.stringify(payload));
    assert.equal(candidate.phone, null, JSON.stringify(payload));
    assert.equal(candidate.requestedId, 'person-1');
    assert.ok(Array.isArray(candidate.vendors));
  }
});

test('polling reads the real waterfall shape and matches each answer to its own id', async () => {
  const stub = stubApollo(() => ok({
    webhook_result: {
      status: 'success',
      email_records_enriched: 1,
      email_records_not_found: 1,
      credits_consumed: 0,
      people: [
        NOT_FOUND_PERSON,
        {
          id: 'person-2',
          emails: [{ email: 'second.person@example-mail.test', type: 'personal' }],
          phone_numbers: ['+1 555 0100 666'],
          waterfall: { emails: [{ vendors: [{ id: 'apollo-1', name: 'Apollo', status: 'FOUND', statusCode: 'ok' }] }] }
        }
      ]
    }
  }));
  try {
    const result = await pollWaterfallResult('12');
    assert.equal(result.status, 'ready');

    const byId = new Map(result.candidates.map((candidate) => [candidate.requestedId, candidate]));
    assert.deepEqual([...byId.keys()], ['person-1', 'person-2'], 'each answer keeps its own person id');
    assert.equal(byId.get('person-1').email, null);
    assert.equal(byId.get('person-2').email, 'second.person@example-mail.test');
    assert.equal(byId.get('person-2').emailType, 'personal');
    assert.equal(byId.get('person-2').phone, '+1 555 0100 666');

    // One entry per vendor, however many candidates it was asked about.
    assert.deepEqual(result.summary.vendors.map((vendor) => vendor.name), ['Apollo']);
    assert.equal(result.summary.emailsFound, 1);
    assert.equal(result.summary.creditsConsumed, 0, 'this answer cost nothing');
  } finally { stub.restore(); }
});

// --- Looking up one known person --------------------------------------------
//
// Apollo's match endpoint, stubbed. No real call is made, no credit is spent,
// and every address below is on a reserved example domain.

test('a lookup sends the identifiers it was given and nothing it was not', async () => {
  const stub = stubApollo(() => ok({ person: { id: 'person-1', name: 'Test Candidate' } }));
  try {
    await matchPerson({ name: 'Test Candidate', company: 'Example Co', email: '', linkedinUrl: '' });
    const call = stub.calls[0];
    assert.ok(call.url.endsWith('/people/match'), 'the match endpoint, not the search one');
    assert.equal(call.body.name, 'Test Candidate');
    assert.equal(call.body.organization_name, 'Example Co');
    // An empty identifier is a filter Apollo would try to match on, so it is
    // never sent as one.
    assert.equal('email' in call.body, false);
    assert.equal('linkedin_url' in call.body, false);
    // The same credit discipline as plain enrichment: contact data is not
    // asked for here, and phone reveal is not mentioned at all.
    assert.equal(call.body.reveal_personal_emails, false);
    assert.equal(call.body.reveal_phone_number, undefined);
  } finally { stub.restore(); }
});

test('a lookup by email or LinkedIn URL is sent under Apollo own field names', async () => {
  const stub = stubApollo(() => ok({ person: { id: 'person-1', name: 'Test Candidate' } }));
  try {
    await matchPerson({ email: 'someone@example-co.test' });
    assert.equal(stub.calls[0].body.email, 'someone@example-co.test');

    await matchPerson({ linkedinUrl: 'https://www.linkedin.com/in/example' });
    assert.equal(stub.calls[1].body.linkedin_url, 'https://www.linkedin.com/in/example');
  } finally { stub.restore(); }
});

test('a lookup with nothing to match on is refused before Apollo is called', async () => {
  const stub = stubApollo(() => ok({ person: { id: 'person-1' } }));
  try {
    await assert.rejects(matchPerson({}), /MISSING_LOOKUP_IDENTIFIER/);
    await assert.rejects(matchPerson(), /MISSING_LOOKUP_IDENTIFIER/);
    assert.equal(stub.calls.length, 0, 'nothing was sent, so nothing could be charged');
  } finally { stub.restore(); }
});

test('a matched person is normalized the same way any other candidate is', async () => {
  const stub = stubApollo(() => ok({
    person: {
      id: 'person-1', first_name: 'Test', last_name: 'Candidate', title: 'Python Developer',
      organization: { name: 'Example Co' }, city: 'Hyderabad', has_email: true,
      linkedin_url: 'https://www.linkedin.com/in/example',
      employment_history: [{ organization_name: 'Example Co', title: 'Python Developer', current: true }]
    }
  }));
  try {
    const candidate = await matchPerson({ name: 'Test Candidate' });
    assert.equal(candidate.id, 'person-1');
    assert.equal(candidate.name, 'Test Candidate');
    assert.equal(candidate.title, 'Python Developer');
    assert.equal(candidate.company, 'Example Co');
    assert.equal(candidate.location, 'Hyderabad');
    assert.equal(candidate.hasEmailOnFile, true);
    assert.equal(candidate.employmentHistory.length, 1);
    assert.equal(candidate.enriched, true, 'a match answers with the full profile');
    // The lookup did not ask for contact data, so it reports none.
    assert.equal(candidate.email, null);
    assert.equal(candidate.personalEmail, null);
    assert.equal(candidate.phone, null);
  } finally { stub.restore(); }
});

test('a lookup that matches nobody answers with nothing rather than inventing a person', async () => {
  for (const payload of [{}, { person: null }, { people: [] }, { matches: [] }, { person: {} }]) {
    const stub = stubApollo(() => ok(payload));
    try {
      assert.equal(await matchPerson({ name: 'Nobody At All' }), null, JSON.stringify(payload));
    } finally { stub.restore(); }
  }
});

test('a lookup reads the person out of whichever shape Apollo answers in', async () => {
  const shapes = [
    { person: { id: 'person-1', name: 'Test Candidate' } },
    { people: [{ id: 'person-1', name: 'Test Candidate' }] },
    { matches: [{ id: 'person-1', name: 'Test Candidate' }] }
  ];
  for (const payload of shapes) {
    const stub = stubApollo(() => ok(payload));
    try {
      const candidate = await matchPerson({ name: 'Test Candidate' });
      assert.equal(candidate.name, 'Test Candidate', JSON.stringify(payload));
    } finally { stub.restore(); }
  }
});

test('a lookup surfaces Apollo own failures rather than swallowing them', async () => {
  for (const [status, expected] of [[401, /APOLLO_AUTH/], [429, /APOLLO_RATE_LIMIT/], [500, /APOLLO_UNAVAILABLE/]]) {
    const stub = stubApollo(() => fail(status));
    try {
      await assert.rejects(matchPerson({ name: 'Test Candidate' }), expected, `status ${status}`);
    } finally { stub.restore(); }
  }
});

// --- Phone reveal -----------------------------------------------------------
//
// Apollo's phone reveal, stubbed. No real call, no mobile credit, and every
// number below is an invented placeholder.

test('a phone request asks for a number and refuses without a webhook URL', async () => {
  const stub = stubApollo(() => ok({ request_id: 12, matches: [] }));
  try {
    await requestPhoneNumbers(['p1'], 'https://example.test/hook');
    const call = stub.calls[0];
    assert.ok(call.url.endsWith('/people/bulk_match'));
    assert.equal(call.body.reveal_phone_number, true);
    assert.equal(call.body.webhook_url, 'https://example.test/hook');
    // Email is its own action with its own price and is not folded in here.
    assert.equal(call.body.reveal_personal_emails, undefined);
    assert.equal(call.body.run_waterfall_email, undefined);

    // Apollo delivers numbers asynchronously, so a missing webhook is refused
    // here rather than becoming an opaque failure upstream.
    await assert.rejects(requestPhoneNumbers(['p1'], ''), /MISSING_APOLLO_WEBHOOK_URL/);
    assert.equal(stub.calls.length, 1, 'nothing more was sent, so nothing more could be charged');
  } finally { stub.restore(); }
});

test('a 64-bit phone request_id survives instead of being rounded away', async () => {
  const exact = '4681616607779935463';
  const stub = stubApollo(() => new Response(`{"request_id":${exact},"matches":[{"id":"p1","name":"Candidate One"}]}`, { status: 200 }));
  try {
    const { requests } = await requestPhoneNumbers(['p1'], 'https://example.test/hook');
    assert.deepEqual(requests, [{ requestId: exact, ids: ['p1'] }]);
  } finally { stub.restore(); }
});

test('a number Apollo already holds comes back with the request', async () => {
  const stub = stubApollo(() => ok({
    request_id: 12,
    matches: [{ id: 'p1', name: 'Candidate One', phone_numbers: [{ sanitized_number: '+15550100777' }] }]
  }));
  try {
    const { candidates } = await requestPhoneNumbers(['p1'], 'https://example.test/hook');
    assert.equal(candidates[0].phone, '+15550100777');
    assert.equal(candidates[0].phoneAvailable, true);
    // A phone job says nothing about a personal address, so it must not claim
    // the email was checked.
    assert.equal(candidates[0].phoneChecked, true);
    assert.equal(candidates[0].waterfallChecked, false);
  } finally { stub.restore(); }
});

test('a phone answer never claims the personal email was checked', async () => {
  // The two jobs answer different questions, and reading one as the other would
  // report "no personal email found" for a request that never looked for one.
  const asPhone = normalizeWaterfallCandidate({ id: 'p1' }, { requestedId: 'p1', kind: 'phone' });
  assert.equal(asPhone.phoneChecked, true);
  assert.equal(asPhone.waterfallChecked, false);

  const asEmail = normalizeWaterfallCandidate({ id: 'p1' }, { requestedId: 'p1' });
  assert.equal(asEmail.waterfallChecked, true, 'email is the default, as the waterfall path relies on');
  assert.equal(asEmail.phoneChecked, false);
});

test('polling a phone job reads its numbers and marks only the phone as checked', async () => {
  const stub = stubApollo(() => ok({
    webhook_result: {
      status: 'success',
      credits_consumed: 1,
      people: [
        { id: 'p1', phone_numbers: ['+1 555 0100 111'], emails: [] },
        { id: 'p2', phone_numbers: [], emails: [] }
      ]
    }
  }));
  try {
    const result = await pollWaterfallResult('12', { kind: 'phone' });
    assert.equal(result.status, 'ready');
    const byId = new Map(result.candidates.map((candidate) => [candidate.requestedId, candidate]));
    assert.equal(byId.get('p1').phone, '+1 555 0100 111');
    assert.equal(byId.get('p1').phoneChecked, true);
    assert.equal(byId.get('p1').waterfallChecked, false);
    // Asked and answered with nothing: still no fabricated number.
    assert.equal(byId.get('p2').phone, null);
    assert.equal(byId.get('p2').phoneChecked, true);
  } finally { stub.restore(); }
});

test('a phone request surfaces Apollo failures rather than swallowing them', async () => {
  for (const [status, expected] of [[401, /APOLLO_AUTH/], [429, /APOLLO_RATE_LIMIT/], [500, /APOLLO_UNAVAILABLE/]]) {
    const stub = stubApollo(() => fail(status));
    try {
      await assert.rejects(requestPhoneNumbers(['p1'], 'https://example.test/hook'), expected, `status ${status}`);
    } finally { stub.restore(); }
  }
});

test('Apollo has_direct_phone is read as the string it actually is', () => {
  // Measured against the live API: Apollo answers "Yes" or
  // "Maybe: please request direct dial via people/bulk_match" - never a
  // boolean. Reading it with === true reported every candidate as having no
  // number, including the ones Apollo said it had one for.
  assert.equal(normalizeCandidate({ id: 'p1', has_direct_phone: 'Yes' }).hasPhoneOnFile, true);
  assert.equal(normalizeCandidate({ id: 'p1', has_direct_phone: 'Yes' }).phoneAvailable, true,
    'so the row can show it before a credit is spent');

  // "Maybe" is Apollo declining to say. Read as a yes it wastes a mobile
  // credit; read as a no it hides a reachable candidate. So it stays unknown.
  const maybe = normalizeCandidate({ id: 'p1', has_direct_phone: 'Maybe: please request direct dial via people/bulk_match' });
  assert.equal(maybe.hasPhoneOnFile, null);
  assert.equal(maybe.phoneAvailable, false);

  assert.equal(normalizeCandidate({ id: 'p1', has_direct_phone: 'No' }).hasPhoneOnFile, false);
  // Booleans and the older field names still work.
  assert.equal(normalizeCandidate({ id: 'p1', has_phone: true }).hasPhoneOnFile, true);
  assert.equal(normalizeCandidate({ id: 'p1', phone_available: false }).hasPhoneOnFile, false);
  assert.equal(normalizeCandidate({ id: 'p1' }).hasPhoneOnFile, null, 'Apollo said nothing at all');

  // A number in hand is available whatever the flag says.
  assert.equal(normalizeCandidate({ id: 'p1', phone_number: '+1 555 0100 111' }).phoneAvailable, true);
});

test('a revealed number is found wherever Apollo puts it, but never the company switchboard', () => {
  const shapes = [
    ['phone_numbers strings', { id: 'p1', phone_numbers: ['+1 555 0100 111'] }],
    ['phone_numbers objects', { id: 'p1', phone_numbers: [{ sanitized_number: '+1 555 0100 111' }] }],
    ['contact.phone_numbers', { id: 'p1', contact: { phone_numbers: [{ raw_number: '+1 555 0100 111' }] } }],
    ['sanitized_phone', { id: 'p1', sanitized_phone: '+1 555 0100 111' }],
    ['contact.sanitized_phone', { id: 'p1', contact: { sanitized_phone: '+1 555 0100 111' } }],
    ['mobile_phone', { id: 'p1', mobile_phone: '+1 555 0100 111' }],
    ['contact.phone_number', { id: 'p1', contact: { phone_number: '+1 555 0100 111' } }],
    ['waterfall vendor', { id: 'p1', waterfall: { phone_numbers: [{ vendors: [{ name: 'Apollo', phone_numbers: ['+1 555 0100 111'] }] }] } }]
  ];
  for (const [label, payload] of shapes) {
    const candidate = normalizeWaterfallCandidate(payload, { requestedId: 'p1', kind: 'phone' });
    assert.equal(candidate.phone, '+1 555 0100 111', label);
  }

  // The employer's number is not the candidate's, and presenting it as theirs
  // would be a fabrication dressed up as data.
  const switchboard = normalizeWaterfallCandidate({
    id: 'p1',
    organization: { name: 'Example Co', phone: '+1 555 0100 222', sanitized_phone: '+1 555 0100 222' },
    phone_numbers: []
  }, { requestedId: 'p1', kind: 'phone' });
  assert.equal(switchboard.phone, null, 'a company switchboard is never the candidate');
  assert.equal(switchboard.company, 'Example Co', 'though the company itself is still read');
});
