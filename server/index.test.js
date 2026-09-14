import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';
process.env.APOLLO_API_KEY = 'test-only-key';
delete process.env.ALLOWED_ORIGIN;
// Set before index.js imports dotenv. dotenv never overwrites a key already in
// process.env, so this pins the suite to a known state instead of inheriting
// whatever the developer happens to have in their own .env.
process.env.APOLLO_WEBHOOK_URL = '';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realFetch = globalThis.fetch.bind(globalThis);
const { default: app } = await import('./index.js');
const { clearCache } = await import('./store.js');

const ok = (payload) => new Response(JSON.stringify(payload), { status: 200 });

// Boots the app on an ephemeral port and routes only api.apollo.io calls to
// the stub, so loopback requests to our own server still work.
async function withServer(apolloHandler, run) {
  // The store is what the app is for - it survives a restart on purpose - so
  // each case starts from an empty one rather than inheriting what the case
  // before it paid for.
  clearCache();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apolloCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    const body = options?.body ? JSON.parse(options.body) : null;
    apolloCalls.push({ url: String(url), headers: options?.headers || {}, body });
    return apolloHandler({ url: String(url), body, index: apolloCalls.length - 1 });
  };
  const get = async (endpoint) => {
    const response = await realFetch(base + endpoint);
    // A path Express does not route answers with HTML, so parsing is optional.
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body };
  };
  const post = async (endpoint, payload, headers = {}) => {
    const response = await realFetch(base + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try {
    return await run({ post, get, apolloCalls });
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('search returns normalized candidates through our backend', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate', title: 'Engineer' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java', page: 2 });
    assert.equal(status, 200);
    assert.equal(body.candidates.length, 1);
    assert.equal(body.candidates[0].name, 'Test Candidate');
    assert.equal(body.page, 2);
    assert.deepEqual(apolloCalls[0].body.person_titles, ['Java Developer']);
    assert.equal(apolloCalls[0].body.page, 2);
  });
});

test('a search with no filters at all is the whole pool, not an error', async () => {
  // The app opens on this: see who is there, then narrow. Every filter here
  // cuts a pool down rather than creating one, so none of them is a
  // precondition for asking.
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate' }], total_entries: 4 }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/search', {});
    assert.equal(status, 200);
    assert.equal(body.candidates.length, 1);
    // Nothing is invented to stand in for the filters that were not given.
    const sent = apolloCalls[0].body;
    for (const key of ['person_titles', 'person_locations', 'person_seniorities', 'q_keywords']) {
      assert.equal(key in sent, false, key);
    }
  });
});

test('punctuation on its own reaches Apollo as no filter, not as a term', async () => {
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/search', { keywords: ' , , ', location: ' , ' });
    assert.equal(status, 200);
    assert.equal('q_keywords' in apolloCalls[0].body, false);
    assert.equal('person_locations' in apolloCalls[0].body, false);
  });
});

test('a role with no location is a search, not an error', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/search', { jobTitle: 'Data Scientist' });
    assert.equal(status, 200);
    assert.deepEqual(apolloCalls[0].body.person_titles, ['Data Scientist']);
    // Nothing is invented to stand in for the location that was not given.
    assert.equal('person_locations' in apolloCalls[0].body, false);
  });
});

test('the three required filters are enough on their own', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java' });
    assert.equal(status, 200);
    assert.deepEqual(apolloCalls[0].body.person_titles, ['Java Developer']);
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Delhi']);
    assert.equal(apolloCalls[0].body.q_keywords, 'Java');
  });
});

test('search narrows to candidates Apollo holds an address for by default', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Candidate One', has_email: true }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/search', { jobTitle: 'AI Developer', location: 'Hyderabad', keywords: 'python' });
    // Search costs nothing, so this filter is pure gain: it keeps enrichment
    // credits off candidates Apollo has no address for at all.
    assert.deepEqual(apolloCalls[0].body.contact_email_status, ['verified', 'likely to engage']);
    assert.equal(body.candidates[0].hasEmailOnFile, true);
    assert.equal(body.candidates[0].emailAvailable, true, 'Apollo says it holds one, before any credit is spent');
  });
});

test('the wider pool is available on explicit opt-out', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Candidate One', has_email: false }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/search', { jobTitle: 'AI Developer', location: 'Hyderabad', keywords: 'python', verifiedEmailOnly: false });
    assert.equal(apolloCalls[0].body.contact_email_status, undefined);
    assert.equal(body.candidates[0].hasEmailOnFile, false, 'and the client is told which ones cannot be reached');
    assert.equal(body.candidates[0].emailAvailable, false);
  });
});

test('enrich forwards only the selected person IDs, deduplicated', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1', 'person-2', 'person-1', '', '   ', 42, null] });
    assert.equal(status, 200);
    assert.deepEqual(body.requestedIds, ['person-1', 'person-2']);
    assert.deepEqual(apolloCalls[0].body.details, [{ id: 'person-1' }, { id: 'person-2' }]);
    assert.deepEqual(body.failedIds, []);
    assert.equal(body.candidates.length, 2);
  });
});

test('enrich rejects an empty selection without calling Apollo', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    for (const payload of [{ ids: [] }, { ids: 'person-1' }, {}]) {
      const { status, body } = await post('/api/candidates/enrich', payload);
      assert.equal(status, 400);
      assert.equal(body.error, 'Select at least one candidate to enrich.');
    }
    assert.equal(apolloCalls.length, 0, 'no Apollo credits are spent on an empty selection');
  });
});

test('enrich splits a large selection into Apollo batches', async () => {
  const ids = Array.from({ length: 23 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/enrich', { ids });
    assert.deepEqual(apolloCalls.map((call) => call.body.details.length), [10, 10, 3]);
    assert.equal(body.candidates.length, 23);
    assert.deepEqual(body.candidates.map((candidate) => candidate.requestedId), ids);
    assert.deepEqual(body.skippedIds, []);
  });
});

test('enrich caps one request and reports the rest as skipped, never dropped', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post }) => {
    const { body } = await post('/api/candidates/enrich', { ids });
    assert.equal(body.requestedIds.length, 25);
    assert.deepEqual(body.skippedIds, ids.slice(25));
    assert.equal(body.requestedIds.length + body.skippedIds.length, 30, 'every selected ID is accounted for');
  });
});

test('enrich reports partial results with the failed IDs', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => (id === 'person-3' ? null : { id, name: `Candidate ${id}` })) }), async ({ post }) => {
    const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1', 'person-2', 'person-3', 'person-4', 'person-5'] });
    assert.equal(status, 200);
    assert.equal(body.candidates.length, 4);
    assert.deepEqual(body.failedIds, ['person-3']);
    assert.equal(body.requestedIds.length, 5);
  });
});

test('search never asks Apollo to reveal contact data', async () => {
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Candidate One' }], total_entries: 1 }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', { jobTitle: 'Engineer', location: 'Hyderabad', keywords: 'Java' });
    assert.equal(apolloCalls.length, 1);
    assert.equal(apolloCalls[0].body.reveal_personal_emails, undefined, 'search is a search, not an enrichment');
    assert.equal(apolloCalls[0].body.reveal_phone_number, undefined);
  });
});

test('plain enrich does not spend contact credits, reveal does', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(apolloCalls[0].body.reveal_personal_emails, false);

    const { status, body } = await post('/api/candidates/reveal', { ids: ['person-1'] });
    assert.equal(status, 200);
    assert.equal(apolloCalls[1].body.reveal_personal_emails, true);
    assert.equal(body.revealedPersonalEmails, true);

    // Phone reveal lands separately; the flag is not sent at all, and no
    // webhook_url is needed for an email-only reveal.
    assert.ok(apolloCalls.every((call) => call.body.reveal_phone_number === undefined));
    assert.ok(apolloCalls.every((call) => call.body.webhook_url === undefined));
    assert.ok(apolloCalls.every((call) => call.url.startsWith('https://api.apollo.io/')));
  });
});

test('reveal rejects an empty selection without calling Apollo', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    for (const payload of [{ ids: [] }, { ids: 'person-1' }, {}]) {
      const { status } = await post('/api/candidates/reveal', payload);
      assert.equal(status, 400);
    }
    assert.equal(apolloCalls.length, 0, 'no Apollo credits are spent on an empty selection');
  });
});

test('reveal is capped tighter than enrich and never drops the remainder', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({
    matches: body.details.map(({ id }, index) => ({
      id,
      name: `Candidate ${id}`,
      // Alternate so the response carries both outcomes at once.
      email: index % 2 === 0 ? `${id}@example-co.com` : null,
      email_status: index % 2 === 0 ? 'verified' : 'unavailable'
    }))
  }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/reveal', { ids });
    // A reveal spends a credit per candidate, so it stops at 10, not 25.
    assert.deepEqual(apolloCalls.map((call) => call.body.details.length), [10], 'one Apollo batch of ten');
    assert.ok(apolloCalls.every((call) => call.body.reveal_personal_emails === true));
    assert.equal(body.requestedIds.length, 10);
    assert.deepEqual(body.skippedIds, ids.slice(10));
    assert.equal(body.requestedIds.length + body.skippedIds.length, 30, 'every selected ID is accounted for');

    const withEmail = body.candidates.filter((candidate) => candidate.email);
    const without = body.candidates.filter((candidate) => !candidate.email);
    assert.ok(withEmail.length > 0 && without.length > 0, 'partial results survive the round trip');
    assert.ok(withEmail.every((candidate) => candidate.email.endsWith('@example-co.com')));
    assert.ok(without.every((candidate) => candidate.email === null), 'a missing address stays null, never invented');
  });
});

test('plain enrich keeps its larger cap of 25', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `person-${index}`);
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/enrich', { ids });
    assert.deepEqual(apolloCalls.map((call) => call.body.details.length), [10, 10, 5]);
    assert.equal(body.requestedIds.length, 25, 'enrichment is not narrowed by the reveal guard');
    assert.deepEqual(body.skippedIds, ids.slice(25));
  });
});

test('reveal sanitizes Apollo 401, 403, 429 and 500 the same way enrich does', async () => {
  const cases = [[401, 502], [403, 502], [429, 429], [500, 502]];
  for (const [apolloStatus, expected] of cases) {
    await withServer(() => new Response(JSON.stringify({ error: 'upstream detail that must not leak' }), { status: apolloStatus }), async ({ post }) => {
      const { status, body } = await post('/api/candidates/reveal', { ids: ['person-1'] });
      assert.equal(status, expected, `Apollo ${apolloStatus}`);
      assert.ok(!JSON.stringify(body).includes('upstream detail'), 'upstream text never reaches the client');
      assert.ok(!JSON.stringify(body).includes(process.env.APOLLO_API_KEY), 'the API key never reaches the client');
    });
  }
});

test('waterfall asks Apollo to search other data sources and returns ids to poll', async () => {
  process.env.APOLLO_WEBHOOK_URL = 'https://example.test/apollo-webhook';
  const { default: freshApp } = await import(`./index.js?waterfall=${Date.now()}`);
  const server = freshApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apolloCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    // The preflight probe: answering it proves the webhook is reachable.
    if (String(url).startsWith('https://example.test/')) return new Response('{}', { status: 200 });
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    const body = options?.body ? JSON.parse(options.body) : null;
    apolloCalls.push({ url: String(url), body });
    return ok({ request_id: -123456789, matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}`, email: `${id}@example-co.com` })) });
  };
  try {
    const res = await realFetch(`${base}/api/candidates/waterfall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['person-1', 'person-2'] })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(apolloCalls[0].body.run_waterfall_email, true);
    assert.equal(apolloCalls[0].body.reveal_personal_emails, true);
    assert.equal(apolloCalls[0].body.webhook_url, 'https://example.test/apollo-webhook');
    // Phone waterfall is a separate, far costlier task and stays off.
    assert.equal(apolloCalls[0].body.run_waterfall_phone, undefined);
    assert.deepEqual(body.requests, [{ requestId: '-123456789', ids: ['person-1', 'person-2'] }]);
    // Whatever Apollo already held comes back at once, rather than waiting.
    assert.equal(body.candidates.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APOLLO_WEBHOOK_URL;
  }
});

test('waterfall refuses to start without a configured webhook URL', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/waterfall', { ids: ['person-1'] });
    assert.equal(status, 503);
    assert.match(body.error, /APOLLO_WEBHOOK_URL/);
    assert.equal(apolloCalls.length, 0, 'nothing is sent to Apollo, so nothing is charged');
  });
});

test('waterfall rejects an empty selection without calling Apollo', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/waterfall', { ids: [] });
    assert.equal(status, 400);
    assert.equal(apolloCalls.length, 0);
  });
});

test('the poll route reports pending, ready and expired, and spends nothing', async () => {
  const cases = [
    ['pending with a hint', new Response(JSON.stringify({ error_code: 'result_pending', retry_after_seconds: 7 }), { status: 404 }),
      (body) => { assert.equal(body.status, 'pending'); assert.equal(body.retryAfterSeconds, 7); }],
    ['pending without one', new Response(JSON.stringify({ error_code: 'result_pending' }), { status: 404 }),
      (body) => { assert.equal(body.status, 'pending'); assert.equal(body.retryAfterSeconds, 10, 'falls back to a sane hint'); }],
    ['expired', new Response(JSON.stringify({ error_code: 'request_id_expired' }), { status: 410 }),
      (body) => assert.equal(body.status, 'expired')],
    ['unknown id', new Response(JSON.stringify({ error_code: 'request_id_unknown' }), { status: 404 }),
      (body) => assert.equal(body.status, 'expired')],
    ['ready', ok({ people: [{ id: 'person-1', name: 'Candidate One', email: 'work@example-co.com', personal_emails: ['found@gmail.com'] }] }),
      (body) => {
        assert.equal(body.status, 'ready');
        assert.equal(body.candidates[0].email, 'work@example-co.com');
        // The address the waterfall was run to find.
        assert.equal(body.candidates[0].personalEmail, 'found@gmail.com');
        assert.equal(body.candidates[0].requestedId, 'person-1');
      }]
  ];

  for (const [label, response, check] of cases) {
    await withServer(() => response.clone(), async ({ get, apolloCalls }) => {
      const { status, body } = await get('/api/candidates/waterfall/-123456789');
      assert.equal(status, 200, label);
      check(body);
      assert.equal(apolloCalls[0].url, 'https://api.apollo.io/api/v1/webhook_result/-123456789');
    });
  }
});

test('the poll route refuses a request id it did not issue', async () => {
  await withServer(() => ok({}), async ({ get, apolloCalls }) => {
    for (const bad of ['abc', '../secrets', '12x', '']) {
      const { status } = await get(`/api/candidates/waterfall/${encodeURIComponent(bad)}`);
      assert.ok(status === 400 || status === 404, `rejects ${JSON.stringify(bad)}`);
    }
    assert.equal(apolloCalls.length, 0, 'nothing is forwarded to Apollo');
  });
});

test('the webhook receiver keeps a delivered result and serves it back', async () => {
  process.env.APOLLO_WEBHOOK_URL = 'https://example.test/apollo-webhook';
  const { default: freshApp } = await import(`./index.js?receiver=${Date.now()}`);
  const server = freshApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A real 64-bit id: it must survive the receiver as well as the request.
  const exactId = '4211274463135576197';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.test/')) return new Response('{}', { status: 200 });
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    return new Response(`{"request_id":${exactId},"matches":[{"id":"person-1","name":"Candidate One"}]}`, { status: 200 });
  };
  try {
    const started = await realFetch(`${base}/api/candidates/waterfall`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['person-1'] })
    });
    const startedBody = await started.json();
    assert.deepEqual(startedBody.requests, [{ requestId: exactId, ids: ['person-1'] }]);

    // Apollo delivers the addresses themselves by POSTing them here.
    const delivered = await realFetch(`${base}/api/apollo/waterfall-webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: `{"request_id":${exactId},"webhook_result":{"people":[{"id":"person-1","name":"Candidate One","email":"work@example-co.com","personal_emails":["found@gmail.com"]}]}}`
    });
    assert.deepEqual(await delivered.json(), { received: true });

    // And polling now serves what was delivered, not Apollo's id-only summary.
    const polled = await realFetch(`${base}/api/candidates/waterfall/${exactId}`);
    const body = await polled.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.deliveredByWebhook, true);
    assert.equal(body.candidates[0].email, 'work@example-co.com');
    assert.equal(body.candidates[0].personalEmail, 'found@gmail.com');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APOLLO_WEBHOOK_URL;
  }
});

test('the webhook receiver ignores a request id it never issued', async () => {
  await withServer(() => ok({}), async ({ post }) => {
    // The endpoint is public, so an unknown id must not be able to inject
    // candidate records into the app.
    const { status, body } = await post('/api/apollo/waterfall-webhook', {});
    assert.equal(status, 202);
    assert.deepEqual(body, { received: false });
  });
});

test('a finished waterfall is read from webhook_result, not the top level', async () => {
  await withServer(() => ok({
    request_id: 12,
    webhook_status: 'failed',
    failure_reason: 'Webhook error: 404',
    webhook_result: {
      status: 'success',
      email_records_enriched: 1,
      email_records_not_found: 0,
      credits_consumed: 1,
      // Delivery failed, so the stored copy carries the id but no address.
      people: [{ id: 'person-1' }]
    }
  }), async ({ get }) => {
    const { body } = await get('/api/candidates/waterfall/12');
    assert.equal(body.status, 'ready');
    assert.equal(body.summary.emailsFound, 1, 'Apollo says it found one');
    assert.equal(body.summary.creditsConsumed, 1, 'and charged for it');
    assert.equal(body.delivery.status, 'failed', 'but never delivered it');
    // Which is the difference between "nothing exists" and "we lost it".
    assert.equal(body.candidates[0].email, null);
  });
});

test('an unreachable webhook stops the search before Apollo is called', async () => {
  // The exact failure that has cost credits twice: a stale tunnel hostname, and
  // a URL that resolves but 404s. Both must be caught before any spending.
  const cases = [
    ['https://does-not-resolve.invalid/api/apollo/waterfall-webhook', () => { throw new TypeError('fetch failed'); }, /unreachable/i],
    ['https://example.test/wrong-path', () => new Response('not found', { status: 404 }), /returns 404/i],
    ['http://example.test/insecure', () => new Response('{}', { status: 200 }), /https/i]
  ];

  for (const [url, probe, expected] of cases) {
    process.env.APOLLO_WEBHOOK_URL = url;
    const { default: freshApp } = await import(`./index.js?preflight=${Date.now()}${Math.random()}`);
    const server = freshApp.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const apolloCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (target, options) => {
      if (String(target).includes('api.apollo.io')) { apolloCalls.push(String(target)); return ok({}); }
      if (String(target).startsWith('http')) return probe();
      return realFetch(target, options);
    };
    try {
      const res = await realFetch(`${base}/api/candidates/waterfall`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['person-1'] })
      });
      const body = await res.json();
      assert.equal(res.status, 503, url);
      assert.equal(body.code, 'APOLLO_WEBHOOK_UNREACHABLE');
      assert.match(body.error, expected);
      assert.equal(apolloCalls.length, 0, 'nothing was sent to Apollo, so nothing was charged');
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise((resolve) => server.close(resolve));
      delete process.env.APOLLO_WEBHOOK_URL;
    }
  }
});

test('Apollo failures become sanitized client errors', async () => {
  const cases = [
    [401, 502, 'Apollo API authentication failed.', 'APOLLO_AUTH'],
    [429, 429, 'Apollo API rate limit reached. Please try again later.', 'APOLLO_RATE_LIMIT'],
    [500, 502, 'Unable to connect to Apollo. Please try again.', 'APOLLO_UNAVAILABLE']
  ];
  for (const [upstream, expectedStatus, expectedMessage, expectedCode] of cases) {
    await withServer(() => new Response(JSON.stringify({ error: 'upstream detail', key: 'test-only-key' }), { status: upstream }), async ({ post }) => {
      const { status, body } = await post('/api/candidates/enrich', { ids: ['person-1'] });
      assert.equal(status, expectedStatus, `upstream ${upstream}`);
      assert.equal(body.error, expectedMessage);
      assert.equal(body.code, expectedCode);
      assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], 'no upstream detail is echoed');
    });
  }
});

test('an exhausted credit balance is reported as such, not as a connection failure', async () => {
  // Exactly what Apollo sends when the billing cycle's credits are gone.
  const exhausted = () => new Response(JSON.stringify({
    error: "You have insufficient credits! <a href='https://app.apollo.io/#/settings/plans/upgrade'>Upgrade your plan</a>",
    error_details: { code: 'BILLING.LIMIT.CREDITS_EXHAUSTED', message: 'Your team has used all of its credits for this billing cycle.' }
  }), { status: 422 });

  for (const route of ['/api/candidates/enrich', '/api/candidates/reveal']) {
    await withServer(exhausted, async ({ post }) => {
      const { status, body } = await post(route, { ids: ['person-1'] });
      assert.equal(status, 402, `${route} answers Payment Required`);
      assert.equal(body.code, 'APOLLO_CREDITS_EXHAUSTED');
      assert.match(body.error, /no credits left for this billing cycle/i);
      // The message must name the real cause rather than blaming the network.
      assert.doesNotMatch(body.error, /unable to connect/i);
      assert.match(body.error, /add credits or upgrade/i, 'it says what to actually do');
      // Apollo's own markup and upgrade link are never passed through.
      assert.doesNotMatch(JSON.stringify(body), /<a href|app\.apollo\.io|BILLING\.LIMIT/);
    });
  }
});

test('a 422 that is not about credits stays a generic failure', async () => {
  await withServer(() => new Response(JSON.stringify({ error: 'some other unprocessable thing' }), { status: 422 }), async ({ post }) => {
    const { status, body } = await post('/api/candidates/reveal', { ids: ['person-1'] });
    assert.equal(status, 502);
    assert.equal(body.code, 'APOLLO_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(body), /unprocessable/);
  });
});

test('the Apollo key never appears in any API response', async () => {
  await withServer(({ body }) => ok({ matches: body.details.map(({ id }) => ({ id, name: `Candidate ${id}` })) }), async ({ post, apolloCalls }) => {
    const search = await post('/api/candidates/search', { jobTitle: 'Java Developer', location: 'Delhi', keywords: 'Java' });
    const enrich = await post('/api/candidates/enrich', { ids: ['person-1'] });
    for (const response of [search, enrich]) {
      assert.doesNotMatch(JSON.stringify(response.body), /test-only-key/);
      assert.doesNotMatch(JSON.stringify(response.body), /APOLLO_API_KEY/);
    }
    assert.equal(apolloCalls.at(-1).headers['x-api-key'], 'test-only-key', 'the key is sent only from the backend to Apollo');
  });
});

test('credit-spending endpoints send no CORS headers by default', async () => {
  await withServer(() => ok({ matches: [] }), async ({ post }) => {
    const { headers } = await post('/api/candidates/enrich', { ids: [] }, { Origin: 'https://not-our-app.example' });
    assert.equal(headers.get('access-control-allow-origin'), null);
  });
});

test('no frontend source file references the Apollo key', async () => {
  const files = await readdir(path.join(projectRoot, 'src'), { recursive: true });
  // Shipped sources only. Test fixtures legitimately contain LinkedIn URLs
  // and are never bundled into the client.
  const sources = files.filter((file) => /\.(jsx?|css|html)$/.test(file) && !/\.test\./.test(file));
  assert.ok(sources.length > 0, 'found frontend sources to check');
  for (const file of sources) {
    const contents = readFileSync(path.join(projectRoot, 'src', file), 'utf8');
    assert.doesNotMatch(contents, /APOLLO_API_KEY/, `${file} must not reference the key`);
    assert.doesNotMatch(contents, /x-api-key/i, `${file} must not send an Apollo key`);
    assert.doesNotMatch(contents, /api\.apollo\.io/, `${file} must call our backend, not Apollo directly`);
    assert.doesNotMatch(contents, /linkedin\.com\/in/i, `${file} must not hardcode LinkedIn endpoints`);
  }
});

test('the frontend never stores candidate data in browser storage', async () => {
  const files = await readdir(path.join(projectRoot, 'src'), { recursive: true });
  for (const file of files.filter((name) => /\.jsx?$/.test(name) && !/\.test\./.test(name))) {
    const contents = readFileSync(path.join(projectRoot, 'src', file), 'utf8');
    assert.doesNotMatch(contents, /localStorage|sessionStorage/, `${file} must not persist Apollo data in the browser`);
    assert.doesNotMatch(contents, /<iframe/i, `${file} must not embed iframes`);
    assert.doesNotMatch(contents, /window\.open/, `${file} must not open profiles automatically`);
  }
});

test('the lookup route matches one person and answers with the candidate', async () => {
  await withServer(() => ok({
    person: { id: 'person-1', name: 'Test Candidate', title: 'Python Developer', organization: { name: 'Example Co' } }
  }), async ({ post, apolloCalls }) => {
    const { status, body } = await post('/api/candidates/lookup', { name: 'Test Candidate', company: 'Example Co' });
    assert.equal(status, 200);
    assert.equal(body.matched, true);
    assert.equal(body.candidate.name, 'Test Candidate');
    assert.equal(body.candidate.company, 'Example Co');

    assert.ok(apolloCalls[0].url.endsWith('/people/match'));
    assert.equal(apolloCalls[0].body.reveal_personal_emails, false, 'a lookup never asks for contact data');
    assert.equal(apolloCalls[0].body.reveal_phone_number, undefined);
    // The key belongs to the server and never travels to the client.
    assert.ok(!JSON.stringify(body).includes(process.env.APOLLO_API_KEY));
  });
});

test('a lookup that matches nobody is a result, not an error', async () => {
  await withServer(() => ok({ person: null }), async ({ post }) => {
    const { status, body } = await post('/api/candidates/lookup', { email: 'nobody@example-co.test' });
    // Apollo answered. It just has no such person, which the client renders as
    // a message rather than a failure.
    assert.equal(status, 200);
    assert.equal(body.matched, false);
    assert.equal(body.candidate, null);
    assert.equal(body.error, undefined);
  });
});

test('a lookup with nothing to match on never reaches Apollo', async () => {
  await withServer(() => ok({ person: { id: 'person-1' } }), async ({ post, apolloCalls }) => {
    for (const payload of [{}, { name: '   ' }, { name: '', email: '', linkedinUrl: '' }, { ids: ['person-1'] }]) {
      const { status } = await post('/api/candidates/lookup', payload);
      assert.equal(status, 400, JSON.stringify(payload));
    }
    // A company identifies an employer, not a person: Apollo would answer with
    // whoever it happened to rank first.
    const companyOnly = await post('/api/candidates/lookup', { company: 'Example Co' });
    assert.equal(companyOnly.status, 400);
    assert.match(companyOnly.body.error, /not a person/i);

    assert.equal(apolloCalls.length, 0, 'nothing was sent, so nothing could be charged');
  });
});

test('the lookup route reports Apollo failures with the same public wording', async () => {
  const cases = [
    [401, 502, /authentication failed/i],
    [429, 429, /rate limit/i],
    [new Response(JSON.stringify({ error_code: 'CREDITS_EXHAUSTED' }), { status: 422 }), 402, /no credits left/i]
  ];
  for (const [given, expectedStatus, expectedMessage] of cases) {
    const response = typeof given === 'number'
      ? () => new Response(JSON.stringify({ error: 'upstream detail that must not leak' }), { status: given })
      : () => given.clone();
    await withServer(response, async ({ post }) => {
      const { status, body } = await post('/api/candidates/lookup', { name: 'Test Candidate' });
      assert.equal(status, expectedStatus);
      assert.match(body.error, expectedMessage);
      assert.doesNotMatch(body.error, /upstream detail/, 'Apollo own wording never leaks');
    });
  }
});

test('a lookup only sends the identifiers it was given, trimmed and bounded', async () => {
  await withServer(() => ok({ person: { id: 'person-1', name: 'Test Candidate' } }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/lookup', {
      name: '  Test Candidate  ', company: '', email: '', linkedinUrl: `https://www.linkedin.com/in/${'x'.repeat(600)}`
    });
    const sent = apolloCalls[0].body;
    assert.equal(sent.name, 'Test Candidate', 'trimmed');
    assert.equal('organization_name' in sent, false, 'an empty company is not a filter');
    assert.equal('email' in sent, false);
    assert.ok(sent.linkedin_url.length <= 400, 'a URL cannot be used to push an unbounded body upstream');
  });
});

test('the phone route asks Apollo for numbers and returns ids to poll', async () => {
  process.env.APOLLO_WEBHOOK_URL = 'https://example.test/apollo-webhook';
  const { default: freshApp } = await import(`./index.js?phone=${Date.now()}`);
  const server = freshApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const apolloCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.test/')) return new Response('{}', { status: 200 });
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    apolloCalls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
    return new Response('{"request_id":991,"matches":[{"id":"person-1","name":"Candidate One"}]}', { status: 200 });
  };
  try {
    const res = await realFetch(`${base}/api/candidates/phone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['person-1'] })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.requests, [{ requestId: '991', ids: ['person-1'] }]);
    assert.equal(apolloCalls[0].body.reveal_phone_number, true);
    // Only this route ever sets it, and it does not also buy emails.
    assert.equal(apolloCalls[0].body.reveal_personal_emails, undefined);
    assert.ok(!JSON.stringify(body).includes(process.env.APOLLO_API_KEY), 'the key never reaches the client');

    // And the poll route reports it as a phone job, which is the only way the
    // client can tell a "no number" answer from a "no email" one.
    const polled = await realFetch(`${base}/api/candidates/waterfall/991`);
    assert.equal((await polled.json()).kind, 'phone');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APOLLO_WEBHOOK_URL;
  }
});

test('the phone route caps a large selection instead of spending on all of it', async () => {
  process.env.APOLLO_WEBHOOK_URL = 'https://example.test/apollo-webhook';
  const { default: freshApp } = await import(`./index.js?phonecap=${Date.now()}`);
  const { MAX_PHONE_PER_REQUEST } = await import(`./index.js?phonecap=${Date.now()}`);
  const server = freshApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://example.test/')) return new Response('{}', { status: 200 });
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    sent.push(JSON.parse(options.body).details.length);
    return new Response('{"request_id":992,"matches":[]}', { status: 200 });
  };
  try {
    const ids = Array.from({ length: 12 }, (_, index) => `person-${index + 1}`);
    const res = await realFetch(`${base}/api/candidates/phone`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
    });
    const body = await res.json();
    // Mobile credits are the dearest thing here, so the cap is tightest.
    assert.equal(body.requestedIds.length, MAX_PHONE_PER_REQUEST || 5);
    assert.equal(body.skippedIds.length, 12 - (MAX_PHONE_PER_REQUEST || 5), 'the rest are reported, never silently dropped');
    assert.equal(sent.reduce((total, count) => total + count, 0), MAX_PHONE_PER_REQUEST || 5);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APOLLO_WEBHOOK_URL;
  }
});

test('the phone route rejects an empty selection without calling Apollo', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/phone', { ids: [] });
    assert.equal(status, 400);
    assert.equal(apolloCalls.length, 0);
  });
});

test('phone reveal refuses to start without a reachable webhook URL', async () => {
  await withServer(() => ok({}), async ({ post, apolloCalls }) => {
    // Apollo charges for numbers it delivers whether or not the delivery lands,
    // so an unset webhook must stop the request before it costs anything.
    const { status, body } = await post('/api/candidates/phone', { ids: ['person-1'] });
    assert.equal(status, 503);
    assert.match(body.error, /APOLLO_WEBHOOK_URL/);
    assert.equal(apolloCalls.length, 0, 'no mobile credit could have been spent');
  });
});

test('an expired tunnel hostname is named as one, not reported as a vague failure', async () => {
  // The common case with a trycloudflare quick tunnel: the hostname is issued
  // per run and stops resolving once that run ends. "could not be reached"
  // sent people hunting for a server problem instead of a dead hostname.
  process.env.APOLLO_WEBHOOK_URL = 'https://gone-for-good.trycloudflare.com/api/apollo/waterfall-webhook';
  const { default: freshApp } = await import(`./index.js?dns=${Date.now()}`);
  const server = freshApp.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('gone-for-good')) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      throw error;
    }
    if (!String(url).includes('api.apollo.io')) return realFetch(url, options);
    throw new Error('Apollo must not be called when the webhook is dead');
  };
  try {
    for (const route of ['/api/candidates/phone', '/api/candidates/waterfall']) {
      const res = await realFetch(base + route, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['person-1'] })
      });
      const body = await res.json();
      assert.equal(res.status, 503, route);
      assert.match(body.error, /no longer exists/i, route);
      assert.match(body.error, /gone-for-good\.trycloudflare\.com does not resolve/i, route);
      // And the other half of the fix, which is easy to miss.
      assert.match(body.error, /restart the API server/i, route);
      assert.match(body.error, /only read when the process starts/i, route);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APOLLO_WEBHOOK_URL;
  }
});

test('a role alone is a valid search, and so are skills alone', async () => {
  // Skills used to be compulsory, which forced the most destructive filter on
  // every query: measured live, one keyword cut a 3,088-candidate pool to 9.
  await withServer(() => ok({ people: [{ id: 'person-1', name: 'Test Candidate' }], total_entries: 645 }),
    async ({ post, apolloCalls }) => {
      const roleOnly = await post('/api/candidates/search', { jobTitle: 'AI/ML Engineer', location: 'Hyderabad' });
      assert.equal(roleOnly.status, 200);
      assert.equal(roleOnly.body.total, 645);
      assert.deepEqual(apolloCalls[0].body.person_titles, ['AI/ML Engineer']);
      assert.equal('q_keywords' in apolloCalls[0].body, false, 'no skill was given, so none is sent');

      const skillsOnly = await post('/api/candidates/search', { keywords: 'Python', location: 'Hyderabad' });
      assert.equal(skillsOnly.status, 200);
      assert.equal(apolloCalls[1].body.q_keywords, 'Python');
      assert.equal('person_titles' in apolloCalls[1].body, false, 'no role was given, so none is sent');
    });
});

test('a comma-separated role becomes an OR of job titles', async () => {
  // person_titles is an OR at Apollo, so more titles widen the pool - measured,
  // one title returned 645 and four returned 3,088. That is the opposite of
  // how keywords behave, and it is what covers a role with many names.
  await withServer(() => ok({ people: [], total_entries: 3088 }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', {
      jobTitle: 'AI/ML Engineer, Machine Learning Engineer , Data Scientist,, AI/ML Engineer',
      location: 'Hyderabad'
    });
    // Trimmed, de-duplicated, and empty entries dropped.
    assert.deepEqual(apolloCalls[0].body.person_titles,
      ['AI/ML Engineer', 'Machine Learning Engineer', 'Data Scientist']);
  });
});

test('several skills are asked for one at a time and merged, never ANDed', async () => {
  // Apollo has no OR: "python OR llm" matches the literal word "or" and returns
  // nothing, and several words in q_keywords means "all of them". So each skill
  // is its own request and the answers are unioned.
  const bySkill = {
    Python: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    LLM: [{ id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }],
    'Machine Learning': [{ id: 'p2', name: 'Two' }]
  };
  await withServer(({ body }) => ok({
    people: bySkill[body.q_keywords] || [],
    total_entries: (bySkill[body.q_keywords] || []).length
  }), async ({ post, apolloCalls }) => {
    const { body } = await post('/api/candidates/search', {
      jobTitle: 'AI/ML Engineer', keywords: 'Python, LLM, Machine Learning', location: 'Hyderabad'
    });

    // One request per skill, each carrying the whole skill and nothing else.
    assert.equal(apolloCalls.length, 3);
    assert.deepEqual(apolloCalls.map((call) => call.body.q_keywords), ['Python', 'LLM', 'Machine Learning']);
    // A multi-word skill stays one skill, not two separate requirements.
    assert.equal(apolloCalls[2].body.q_keywords, 'Machine Learning');
    // The role travels with every one of them, and is never rewritten by the
    // skills: a Software Engineer who works in Python is still a Python match.
    for (const call of apolloCalls) assert.deepEqual(call.body.person_titles, ['AI/ML Engineer']);

    // Anyone matching any skill is kept, strongest match first.
    assert.deepEqual(body.candidates.map((candidate) => candidate.name), ['Two', 'One', 'Three']);
    assert.deepEqual(body.candidates[0].matchedSkills, ['Python', 'LLM', 'Machine Learning']);
    assert.deepEqual(body.candidates[1].matchedSkills, ['Python']);
    assert.deepEqual(body.candidates[2].matchedSkills, ['LLM']);
    // Summing per-skill totals would count "Two" three times, so no total is
    // claimed; what Apollo actually said is passed through instead.
    assert.equal(body.total, null);
    assert.deepEqual(body.skillTotals, [
      { skill: 'Python', total: 2 }, { skill: 'LLM', total: 2 }, { skill: 'Machine Learning', total: 1 }
    ]);
  });
});

test('a skills search is capped so one query cannot fan out without limit', async () => {
  const { MAX_SKILL_QUERIES } = await import('./apolloService.js');
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', { keywords: 'a, b, c, d, e, f, g, h', location: 'Hyderabad' });
    assert.equal(apolloCalls.length, MAX_SKILL_QUERIES);
  });
});

test('matchAllSkills asks Apollo for every skill in one request', async () => {
  await withServer(() => ok({ people: [{ id: 'p1', name: 'Both' }], total_entries: 3 }),
    async ({ post, apolloCalls }) => {
      const { body } = await post('/api/candidates/search', {
        keywords: 'python, c++', location: 'hyderabad', matchAllSkills: true
      });
      // One request, both skills in it: Apollo ANDs the words natively.
      assert.equal(apolloCalls.length, 1);
      assert.equal(apolloCalls[0].body.q_keywords, 'python c++');
      // And a single request means a real total, unlike the merged union.
      assert.equal(body.total, 3);
      assert.equal(body.matchedAllSkills, true);
      assert.deepEqual(body.candidates[0].matchedSkills, ['python', 'c++']);
      assert.deepEqual(body.skillTotals, [{ skill: 'python + c++', total: 3 }]);
    });
});

test('matchAllSkills is off unless it is asked for', async () => {
  await withServer(() => ok({ people: [], total_entries: 0 }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', { keywords: 'python, c++', location: 'hyderabad' });
    // Two skills, two requests: the default is "any of them".
    assert.equal(apolloCalls.length, 2);
    for (const value of [undefined, false, 'true', 1]) {
      apolloCalls.length = 0;
      await post('/api/candidates/search', { keywords: 'python, c++', location: 'hyderabad', matchAllSkills: value });
      assert.equal(apolloCalls.length, 2, `matchAllSkills: ${JSON.stringify(value)} is not a true boolean`);
    }
  });
});

test('one location produces one person_locations value', async () => {
  await withServer(() => ok({ people: [], total_entries: 444 }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', { jobTitle: 'Frontend Developer', location: 'Hyderabad' });
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Hyderabad']);
  });
});

test('several locations are sent as an OR, not narrowed together', async () => {
  // person_locations is an OR at Apollo, like person_titles: measured for one
  // title, Hyderabad alone returned 444 and Hyderabad, Bangalore and Pune
  // together returned 1,971. Sending them as one string would have asked for a
  // single place called "Hyderabad, Bangalore, Pune" instead.
  await withServer(() => ok({ people: [], total_entries: 1971 }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', {
      jobTitle: 'Frontend Developer', location: 'Hyderabad, Bangalore, Pune'
    });
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Hyderabad', 'Bangalore', 'Pune']);
    // Exactly what was asked for: no city is expanded into its neighbours, and
    // no radius is added - Apollo has no way to express one.
    assert.equal(apolloCalls[0].body.person_locations.length, 3);
  });
});

test('locations are trimmed and de-duplicated, and empties are dropped', async () => {
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', {
      jobTitle: 'Frontend Developer', location: ' Hyderabad ,, Bangalore,Hyderabad , '
    });
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Hyderabad', 'Bangalore']);
  });
});

test('a location that itself contains a country still works', async () => {
  // "Hyderabad, India" is one location to a recruiter but two comma-separated
  // values here. Apollo returned the identical count for "Hyderabad" and
  // "Hyderabad, India", and both parts resolve, so the OR is harmless.
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/search', { jobTitle: 'Frontend Developer', location: 'Telangana' });
    assert.deepEqual(apolloCalls[0].body.person_locations, ['Telangana']);
  });
});

test('no location at all sends no person_locations', async () => {
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    // A name search is the one query that needs no location.
    await post('/api/candidates/search', { personName: 'Aditya' });
    assert.equal('person_locations' in apolloCalls[0].body, false);
  });
});

test('a location list of only separators is sent to Apollo as no location', async () => {
  await withServer(() => ok({ people: [] }), async ({ post, apolloCalls }) => {
    const { status } = await post('/api/candidates/search', {
      jobTitle: 'Frontend Developer', location: ' , , '
    });
    // The role carries the search; the punctuation is simply dropped rather
    // than sent to Apollo as a place.
    assert.equal(status, 200);
    assert.equal('person_locations' in apolloCalls[0].body, false);
  });
});

// --- What Apollo has already been paid for ----------------------------------
//
// Enrichment, a revealed email and a phone number each cost a credit, and each
// answer is the same the next time it is asked for. The store keeps them, so a
// candidate looked at again - tomorrow, or after a restart - is paid for once.

const enrichable = (id, name) => ({ id, name, email: `${id}@example.com`, organization: { name: 'Example Co' } });

test('a candidate is enriched once, and served from the store after that', async () => {
  await withServer(() => ok({ matches: [enrichable('person-1', 'Test Candidate')] }), async ({ post, apolloCalls }) => {
    const first = await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(first.status, 200);
    assert.equal(apolloCalls.length, 1);
    assert.deepEqual(first.body.fromCacheIds, []);

    // Same candidate, same answer, no second credit.
    const second = await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(second.status, 200);
    assert.equal(apolloCalls.length, 1, 'Apollo is not asked again for a candidate already bought');
    assert.deepEqual(second.body.fromCacheIds, ['person-1']);
    assert.equal(second.body.candidates[0].name, 'Test Candidate');
    assert.equal(second.body.candidates[0].fromCache, true);
  });
});

test('only the candidates not already held are asked for', async () => {
  await withServer(({ body }) => ok({
    matches: (body.details || []).map((detail, index) => enrichable(detail.id, `Person ${index}`))
  }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    const mixed = await post('/api/candidates/enrich', { ids: ['person-1', 'person-2'] });

    assert.equal(apolloCalls.length, 2);
    // The second call carries person-2 alone: person-1 was already owned.
    assert.deepEqual(apolloCalls[1].body.details.map((detail) => detail.id), ['person-2']);
    assert.deepEqual(mixed.body.fromCacheIds, ['person-1']);
    assert.equal(mixed.body.candidates.length, 2);
  });
});

test('refresh buys a new copy rather than being handed the stored one', async () => {
  await withServer(() => ok({ matches: [enrichable('person-1', 'Test Candidate')] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    const again = await post('/api/candidates/enrich', { ids: ['person-1'], refresh: true });

    assert.equal(apolloCalls.length, 2, 'Refresh from Apollo has to reach Apollo');
    assert.deepEqual(again.body.fromCacheIds, []);
  });
});

test('an enrichment does not answer a reveal, because it never paid for one', async () => {
  await withServer(() => ok({ matches: [enrichable('person-1', 'Test Candidate')] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    const revealed = await post('/api/candidates/reveal', { ids: ['person-1'] });

    // The stored row holds a work address; a personal one was never bought, so
    // the reveal is a real request.
    assert.equal(apolloCalls.length, 2);
    assert.deepEqual(revealed.body.fromCacheIds, []);
    assert.equal(apolloCalls[1].body.reveal_personal_emails, true);

    // And the second reveal is free.
    await post('/api/candidates/reveal', { ids: ['person-1'] });
    assert.equal(apolloCalls.length, 2);
  });
});

test('a search hands back the details this account already owns', async () => {
  await withServer(({ url }) => {
    if (url.includes('people/bulk_match')) return ok({ matches: [enrichable('person-1', 'Test Candidate')] });
    return ok({ people: [{ id: 'person-1', name: 'Test Candidate', title: 'Java Developer' }], total_entries: 1 });
  }, async ({ post }) => {
    // Nothing owned yet: the row comes back as any other search row does.
    const before = await post('/api/candidates/search', { jobTitle: 'Java Developer' });
    assert.equal(before.body.candidates[0].enriched, false);

    await post('/api/candidates/enrich', { ids: ['person-1'] });

    // Now the same search returns the row already enriched, so the recruiter
    // opens the details instead of paying to see them again.
    const after = await post('/api/candidates/search', { jobTitle: 'Java Developer' });
    assert.equal(after.body.candidates[0].enriched, true);
    assert.equal(after.body.candidates[0].fromCache, true);
    assert.equal(after.body.candidates[0].email, 'person-1@example.com');
    // The search row is the newer statement of the job, so it still wins.
    assert.equal(after.body.candidates[0].title, 'Java Developer');
  });
});

test('an expired record is bought again rather than served stale', async () => {
  const previous = process.env.CANDIDATE_CACHE_TTL_DAYS;
  await withServer(() => ok({ matches: [enrichable('person-1', 'Test Candidate')] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(apolloCalls.length, 1);

    // People change jobs and addresses stop working, so a record has a life.
    process.env.CANDIDATE_CACHE_TTL_DAYS = '0.0000001';
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(apolloCalls.length, 2);
  });
  if (previous === undefined) delete process.env.CANDIDATE_CACHE_TTL_DAYS;
  else process.env.CANDIDATE_CACHE_TTL_DAYS = previous;
});

test('the store can be turned off outright', async () => {
  process.env.CANDIDATE_CACHE = 'off';
  await withServer(() => ok({ matches: [enrichable('person-1', 'Test Candidate')] }), async ({ post, apolloCalls }) => {
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    await post('/api/candidates/enrich', { ids: ['person-1'] });
    assert.equal(apolloCalls.length, 2, 'nothing is held, so every request is paid for');
  });
  delete process.env.CANDIDATE_CACHE;
});

// --- A sparse answer must not erase what was already paid for --------------
//
// A phone webhook payload, a waterfall husk and a plain search row all carry
// empty arrays and `false` for every field they do not speak to. Merging those
// as statements wiped the skills and employment history off a candidate already
// enriched, while leaving `enriched: true` on the row - so the details panel
// showed "Not available" for data the account had been charged for.

test('a sparse later answer does not erase a stored enrichment', async () => {
  const { saveCandidates, readCached, NEEDS_ENRICHED, clearCache } = await import('./store.js');
  clearCache();

  saveCandidates([{
    id: 'person-1', name: 'Test Candidate', email: 'work@example-co.test',
    skills: ['Java', 'AWS'], departments: ['engineering'],
    employmentHistory: [{ organization: 'Example Co', title: 'Java Developer', current: true }],
    emailAvailable: true
  }], { enriched: true });

  // The husk a phone job delivers: an id, a number, and nothing else it knows.
  saveCandidates([{
    id: 'person-1', name: null, skills: [], departments: [], employmentHistory: [],
    emailAvailable: false, phone: '+1 555 0100 111'
  }], { phone: true });

  const held = readCached(['person-1'], NEEDS_ENRICHED).get('person-1');
  assert.deepEqual(held.skills, ['Java', 'AWS'], 'skills survived the sparse save');
  assert.deepEqual(held.departments, ['engineering']);
  assert.equal(held.employmentHistory.length, 1, 'employment history survived');
  assert.equal(held.emailAvailable, true, 'a false on a sparse answer is an absence, not a correction');
  assert.equal(held.name, 'Test Candidate');
  // What the sparse answer did actually state is written.
  assert.equal(held.phone, '+1 555 0100 111');
});

test('stated() keeps only the fields an answer really makes a claim about', async () => {
  const { stated } = await import('./store.js');
  assert.deepEqual(
    stated({ a: 'x', b: 1, c: true, d: null, e: undefined, f: '', g: false, h: [], i: ['v'] }),
    { a: 'x', b: 1, c: true, i: ['v'] }
  );
});
