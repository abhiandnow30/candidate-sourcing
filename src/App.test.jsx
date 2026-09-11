import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App.jsx';

// Mocked Apollo-shaped payloads. No real candidate personal data is used.
const searchResult = (people) => ({ candidates: people, page: 1, perPage: 25, total: people.length });

const bareCandidate = (id, name) => ({
  id, requestedId: null, name, title: 'Java Developer', headline: null, company: 'Example Co',
  location: 'Hyderabad', seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, phone: null, emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: false
});

const enrichedCandidate = (id, name, overrides = {}) => ({
  ...bareCandidate(id, name),
  requestedId: id,
  headline: 'Senior Java Developer | Java | Spring Boot',
  seniority: 'senior',
  departments: ['engineering'],
  skills: ['Java', 'Spring Boot', 'SQL', 'AWS'],
  linkedinUrl: 'https://www.linkedin.com/in/example',
  emailAvailable: true,
  phoneAvailable: true,
  employmentHistory: [
    { organization: 'ABC Technologies', title: 'Senior Java Developer', startDate: '2021-01-01', endDate: null, current: true },
    { organization: 'XYZ Technologies', title: 'Java Developer', startDate: '2018-01-01', endDate: '2020-12-01', current: false }
  ],
  enriched: true,
  ...overrides
});

let calls;

// Routes the app's own fetch calls. Any request to a host other than our
// backend fails the test outright, which is how "LinkedIn is never fetched"
// is enforced rather than assumed.
function mockBackend({
  search = () => searchResult([]),
  enrich = () => ({ requestedIds: [], candidates: [], failedIds: [], skippedIds: [] }),
  reveal = null,
  waterfall = null,
  poll = null,
  lookup = null,
  phone = null
} = {}) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const target = String(url);
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: target, body });
    if (target === '/api/candidates/search') {
      const result = search(body);
      // A handler may return a ready-made response to simulate the proxy.
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    if (target === '/api/candidates/enrich') {
      const result = enrich(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      return jsonResponse(result);
    }
    if (target === '/api/candidates/waterfall') {
      if (!waterfall) throw new Error('The application started a waterfall without a handler');
      return jsonResponse(await waterfall(body));
    }
    if (target.startsWith('/api/candidates/waterfall/')) {
      if (!poll) throw new Error('The application polled a waterfall without a handler');
      return jsonResponse(await poll(target.split('/').pop()));
    }
    if (target === '/api/candidates/phone') {
      if (!phone) throw new Error('The application revealed a phone number without a phone handler');
      const result = await phone(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 503);
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    if (target === '/api/candidates/lookup') {
      if (!lookup) throw new Error('The application looked a person up without a lookup handler');
      const result = await lookup(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      // A handler may return a ready-made response to simulate the proxy.
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    if (target === '/api/candidates/reveal') {
      if (!reveal) throw new Error('The application revealed contact details without a reveal handler');
      const result = await reveal(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      // A handler may return a ready-made response to simulate the proxy.
      return result && typeof result.text === 'function' ? result : jsonResponse(result);
    }
    throw new Error(`The application must not request ${target}`);
  });
}

function jsonResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  // clone() so the app can peek at a body and still read it afterwards.
  return { ok: status < 400, status, text: async () => text, json: async () => payload, clone: () => jsonResponse(payload, status) };
}

// What the Vite dev proxy answers when nothing is listening on the API port,
// which is what a `node --watch` restart looks like to the browser.
function proxyUnreachable() {
  return jsonResponse({ error: 'The candidate API is not running. Start it with `npm run dev:server`.', code: 'API_UNREACHABLE' }, 503);
}

// What Vite's proxy returns when it cannot reach our backend: status 500 with
// a zero-length body.
function unreachableBackend() {
  return { ok: false, status: 500, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
}

async function searchWith(people, enrich, reveal, waterfall, poll) {
  mockBackend({ search: () => searchResult(people), enrich, reveal, waterfall, poll });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  for (const person of people) await screen.findByText(person.name);
}

function rowFor(name) {
  return screen.getByText(name).closest('.candidate-block');
}

// Role, skills and location are required, so every search scenario sets them.
function fillRequired({ jobTitle = 'java developer', location = 'delhi', keywords = 'java' } = {}) {
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: jobTitle } });
  fireEvent.change(screen.getByLabelText(/^location/i), { target: { value: location } });
  fireEvent.change(screen.getByLabelText(/skills \/ keywords/i), { target: { value: keywords } });
}

function selectionCount() {
  return document.querySelector('.selection-actions > span').textContent;
}

// The expand toggle and the panel share a name, so target the panel by role.
function detailsPanel(name) {
  return screen.findByRole('region', { name: new RegExp(`enriched details for ${name}`, 'i') });
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.restoreAllMocks(); });

test('search renders candidates returned by our backend', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  expect(calls[0].url).toBe('/api/candidates/search');
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.getByText('Other Candidate')).toBeTruthy();
  expect(within(rowFor('Test Candidate')).getByText('Not enriched')).toBeTruthy();
});

test('an individual candidate can be selected and deselected', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  const checkbox = screen.getByRole('checkbox', { name: /select test candidate/i });
  fireEvent.click(checkbox);
  expect(selectionCount()).toBe('Selected: 1');
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(false);
});

test('Select all and Clear act on every candidate', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  // Only the per-candidate checkboxes; the results toolbar has its own filter
  // checkbox, which Select all must leave alone.
  const rowBoxes = () => screen.getAllByRole('checkbox', { name: /^select /i });
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  for (const checkbox of rowBoxes()) expect(checkbox.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
  for (const checkbox of rowBoxes()) expect(checkbox.checked).toBe(false);
});

test('Enrich selected sends only the selected Apollo person IDs', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: body.ids.map((id) => enrichedCandidate(id, 'Test Candidate')), failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/enrich')).toBe(true));
  const enrichCall = calls.find((call) => call.url === '/api/candidates/enrich');
  expect(enrichCall.body.ids).toEqual(['person-1']);
});

test('enriched Apollo details render inside our UI, not on LinkedIn', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  await screen.findByText(/enrichment complete/i);
  const row = rowFor('Test Candidate');
  expect(within(row).getByText('Yes')).toBeTruthy();

  // Enrichment auto-opens the panel: the recruiter already asked for this data.
  const details = await detailsPanel('test candidate');
  expect(within(row).getByRole('button', { name: /hide enriched details/i })).toBeTruthy();
  expect(within(details).getByText('Senior Java Developer | Java | Spring Boot')).toBeTruthy();
  expect(within(details).getByText('senior')).toBeTruthy();
  expect(within(details).getByText('engineering')).toBeTruthy();
  for (const skill of ['Java', 'Spring Boot', 'SQL', 'AWS']) {
    expect(within(details).getByText(skill)).toBeTruthy();
  }
  expect(within(details).getByText('ABC Technologies')).toBeTruthy();
  expect(within(details).getByText('XYZ Technologies')).toBeTruthy();
  // The details panel shows the URL itself, still as a plain manual link.
  const linkedin = within(details).getByRole('link', { name: 'https://www.linkedin.com/in/example' });
  expect(linkedin.textContent).toBe('https://www.linkedin.com/in/example');
  expect(linkedin.getAttribute('href')).toBe('https://www.linkedin.com/in/example');
  expect(linkedin.getAttribute('target')).toBe('_blank');
  expect(linkedin.getAttribute('rel')).toBe('noreferrer');

  // The link is present for manual use, but the app itself only ever talked
  // to our own backend.
  expect(calls.every((call) => call.url.startsWith('/api/'))).toBe(true);
});

test('the LinkedIn link is a plain manual external link', async () => {
  await searchWith([{ ...bareCandidate('person-1', 'Test Candidate'), linkedinUrl: 'https://www.linkedin.com/in/example' }]);
  const link = screen.getByRole('link', { name: /view linkedin profile/i });
  expect(link.getAttribute('href')).toBe('https://www.linkedin.com/in/example');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noreferrer');
  expect(calls.every((call) => call.url.startsWith('/api/'))).toBe(true);
});

test('missing Apollo fields display Not available', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Sparse Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [{ ...bareCandidate('person-1', 'Sparse Candidate'), requestedId: 'person-1', enriched: true }], failedIds: [], skippedIds: [] })
  );
  const row = rowFor('Sparse Candidate');
  // Missing LinkedIn, email and phone before enrichment.
  expect(within(row).getAllByText('Not available').length).toBeGreaterThanOrEqual(3);

  fireEvent.click(screen.getByRole('checkbox', { name: /select sparse candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);
  const details = await detailsPanel('sparse candidate');
  const labelled = (label) => within(details).getByText(label).parentElement;
  for (const label of ['Professional headline', 'Seniority', 'Department', 'Skills', 'Current employment', 'Previous employment', 'Work email', 'Phone', 'LinkedIn']) {
    expect(within(labelled(label)).getByText('Not available'), `${label} shows Not available`).toBeTruthy();
  }
});

test('partial enrichment updates the matches and marks the failure retryable', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Matched Candidate'), bareCandidate('person-2', 'Unmatched Candidate')],
    (body) => ({
      requestedIds: body.ids,
      candidates: body.ids.filter((id) => id === 'person-1').map((id) => enrichedCandidate(id, 'Matched Candidate')),
      failedIds: body.ids.filter((id) => id !== 'person-1'),
      skippedIds: []
    })
  );
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  await screen.findByText(/unable to enrich this candidate/i);
  expect(within(rowFor('Matched Candidate')).getByText('Yes')).toBeTruthy();
  const failedRow = rowFor('Unmatched Candidate');
  expect(within(failedRow).getByText('Enrichment failed')).toBeTruthy();
  // The candidate stays in the results and can be retried.
  expect(within(failedRow).getByRole('button', { name: /retry/i })).toBeTruthy();

  const before = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(within(failedRow).getByRole('button', { name: /retry/i }));
  await waitFor(() => expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(before + 1));
  expect(calls.at(-1).body.ids).toEqual(['person-2']);
});

test('an already enriched candidate is not sent to Apollo again', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);

  const afterFirst = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/already enriched/i);
  expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(afterFirst);
});

test('an explicit refresh does re-request an enriched candidate', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/enrichment complete/i);
  await detailsPanel('test candidate');

  const before = calls.filter((call) => call.url === '/api/candidates/enrich').length;
  fireEvent.click(screen.getByRole('button', { name: /refresh from apollo/i }));
  await waitFor(() => expect(calls.filter((call) => call.url === '/api/candidates/enrich').length).toBe(before + 1));
  expect(calls.at(-1).body.ids).toEqual(['person-1']);
});

test('the enrich button is disabled and labelled while enrichment runs', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mockBackend({
    search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]),
    enrich: () => ({ requestedIds: ['person-1'], candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, options) => {
    if (String(url) === '/api/candidates/enrich') await gate;
    return realFetch(url, options);
  });

  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Test Candidate');
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));

  const button = await screen.findByRole('button', { name: /enriching selected candidates/i });
  expect(button.disabled).toBe(true);
  expect(within(rowFor('Test Candidate')).getByText('Enriching...')).toBeTruthy();

  release();
  await screen.findByText(/enrichment complete/i);
  expect(screen.getByRole('button', { name: /enrich selected/i }).disabled).toBe(false);
});

test('an Apollo rate limit is surfaced and leaves the candidate retryable', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => new Error('Apollo API rate limit reached. Please try again later.')
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await screen.findByText(/rate limit reached/i);
  const row = rowFor('Test Candidate');
  expect(within(row).getByText('Enrichment failed')).toBeTruthy();
  expect(within(row).getByRole('button', { name: /retry/i })).toBeTruthy();
});

test('a result with no Apollo person ID cannot be selected for enrichment', async () => {
  await searchWith([{ ...bareCandidate(null, 'Anonymous Result'), id: null }]);
  const checkbox = screen.getByRole('checkbox', { name: /cannot select/i });
  expect(checkbox.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  expect(checkbox.checked).toBe(false);
});

test('an unreachable backend reads as a retry message, not a JSON parse error', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return unreachableBackend();
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));

  const notice = await screen.findByText(/not reachable right now/i);
  expect(notice).toBeTruthy();
  expect(notice.textContent).not.toMatch(/JSON/i);
  // The button recovers so the recruiter can retry once the backend is back.
  expect(screen.getByRole('button', { name: /search candidates/i }).disabled).toBe(false);
});

test('a JSON error body from our backend is shown verbatim', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return jsonResponse({ error: 'Apollo API rate limit reached. Please try again later.' }, 429);
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  expect(await screen.findByText('Apollo API rate limit reached. Please try again later.')).toBeTruthy();
});

test('an empty 200 body reads as an empty response, not a parse error', async () => {
  globalThis.fetch = vi.fn(async (url) => {
    calls.push({ url: String(url), body: null });
    return { ok: true, status: 200, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  const notice = await screen.findByText(/empty response/i);
  expect(notice.textContent).not.toMatch(/JSON/i);
});

test('the details panel can be collapsed again after enrichment', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    (body) => ({ requestedIds: body.ids, candidates: [enrichedCandidate('person-1', 'Test Candidate')], failedIds: [], skippedIds: [] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /enrich selected/i }));
  await detailsPanel('test candidate');

  fireEvent.click(screen.getByRole('button', { name: /hide enriched details/i }));
  expect(screen.queryByRole('region', { name: /enriched details for test candidate/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /show enriched details/i }));
  expect(await detailsPanel('test candidate')).toBeTruthy();
});

test('pressing Enter in a filter field runs the search', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  fillRequired();
  fireEvent.submit(screen.getByLabelText(/role \/ job title/i).closest('form'));
  await screen.findByText('Test Candidate');
  expect(calls[0].url).toBe('/api/candidates/search');
  expect(calls[0].body.jobTitle).toBe('java developer');
  expect(calls[0].body.location).toBe('delhi');
  expect(calls[0].body.keywords).toBe('java');
});

test('Reset filters clears every field without searching', async () => {
  mockBackend({});
  render(<App />);
  const jobTitle = screen.getByLabelText(/role \/ job title/i);
  const location = screen.getByLabelText(/^location/i);
  fireEvent.change(jobTitle, { target: { value: 'java developer' } });
  fireEvent.change(location, { target: { value: 'delhi' } });
  expect(jobTitle.value).toBe('java developer');

  fireEvent.click(screen.getByRole('button', { name: /reset filters/i }));
  expect(jobTitle.value).toBe('');
  expect(location.value).toBe('');
  expect(calls.length).toBe(0);
});

test('pagination shows the page count and stops at the last page', async () => {
  mockBackend({ search: () => ({ candidates: [bareCandidate('person-1', 'Test Candidate')], page: 1, perPage: 25, total: 1383 }) });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Test Candidate');
  // 1383 results at 25 per page is 56 pages.
  expect(screen.getByText(/of 56/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /previous/i }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /next/i }).disabled).toBe(false);
});

test('the results header reports this page against the Apollo total', async () => {
  const people = Array.from({ length: 25 }, (_, index) => bareCandidate(`person-${index}`, `Candidate ${index}`));
  mockBackend({ search: () => ({ candidates: people, page: 1, perPage: 25, total: 1383 }) });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Candidate 0');
  // One count, in one place, right above the rows it describes.
  expect(screen.getByText('Showing 25 of 1,383 profiles')).toBeTruthy();
  expect(screen.queryByText(/source with intent/i)).toBeNull();
  expect(screen.queryByText(/behind the potential/i)).toBeNull();
});

test('the candidate checkbox stays reachable by keyboard', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  const checkbox = screen.getByRole('checkbox', { name: /select test candidate/i });
  // Never display:none, which would drop it from the tab order entirely.
  expect(getComputedStyle(checkbox).display).not.toBe('none');
  checkbox.focus();
  expect(document.activeElement).toBe(checkbox);
});

test('the header and each row have the same number of grid cells', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  const headCells = document.querySelectorAll('.table-head > span').length;
  const rowCells = document.querySelectorAll('.candidate-row > *').length;
  // A mismatch here means the CSS grid columns no longer line up with the
  // header labels, which silently shifts every value under the wrong heading.
  expect(headCells).toBe(6);
  expect(rowCells).toBe(headCells);
});

test('searching is blocked until role, skills and location are all present', async () => {
  mockBackend({});
  render(<App />);
  const button = screen.getByRole('button', { name: /search candidates/i });
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/still needed: role \/ job title, location, skills \/ keywords\./i)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'java developer' } });
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/^location/i), { target: { value: 'delhi' } });
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/still needed: skills \/ keywords\./i)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/skills \/ keywords/i), { target: { value: 'java' } });
  expect(button.disabled).toBe(false);
  expect(screen.queryByText(/still needed/i)).toBeNull();
  expect(calls.length).toBe(0);
});

test('the optional filters alone are not enough to search', async () => {
  mockBackend({});
  render(<App />);
  fireEvent.change(screen.getByLabelText(/^company/i), { target: { value: 'Example Co' } });
  fireEvent.change(screen.getByLabelText(/^industry/i), { target: { value: 'Software' } });
  fireEvent.change(screen.getByLabelText(/seniority/i), { target: { value: 'senior' } });
  expect(screen.getByRole('button', { name: /search candidates/i }).disabled).toBe(true);
  expect(calls.length).toBe(0);
});

test('whitespace does not satisfy a required filter', async () => {
  mockBackend({});
  render(<App />);
  fillRequired({ keywords: '   ' });
  expect(screen.getByRole('button', { name: /search candidates/i }).disabled).toBe(true);
  expect(screen.getByText(/still needed: skills \/ keywords\./i)).toBeTruthy();
  expect(calls.length).toBe(0);
});

test('the required fields are marked required for assistive tech', async () => {
  mockBackend({});
  render(<App />);
  for (const pattern of [/role \/ job title/i, /^location/i, /skills \/ keywords/i]) {
    expect(screen.getByLabelText(pattern).required, String(pattern)).toBe(true);
  }
  for (const pattern of [/^company/i, /^industry/i]) {
    expect(screen.getByLabelText(pattern).required, String(pattern)).toBe(false);
  }
});

test('submitting an incomplete form names what is missing and calls nothing', async () => {
  mockBackend({});
  render(<App />);
  fireEvent.change(screen.getByLabelText(/role \/ job title/i), { target: { value: 'java developer' } });
  fireEvent.submit(screen.getByLabelText(/role \/ job title/i).closest('form'));
  // The inline hint also lists what is missing, so target the submit notice.
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toMatch(/role \/ job title, skills \/ keywords and location are required/i);
  expect(notice.textContent).toMatch(/still needed: location, skills \/ keywords\./i);
  expect(calls.length).toBe(0);
});
// --- Explicit personal email reveal -----------------------------------------

const revealResponse = (candidates) => ({
  requestedIds: candidates.map((candidate) => candidate.requestedId),
  candidates,
  failedIds: [],
  skippedIds: [],
  revealedPersonalEmails: true
});

function revealButton() {
  return screen.getByRole('button', { name: /^reveal email/i });
}

// The spend confirmation that stands between a click and Apollo being called.
function confirmSpendButton() {
  return screen.getByRole('button', { name: /^spend up to/i });
}

// What a recruiter actually does: ask to reveal, then approve the cost.
function revealAndConfirm(button) {
  fireEvent.click(button || revealButton());
  fireEvent.click(confirmSpendButton());
}

test('a search never reveals contact details on its own', async () => {
  await searchWith([bareCandidate('person-1', 'Test Candidate')]);
  expect(calls.map((call) => call.url)).toEqual(['/api/candidates/search']);
  expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(false);
});

test('reveal sends only the explicitly selected candidates', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(true));
  const call = calls.find((entry) => entry.url === '/api/candidates/reveal');
  expect(call.body.ids).toEqual(['person-1']);
  expect(call.body.ids).not.toContain('person-2');
});

test('a running reveal shows a loading state and blocks a second request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    async () => {
      await pending;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com' })]);
    }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  // The toolbar button and the row badge both report the reveal, so each is
  // asserted where it lives rather than by a page-wide text match.
  await waitFor(() => expect(within(rowFor('Test Candidate')).getByText('Revealing contact details...')).toBeTruthy());
  expect(screen.getByRole('button', { name: /^revealing email/i }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: /^enrich selected/i }).disabled).toBe(true);

  release();
  await waitFor(() => expect(within(rowFor('Test Candidate')).queryByText('Revealing contact details...')).toBeNull());
  expect(within(rowFor('Test Candidate')).getByText('Yes')).toBeTruthy();
});

test('a partial reveal shows the address it got and Not available for the rest', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    undefined,
    () => revealResponse([
      enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example.com', emailAvailable: true }),
      enrichedCandidate('person-2', 'Other Candidate', { email: null, emailAvailable: false })
    ])
  );
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  revealAndConfirm();

  const found = await detailsPanel('Test Candidate');
  expect(within(found).getByText('one@example.com')).toBeTruthy();
  expect(within(found).getByRole('link', { name: 'one@example.com' }).getAttribute('href')).toBe('mailto:one@example.com');

  const missing = await detailsPanel('Other Candidate');
  const missingEmail = within(missing).getByText('Work email').parentElement;
  expect(within(missingEmail).getByText('Not available')).toBeTruthy();
  expect(missing.textContent).not.toContain('@example.com');
});

test('a failed reveal keeps the candidate enriched instead of erasing the row', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => ({
      requestedIds: ['person-1'],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', { email: null, emailAvailable: false })],
      failedIds: [],
      skippedIds: []
    }),
    () => new Error('Apollo API rate limit reached. Please try again later.')
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^enrich selected/i }));
  await detailsPanel('Test Candidate');

  revealAndConfirm(within(rowFor('Test Candidate')).getByRole('button', { name: /^reveal email/i }));
  await screen.findByText(/rate limit/i);

  // The reveal failed, so the row keeps the enrichment it already had.
  expect(within(rowFor('Test Candidate')).getByText('Yes')).toBeTruthy();
  await detailsPanel('Test Candidate');
});

test('a second reveal does not pay for an address already on screen', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  const revealCalls = () => calls.filter((call) => call.url === '/api/candidates/reveal').length;
  expect(revealCalls()).toBe(1);

  // Same candidate still selected: a second click is refused before it can
  // even ask for confirmation, so no spend is ever offered.
  fireEvent.click(revealButton());
  await screen.findByText(/already has a revealed email/i);
  expect(screen.queryByRole('button', { name: /^spend up to/i })).toBeNull();
  expect(revealCalls()).toBe(1);
});

test('double-clicking reveal sends a single request', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    async () => {
      await pending;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })]);
    }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));

  fireEvent.click(revealButton());
  // Hammer the confirmation: only the first click may reach Apollo.
  const spend = confirmSpendButton();
  fireEvent.click(spend);
  fireEvent.click(spend);
  fireEvent.click(spend);

  await waitFor(() => expect(within(rowFor('Test Candidate')).getByText('Revealing contact details...')).toBeTruthy());
  // While in flight the toolbar button reports the reveal and is disabled.
  expect(screen.getByRole('button', { name: /^revealing email/i }).disabled).toBe(true);
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);

  release();
  await waitFor(() => expect(within(rowFor('Test Candidate')).queryByText('Revealing contact details...')).toBeNull());
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);
});

test('a personal address is labelled as personal, not as a work address', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'someone@gmail.com', emailType: 'personal' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  expect(within(panel).queryByText('Work email')).toBeNull();
});

test('the frontend never receives or stores an Apollo key', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  // The browser talks to our backend only, and sends no credentials of its own.
  for (const call of calls) {
    expect(call.url.startsWith('/api/')).toBe(true);
    expect(JSON.stringify(call.body ?? {})).not.toMatch(/api[-_]?key/i);
  }
  expect(document.body.innerHTML).not.toMatch(/x-api-key/i);
});

test('shows the work address and the personal one when Apollo returns both', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'first.last@example-co.com',
      emailType: 'work',
      personalEmail: 'first.last.personal@gmail.com'
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Work email')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'first.last@example-co.com' })).toBeTruthy();
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  const personal = within(panel).getByRole('link', { name: 'first.last.personal@gmail.com' });
  expect(personal.getAttribute('href')).toBe('mailto:first.last.personal@gmail.com');
});

test('no personal row appears when Apollo returned only a work address', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'first.last@example-co.com', emailType: 'work', personalEmail: null
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Work email')).toBeTruthy();
  expect(within(panel).queryByText('Personal email')).toBeNull();
});

test('nothing reaches Apollo until the spend is confirmed', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  fireEvent.click(revealButton());

  // The click only asks. No request has gone out.
  expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(false);
  expect(screen.getByText(/this spends apollo credits/i)).toBeTruthy();
  expect(screen.getByText(/costs up to 2 credits/i)).toBeTruthy();
  expect(confirmSpendButton().textContent).toMatch(/spend up to 2 credits/i);

  fireEvent.click(confirmSpendButton());
  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(true));
});

test('cancelling the confirmation spends nothing', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', { email: 'one@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(revealButton());

  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
  await screen.findByText(/no apollo credits were spent/i);
  expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(false);

  // The candidate is untouched and can still be revealed later.
  expect(within(rowFor('Test Candidate')).getByText('Not enriched')).toBeTruthy();
});

test('a selection over the cap says how many will actually be charged', async () => {
  const people = Array.from({ length: 14 }, (_, index) => bareCandidate(`person-${index}`, `Candidate ${index}`));
  await searchWith(people, undefined, () => revealResponse([]));
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  fireEvent.click(revealButton());

  // 14 selected, but a reveal is capped at 10 to protect the account.
  expect(screen.getByText(/apollo will be asked for the first 10, costing up to 10 credits/i)).toBeTruthy();
  expect(screen.getByText(/remaining 4 are left for a second batch/i)).toBeTruthy();
  expect(confirmSpendButton().textContent).toMatch(/spend up to 10 credits/i);
});

// --- Personal email filter --------------------------------------------------

function personalFilter() {
  return screen.getByRole('checkbox', { name: /^personal email only/i });
}

// Has Personal: revealed, Apollo gave a personal address.
// Work Only:    revealed, Apollo gave none - a known negative.
// Never Revealed: never asked, so unknown.
async function revealTwo() {
  await searchWith(
    [bareCandidate('person-1', 'Has Personal'), bareCandidate('person-2', 'Work Only'), bareCandidate('person-3', 'Never Revealed')],
    undefined,
    () => revealResponse([
      enrichedCandidate('person-1', 'Has Personal', {
        email: 'has.personal@example-co.com', emailType: 'work', personalEmail: 'has.personal@gmail.com'
      }),
      enrichedCandidate('person-2', 'Work Only', {
        email: 'work.only@example-co.com', emailType: 'work', personalEmail: null
      })
    ])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select has personal/i }));
  fireEvent.click(screen.getByRole('checkbox', { name: /select work only/i }));
  revealAndConfirm();
  await detailsPanel('Has Personal');
}

test('the filter hides only candidates Apollo confirmed have no personal email', async () => {
  await revealTwo();
  expect(personalFilter().checked).toBe(false);
  expect(personalFilter().parentElement.textContent).toMatch(/personal email only \(1\)/i);

  fireEvent.click(personalFilter());

  expect(screen.getByText('Has Personal')).toBeTruthy();
  expect(screen.queryByText('Work Only')).toBeNull();
  // Never revealed is unknown, not a negative, so it stays selectable.
  expect(screen.getByText('Never Revealed')).toBeTruthy();
});

test('the filter never empties the table before anything has been revealed', async () => {
  // The trap this guards against: hiding every unrevealed candidate leaves
  // nobody to select, and nobody can gain a personal email without a reveal.
  await searchWith([bareCandidate('person-1', 'Test Candidate'), bareCandidate('person-2', 'Other Candidate')]);
  fireEvent.click(personalFilter());

  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.getByText('Other Candidate')).toBeTruthy();
  expect(screen.getByText(/2 not checked yet/i)).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /select test candidate/i })).toBeTruthy();
});

test('the filter counts the three states separately', async () => {
  await revealTwo();
  fireEvent.click(personalFilter());

  expect(screen.getByText(/1 candidate has a personal email/i)).toBeTruthy();
  expect(screen.getByText(/1 hidden - apollo returned no personal address/i)).toBeTruthy();
  expect(screen.getByText(/1 not checked yet/i)).toBeTruthy();
});

test('Select all with the filter on never reaches a hidden candidate', async () => {
  await revealTwo();
  fireEvent.click(personalFilter());
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));

  // The two visible rows only. Work Only is hidden, so it cannot be selected
  // and cannot have credits spent on it.
  expect(selectionCount()).toBe('Selected: 2');

  // Has Personal is already paid for, so only the unrevealed one is charged.
  fireEvent.click(revealButton());
  expect(screen.getByText(/costs up to 1 credit/i)).toBeTruthy();
});

test('turning the filter off brings the hidden candidate back', async () => {
  await revealTwo();
  fireEvent.click(personalFilter());
  expect(screen.queryByText('Work Only')).toBeNull();

  fireEvent.click(personalFilter());
  expect(screen.getByText('Has Personal')).toBeTruthy();
  expect(screen.getByText('Work Only')).toBeTruthy();
  expect(screen.getByText('Never Revealed')).toBeTruthy();
});

test('the filter explains an empty table rather than showing a blank one', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Work Only')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Work Only', {
      email: 'work.only@example-co.com', emailType: 'work', personalEmail: null
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select work only/i }));
  revealAndConfirm();
  await detailsPanel('Work Only');

  fireEvent.click(personalFilter());
  // Everything revealed, none with a personal address: the table is genuinely
  // empty and says why.
  expect(screen.getByText(/0 candidates have a personal email/i)).toBeTruthy();
  expect(screen.getByText(/1 hidden - apollo returned no personal address/i)).toBeTruthy();
  expect(screen.queryByText('Work Only')).toBeNull();
});

// --- Dev-server restart resilience ------------------------------------------

test('a search retries once when the dev server was restarting', async () => {
  let attempts = 0;
  mockBackend({
    search: () => {
      attempts += 1;
      return attempts === 1 ? proxyUnreachable() : searchResult([bareCandidate('person-1', 'Test Candidate')]);
    }
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));

  await screen.findByText('Test Candidate');
  expect(attempts).toBe(2);
  // The recruiter never sees the restart at all.
  expect(screen.queryByText(/candidate api is not running/i)).toBeNull();
});

test('a search that is still unreachable reports it rather than looping', async () => {
  let attempts = 0;
  mockBackend({ search: () => { attempts += 1; return proxyUnreachable(); } });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));

  // Three retries on a backoff, then it gives up and says so.
  await screen.findByText(/candidate api is not running/i, {}, { timeout: 8000 });
  expect(attempts).toBe(4, 'a bounded number of retries, not an endless loop');
});

test('a reveal never retries a dropped connection', async () => {
  let attempts = 0;
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => { attempts += 1; return proxyUnreachable(); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();

  await screen.findByText(/candidate api is not running/i);
  // A reset connection does not prove Apollo went unasked, so retrying could
  // pay for the same candidate twice.
  expect(attempts).toBe(1);
  expect(calls.filter((call) => call.url === '/api/candidates/reveal').length).toBe(1);
});

test('enriching a candidate does not count as checking for a personal email', async () => {
  // The bug this locks out: plain enrichment sends reveal_personal_emails:false,
  // so a blank personal field on an enriched candidate means "never asked", not
  // "Apollo has none". Treating it as the latter hid candidates and claimed
  // Apollo had answered about people it was never asked about.
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => ({
      requestedIds: ['person-1'],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', {
        email: 'work@example-co.com', emailType: 'work', personalEmail: null
      })],
      failedIds: [],
      skippedIds: []
      // Note: no revealedPersonalEmails flag - this is the enrich route.
    })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^enrich selected/i }));
  await detailsPanel('Test Candidate');

  fireEvent.click(personalFilter());
  // Still listed, still selectable, and counted as unchecked rather than hidden.
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.getByText(/1 not checked yet/i)).toBeTruthy();
  expect(screen.queryByText(/hidden - apollo returned no personal address/i)).toBeNull();
});

test('a reveal does count as checking, and hides a candidate with none', async () => {
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'work@example-co.com', emailType: 'work', personalEmail: null
    })])
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  fireEvent.click(personalFilter());
  // Apollo was asked and said no, so this one is genuinely ruled out.
  expect(screen.queryByText('Test Candidate')).toBeNull();
  expect(screen.getByText(/1 hidden - apollo returned no personal address/i)).toBeTruthy();
  expect(screen.queryByText(/not checked yet/i)).toBeNull();
});

test('an enriched candidate can still be revealed for a personal address', async () => {
  // The trap this locks out: enriching first gives a work email, and a dedupe
  // keyed on "has an email" would then refuse the reveal forever - making a
  // personal address unreachable for anyone enriched first.
  let revealCalls = 0;
  await searchWith(
    [bareCandidate('person-1', 'Test Candidate')],
    () => ({
      requestedIds: ['person-1'],
      candidates: [enrichedCandidate('person-1', 'Test Candidate', {
        email: 'work@example-co.com', emailType: 'work', personalEmail: null
      })],
      failedIds: [],
      skippedIds: []
    }),
    () => {
      revealCalls += 1;
      return revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
        email: 'work@example-co.com', emailType: 'work', personalEmail: 'test.candidate@gmail.com'
      })]);
    }
  );

  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(screen.getByRole('button', { name: /^enrich selected/i }));
  await detailsPanel('Test Candidate');

  // Now reveal the same candidate: it must reach Apollo, not be skipped.
  revealAndConfirm();
  await waitFor(() => expect(revealCalls).toBe(1));

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByText('Personal email')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'test.candidate@gmail.com' })).toBeTruthy();

  // A second reveal is refused, because now it really has been asked.
  fireEvent.click(revealButton());
  await screen.findByText(/already has a revealed email/i);
  expect(revealCalls).toBe(1);
});

// --- Not paying for candidates Apollo already ruled out ----------------------

test('search asks for the reachable pool by default, and can be widened', async () => {
  mockBackend({ search: () => searchResult([bareCandidate('person-1', 'Test Candidate')]) });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Test Candidate');
  expect(calls[0].body.verifiedEmailOnly).toBe(true);

  fireEvent.click(screen.getByRole('checkbox', { name: /only candidates apollo has an email for/i }));
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls[1].body.verifiedEmailOnly).toBe(false);
});

test('a candidate Apollo has no address for is never charged for', async () => {
  let revealCalls = 0;
  await searchWith(
    [{ ...bareCandidate('person-1', 'No Address'), hasEmailOnFile: false }],
    undefined,
    () => { revealCalls += 1; return revealResponse([]); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select no address/i }));
  fireEvent.click(revealButton());

  // Apollo said so in the free search response, so no confirmation is even
  // offered and nothing is sent.
  await screen.findByText(/apollo holds no email address for that candidate/i);
  expect(screen.queryByRole('button', { name: /^spend up to/i })).toBeNull();
  expect(revealCalls).toBe(0);
});

test('a mixed selection charges only for the candidates worth asking about', async () => {
  await searchWith(
    [
      { ...bareCandidate('person-1', 'Has Address'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'No Address'), hasEmailOnFile: false }
    ],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Has Address', { email: 'has@example-co.com', emailType: 'work' })])
  );
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  fireEvent.click(revealButton());

  // Two selected, one charged.
  expect(screen.getByText(/1 selected candidate has no email on file/i)).toBeTruthy();
  expect(screen.getByText(/costs up to 1 credit/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^spend up to/i }));
  await waitFor(() => expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(true));
  expect(calls.find((call) => call.url === '/api/candidates/reveal').body.ids).toEqual(['person-1']);
});

// --- Waterfall: searching other data sources --------------------------------

function findButton() {
  return screen.getByRole('button', { name: /^find personal emails/i });
}

test('a waterfall confirms the spend, then polls until the address arrives', async () => {
  let polls = 0;
  await searchWith(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    undefined,
    undefined,
    () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '-123', ids: ['person-1'] }],
      // The synchronous half carries what Apollo already had.
      candidates: [enrichedCandidate('person-1', 'Test Candidate', { email: 'work@example-co.com', emailType: 'work', personalEmail: null })],
      failedIds: [],
      skippedIds: []
    }),
    () => {
      polls += 1;
      // Still running the first time, finished the second.
      return polls === 1
        ? { status: 'pending', retryAfterSeconds: 0.001, candidates: [] }
        : {
          status: 'ready',
          candidates: [enrichedCandidate('person-1', 'Test Candidate', {
            email: 'work@example-co.com', emailType: 'work', personalEmail: 'found@gmail.com'
          })]
        };
    }
  );

  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(findButton());

  // Nothing is sent until the cost is accepted.
  expect(screen.getByText(/searches other data sources and spends apollo credits/i)).toBeTruthy();
  expect(calls.some((call) => call.url === '/api/candidates/waterfall')).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /^search other sources for 1 candidate/i }));

  // The poll interval is clamped to a second minimum so a bad retry hint cannot
  // make the client hammer Apollo, so this genuinely waits about that long.
  await screen.findByText(/found 1 personal email in other data sources/i, {}, { timeout: 4000 });
  expect(polls).toBe(2, 'it waited through the pending answer');

  const panel = await detailsPanel('Test Candidate');
  expect(within(panel).getByRole('link', { name: 'found@gmail.com' })).toBeTruthy();
});

test('a waterfall that finds nothing says so plainly', async () => {
  await searchWith(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    undefined,
    undefined,
    () => ({ requestedIds: ['person-1'], requests: [{ requestId: '-123', ids: ['person-1'] }], candidates: [], failedIds: [], skippedIds: [] }),
    () => ({ status: 'ready', candidates: [enrichedCandidate('person-1', 'Test Candidate', { email: 'work@example-co.com', emailType: 'work', personalEmail: null })] })
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(findButton());
  fireEvent.click(screen.getByRole('button', { name: /^search other sources/i }));

  // A completed search that found nothing is reported as a result, not as a
  // failure, and names no vendor because this answer carried none.
  await screen.findByText(/^no personal email found\.$/i);
});

test('an expired waterfall stops polling instead of looping', async () => {
  let polls = 0;
  await searchWith(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    undefined,
    undefined,
    () => ({ requestedIds: ['person-1'], requests: [{ requestId: '-123', ids: ['person-1'] }], candidates: [], failedIds: [], skippedIds: [] }),
    () => { polls += 1; return { status: 'expired', candidates: [] }; }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(findButton());
  fireEvent.click(screen.getByRole('button', { name: /^search other sources/i }));

  // An expired job is reported as unknown, not as "found nothing" - that
  // distinction is what hid a broken request id behind a plausible result.
  await screen.findByText(/could not return the result for this search/i);
  expect(screen.queryByText(/returned no personal email/i)).toBeNull();
  expect(polls).toBe(1, 'a terminal answer is not retried');
});

test('cancelling a waterfall sends nothing', async () => {
  await searchWith(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    undefined, undefined,
    () => { throw new Error('the waterfall must not start'); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  fireEvent.click(findButton());
  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

  await screen.findByText(/no apollo credits were spent/i);
  expect(calls.some((call) => call.url === '/api/candidates/waterfall')).toBe(false);
});

test('a candidate who already has a personal email is not searched for again', async () => {
  await searchWith(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    undefined,
    () => revealResponse([enrichedCandidate('person-1', 'Test Candidate', {
      email: 'work@example-co.com', emailType: 'work', personalEmail: 'already@gmail.com'
    })]),
    () => { throw new Error('the waterfall must not start'); }
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /select test candidate/i }));
  revealAndConfirm();
  await detailsPanel('Test Candidate');

  fireEvent.click(findButton());
  await screen.findByText(/already has a personal email/i);
  expect(calls.some((call) => call.url === '/api/candidates/waterfall')).toBe(false);
});

// --- The waterfall answer shape, end to end through the UI -------------------
//
// Apollo answers a waterfall with the person id and whatever the vendors
// found, and nothing else. These drive the app with that real shape, mocked.

// The sparse record the backend normalizes a waterfall answer into.
const waterfallAnswer = (id, overrides = {}) => ({
  id, requestedId: id, name: null, title: null, headline: null, company: null,
  location: null, seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, emailType: null, personalEmail: null, hasEmailOnFile: null, phone: null,
  emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: true,
  vendors: [{ name: 'Apollo', status: 'NOT_FOUND', statusCode: 'no_apollo_data' }],
  waterfallChecked: true, ...overrides
});

const startedWaterfall = (ids) => ({
  requestedIds: ids, requests: [{ requestId: '-123', ids }], candidates: [], failedIds: [], skippedIds: []
});

// A found candidate is expanded automatically, and the details panel repeats
// the contact fields the row already shows, so an assertion about one field has
// to say which of the two it means.
function identity(name) {
  return rowFor(name).querySelector('.candidate-row .identity');
}

function contactCell(name) {
  return rowFor(name).querySelector('.candidate-row .contact');
}

function contactLine(name, label) {
  const lines = [...contactCell(name).querySelectorAll('.contact-line')];
  return lines.find((line) => line.querySelector('.contact-label')?.textContent === label) || null;
}

async function runWaterfall(people, poll, waterfall) {
  await searchWith(people, undefined, undefined,
    waterfall || (() => startedWaterfall(people.map((person) => person.id))), poll);
  for (const person of people) {
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`select ${person.name}`, 'i') }));
  }
  fireEvent.click(findButton());
  fireEvent.click(screen.getByRole('button', { name: /^search other sources/i }));
}

test('a waterfall answer with no contact data leaves the candidate on screen intact', async () => {
  // The bug this locks out: the answer carries only an id, so applying it as
  // though it were an enrichment record replaced the row with a nameless husk.
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [waterfallAnswer('person-1')],
      summary: { emailsFound: 0, emailsNotFound: 1, creditsConsumed: 0, vendors: [{ name: 'Apollo', status: 'NOT_FOUND' }] }
    })
  );

  await screen.findByText(/^no personal email found\./i);
  // Everything the search had already told us is still there.
  expect(within(identity('Test Candidate')).getByText('Test Candidate')).toBeTruthy();
  expect(within(identity('Test Candidate')).getByText('Java Developer')).toBeTruthy();
  const row = rowFor('Test Candidate').querySelector('.candidate-row');
  expect(within(row).getByText('Example Co')).toBeTruthy();
  expect(within(row).getByText('Hyderabad')).toBeTruthy();
  // And a completed search that found nothing says so, in its own words.
  expect(contactLine('Test Candidate', 'Personal').textContent).toMatch(/no personal email found/i);
});

test('a successful waterfall that found nothing is not reported as a failure', async () => {
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [],
      summary: { emailsFound: 0, emailsNotFound: 1, creditsConsumed: 0, vendors: [{ name: 'Apollo', status: 'NOT_FOUND' }] }
    })
  );

  // Apollo was reached, answered, and found nothing. That is a result, and it
  // names only the source Apollo said it queried.
  await screen.findByText(/^no personal email found\. sources checked: apollo\.$/i);
  expect(document.querySelector('.status.error')).toBeNull();
  expect(screen.queryByText(/failed to fetch/i)).toBeNull();
  expect(screen.queryByText(/unable to/i)).toBeNull();
  // Answered with no record at all is still an answer about this candidate.
  expect(contactLine('Test Candidate', 'Personal').textContent).toMatch(/no personal email found/i);
});

test('the personal address a waterfall finds is shown on the row it belongs to', async () => {
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [waterfallAnswer('person-1', {
        email: 'work@example-co.test', emailType: 'work', emailAvailable: true,
        personalEmail: 'found@example-mail.test',
        vendors: [{ name: 'Other Source', status: 'FOUND', statusCode: 'ok' }]
      })],
      summary: { emailsFound: 1, emailsNotFound: 0, creditsConsumed: 1, vendors: [{ name: 'Other Source', status: 'FOUND' }] }
    })
  );

  await screen.findByText(/found 1 personal email in other data sources/i);
  expect(within(identity('Test Candidate')).getByText('Test Candidate')).toBeTruthy();
  const link = within(contactCell('Test Candidate')).getByRole('link', { name: 'found@example-mail.test' });
  expect(link.getAttribute('href')).toBe('mailto:found@example-mail.test');
  // The work address the row already held is not erased by the search.
  expect(contactLine('Test Candidate', 'Work email').textContent).toMatch(/work@example-co\.test/);
});

test('a phone number a waterfall returns is shown, and one it does not is not invented', async () => {
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Has Number'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'No Number'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [
        waterfallAnswer('person-1', { phone: '+1 555 0100 999', phoneAvailable: true }),
        waterfallAnswer('person-2')
      ],
      summary: { emailsFound: 0, emailsNotFound: 2, creditsConsumed: 0, vendors: [] }
    })
  );

  await screen.findByText(/^no personal email found\.$/i);
  const dialled = within(contactCell('Has Number')).getByRole('link', { name: '+1 555 0100 999' });
  expect(dialled.getAttribute('href')).toBe('tel:+1 555 0100 999');
  // Apollo returned no number for the other one, so none is shown for it.
  expect(within(contactCell('No Number')).queryByRole('link', { name: /555/ })).toBeNull();
  expect(contactLine('No Number', 'Phone').textContent).toMatch(/not available/i);
});

test('a candidate still being searched says so instead of showing a blank', async () => {
  let polls = 0;
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => {
      polls += 1;
      // Still running at Apollo. The retry hint is long enough that the poll
      // does not come back before the assertions below run.
      return { status: 'pending', retryAfterSeconds: 30, candidates: [] };
    }
  );

  await waitFor(() => expect(polls).toBeGreaterThan(0));
  // A third state: not found, not missing, still being looked for.
  await waitFor(() => expect(contactLine('Test Candidate', 'Personal').textContent).toMatch(/checking for personal email/i));
  expect(screen.queryByText('No personal email found')).toBeNull();
});

test('each answer in a batch lands on its own candidate', async () => {
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Candidate One'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'Candidate Two'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      // Returned in the opposite order to the request, which a positional
      // match would cross over.
      candidates: [
        waterfallAnswer('person-2', { personalEmail: 'two@example-mail.test' }),
        waterfallAnswer('person-1', { personalEmail: 'one@example-mail.test' })
      ],
      summary: { emailsFound: 2, emailsNotFound: 0, creditsConsumed: 2, vendors: [] }
    })
  );

  await screen.findByText(/found 2 personal emails/i);
  expect(within(contactCell('Candidate One')).getByRole('link', { name: 'one@example-mail.test' })).toBeTruthy();
  expect(within(contactCell('Candidate Two')).getByRole('link', { name: 'two@example-mail.test' })).toBeTruthy();
});

test('an address Apollo stated no kind for is not labelled as a work address', async () => {
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [waterfallAnswer('person-1', {
        email: 'someone@example-co.test', emailType: 'unknown', emailAvailable: true
      })],
      summary: { emailsFound: 1, emailsNotFound: 0, creditsConsumed: 1, vendors: [] }
    })
  );

  // Apollo said it found and charged for an address, so that is what is
  // reported; it just is not one it called personal.
  await screen.findByText(/charged for 1 record, but returned no personal address/i);
  // And because Apollo did not say what kind of address it is, neither do we.
  await waitFor(() => expect(contactLine('Test Candidate', 'Email').textContent).toMatch(/someone@example-co\.test/));
  expect(contactLine('Test Candidate', 'Work email')).toBeNull();
});

test('a completed waterfall is not run again on the same candidate', async () => {
  // Credit safety: the answer is already in hand. Asking again makes Apollo pay
  // vendors for a lookup that has already been done and answered.
  await runWaterfall(
    [{ ...bareCandidate('person-1', 'Test Candidate'), hasEmailOnFile: true }],
    () => ({
      status: 'ready',
      candidates: [waterfallAnswer('person-1')],
      summary: { emailsFound: 0, emailsNotFound: 1, creditsConsumed: 0, vendors: [{ name: 'Apollo', status: 'NOT_FOUND' }] }
    })
  );
  await screen.findByText(/^no personal email found\./i);

  // The candidate stays selected after a search, so this is exactly the second
  // click a recruiter makes when the first found nothing.
  const before = calls.filter((call) => call.url === '/api/candidates/waterfall').length;
  fireEvent.click(findButton());

  await screen.findByText(/already been searched for that candidate and found no personal email/i);
  // Not even a confirmation prompt, so there is nothing to mis-click.
  expect(screen.queryByRole('button', { name: /^search other sources/i })).toBeNull();
  expect(calls.filter((call) => call.url === '/api/candidates/waterfall').length).toBe(before);
});

// --- Finding one known person -----------------------------------------------
//
// The second way in: the recruiter already knows who they want, so there is no
// pool to filter. Every response below is mocked.

function modeButton(label) {
  return screen.getByRole('radio', { name: label });
}

function lookupField(label) {
  return screen.getByLabelText(label);
}

function findPersonButton() {
  return screen.getByRole('button', { name: /^find this person/i });
}

// Renders the app in person mode with a mocked lookup handler.
function renderLookup(lookupHandler) {
  mockBackend({ search: () => searchResult([]), lookup: lookupHandler });
  render(<App />);
  fireEvent.click(modeButton('Find one person'));
}

test('the two search modes are exclusive and show their own fields', async () => {
  renderLookup(() => ({ candidate: null, matched: false }));

  // Person mode: the pool filters are gone and the identifiers are present.
  expect(modeButton('Find one person').getAttribute('aria-checked')).toBe('true');
  expect(modeButton('Filter a pool').getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByLabelText(/role \/ job title/i)).toBeNull();
  expect(screen.queryByLabelText(/skills \/ keywords/i)).toBeNull();
  expect(lookupField(/^name/i)).toBeTruthy();
  expect(lookupField(/email address/i)).toBeTruthy();
  expect(lookupField(/linkedin url/i)).toBeTruthy();

  // And back again, with the pool filters restored.
  fireEvent.click(modeButton('Filter a pool'));
  expect(screen.getByLabelText(/role \/ job title/i)).toBeTruthy();
  expect(screen.queryByLabelText(/email address/i)).toBeNull();
});

test('a lookup cannot be sent with nothing to match on', async () => {
  renderLookup(() => ({ candidate: null, matched: false }));

  expect(findPersonButton().disabled).toBe(true);
  expect(screen.getByText(/a company on its own is not a person/i)).toBeTruthy();

  // A company alone is still not a person, so the button stays disabled.
  fireEvent.change(lookupField(/^company/i), { target: { value: 'Example Co' } });
  expect(findPersonButton().disabled).toBe(true);

  // Any one real identifier is enough.
  fireEvent.change(lookupField(/^name/i), { target: { value: 'Test Candidate' } });
  expect(findPersonButton().disabled).toBe(false);
  expect(calls.some((call) => call.url === '/api/candidates/lookup')).toBe(false);
});

test('a matched person lands in the results as an enriched row', async () => {
  renderLookup(() => ({
    matched: true,
    candidate: enrichedCandidate('person-1', 'Test Candidate', {
      title: 'Python Developer', company: 'Example Co', hasEmailOnFile: true, email: null
    })
  }));

  fireEvent.change(lookupField(/email address/i), { target: { value: 'someone@example-co.test' } });
  fireEvent.click(findPersonButton());

  await screen.findByText(/apollo matched test candidate/i);
  // Only what Apollo sent for this person, not a page of a pool.
  expect(screen.getByText('The person Apollo matched')).toBeTruthy();
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  // Enriched, so the full profile is on screen and revealing is the next step.
  await detailsPanel('Test Candidate');
  expect(screen.queryByRole('button', { name: /next →/i })).toBeNull();

  const sent = calls.find((call) => call.url === '/api/candidates/lookup');
  expect(sent.body).toEqual({ name: '', company: '', email: 'someone@example-co.test', linkedinUrl: '' });
});

test('a lookup that matches nobody says so and clears the previous person', async () => {
  let matched = true;
  renderLookup(() => (matched
    ? { matched: true, candidate: enrichedCandidate('person-1', 'Test Candidate') }
    : { matched: false, candidate: null }));

  fireEvent.change(lookupField(/^name/i), { target: { value: 'Test Candidate' } });
  fireEvent.click(findPersonButton());
  await screen.findByText(/apollo matched test candidate/i);

  // The second lookup finds nobody. The first person must not be left on
  // screen looking like the answer to it.
  matched = false;
  fireEvent.change(lookupField(/^name/i), { target: { value: 'Nobody At All' } });
  fireEvent.click(findPersonButton());

  await screen.findByText(/apollo has no person matching those details/i);
  expect(screen.queryByText('Test Candidate')).toBeNull();
  // Not an error: Apollo answered, it just has nobody.
  expect(document.querySelector('.status.error')).toBeNull();
});

test('a lookup never asks Apollo for contact data by itself', async () => {
  renderLookup(() => ({
    matched: true,
    // Apollo matched the person but the lookup did not ask for an address.
    candidate: enrichedCandidate('person-1', 'Test Candidate', { email: null, personalEmail: null, hasEmailOnFile: true })
  }));

  fireEvent.change(lookupField(/^name/i), { target: { value: 'Test Candidate' } });
  fireEvent.click(findPersonButton());
  await screen.findByText(/apollo matched test candidate/i);

  // Never asked is not the same as none found, so the personal filter must not
  // count this person as confirmed to have no personal address.
  fireEvent.click(screen.getByRole('checkbox', { name: /^personal email only/i }));
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.queryByText(/hidden - apollo returned no personal address/i)).toBeNull();
  // And nothing that spends contact credits was called.
  expect(calls.some((call) => call.url === '/api/candidates/reveal')).toBe(false);
  expect(calls.some((call) => call.url === '/api/candidates/waterfall')).toBe(false);
});

test('a failed lookup is reported and never retried on its own', async () => {
  let attempts = 0;
  renderLookup(() => {
    attempts += 1;
    // An enrichment call must not be repeated by the app: a dropped connection
    // does not prove Apollo went unasked.
    return proxyUnreachable();
  });

  fireEvent.change(lookupField(/^name/i), { target: { value: 'Test Candidate' } });
  fireEvent.click(findPersonButton());

  await screen.findByText(/the candidate api is not running/i);
  expect(attempts).toBe(1);
});

test('reset clears the identifiers, not the pool filters', async () => {
  renderLookup(() => ({ candidate: null, matched: false }));

  fireEvent.change(lookupField(/^name/i), { target: { value: 'Test Candidate' } });
  fireEvent.change(lookupField(/^company/i), { target: { value: 'Example Co' } });
  fireEvent.click(screen.getByRole('button', { name: /reset details/i }));

  expect(lookupField(/^name/i).value).toBe('');
  expect(lookupField(/^company/i).value).toBe('');
});

// --- Narrowing a pool down to the right person ------------------------------
//
// Apollo requires every keyword to match, so each skill added narrows the pool
// hard: measured against the live API, "python" returned 234, "python django"
// returned 8 and "python django aws" returned 0. These lock in the behaviour
// that makes that usable - separate terms, and the count for each query.

function keywordBox() {
  return screen.getByLabelText(/skills \/ keywords/i);
}

function skillChip(term) {
  // Named exactly, so the term's own toggle is matched and not its "Remove x"
  // sibling. `pressed` is not used as a filter: it is what the tests assert.
  return screen.getByRole('button', { name: term });
}

function skillChips() {
  return [...document.querySelectorAll('.chips-editable .chip-toggle')].map((chip) => chip.textContent);
}

function searchButton() {
  return screen.getByRole('button', { name: /search candidates/i });
}

// Records what each search asked Apollo for, and answers with a pool size that
// depends on how many keywords were sent - the way Apollo actually behaves.
function poolBackend(totalsByKeywords) {
  mockBackend({
    search: (body) => {
      const total = totalsByKeywords[body.keywords] ?? 0;
      const shown = Math.min(total, 25);
      return {
        candidates: Array.from({ length: shown }, (_, index) => bareCandidate(`person-${index + 1}`, `Candidate ${index + 1}`)),
        page: 1, perPage: 25, total
      };
    }
  });
  render(<App />);
  fillRequired({ keywords: '' });
}

function addSkill(term) {
  fireEvent.change(keywordBox(), { target: { value: term } });
  fireEvent.keyDown(keywordBox(), { key: 'Enter' });
}

test('a typed skill becomes a term of its own on Enter', async () => {
  poolBackend({ python: 234 });

  addSkill('python');
  // Committed, and the box is clear for the next one.
  expect(keywordBox().value).toBe('');
  expect(skillChip('python')).toBeTruthy();

  // A comma commits one too, because that is how a recruiter lists skills.
  fireEvent.change(keywordBox(), { target: { value: 'django,' } });
  fireEvent.keyDown(keywordBox(), { key: ',' });
  expect(skillChip('django')).toBeTruthy();
  expect(keywordBox().value).toBe('');

  // The same skill twice is still one filter.
  addSkill('python');
  expect(skillChips().filter((term) => term === 'python')).toHaveLength(1);
});

test('every enabled term is sent to Apollo as one pool that must match them all', async () => {
  poolBackend({ python: 234, 'python django': 8 });

  addSkill('python');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 25 of 234 profiles/i);
  expect(calls.at(-1).body.keywords).toBe('python');

  addSkill('django');
  expect(screen.getByText(/apollo will return only candidates matching all 2: python \+ django/i)).toBeTruthy();
  fireEvent.click(searchButton());
  await screen.findByText(/showing 8 of 8 profiles/i);
  expect(calls.at(-1).body.keywords).toBe('python django');
});

test('a skill still in the box is not silently dropped from the search', async () => {
  poolBackend({ 'python django': 8 });

  addSkill('python');
  // Typed but never committed. It is still a skill the recruiter asked for.
  fireEvent.change(keywordBox(), { target: { value: 'django' } });
  fireEvent.click(searchButton());

  await screen.findByText(/showing 8 of 8 profiles/i);
  expect(calls.at(-1).body.keywords).toBe('python django');
});

test('the pool size for each query is shown, so the narrowing is visible', async () => {
  poolBackend({ python: 234, 'python django': 8, 'python django aws': 0 });

  addSkill('python');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 25 of 234 profiles/i);

  addSkill('django');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 8 of 8 profiles/i);

  const trail = document.querySelector('.refine-trail');
  expect(trail).toBeTruthy();
  expect(within(trail).getByText('234')).toBeTruthy();
  expect(within(trail).getByText('8')).toBeTruthy();
  expect(within(trail).getByText('python')).toBeTruthy();
  expect(within(trail).getByText('python django')).toBeTruthy();
});

test('an empty pool says which skill to drop instead of just "none found"', async () => {
  poolBackend({ python: 234, 'python django': 8, 'python django aws': 0 });

  addSkill('python');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 25 of 234 profiles/i);
  addSkill('django');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 8 of 8 profiles/i);

  // The third skill takes it to nothing. That is Apollo ANDing the keywords,
  // not an empty market, and the recruiter is told the difference.
  addSkill('aws');
  fireEvent.click(searchButton());

  await screen.findByText(/no candidates match all 3 keywords at once/i);
  // Including the last pool size that did work, so there is something to go back to.
  expect(screen.getByText(/"python django" matched 8/i)).toBeTruthy();
  expect(screen.getByText(/turn a skill off and search again/i)).toBeTruthy();
});

test('turning a term off widens the pool without retyping the rest', async () => {
  poolBackend({ 'python django': 8, 'python django aws': 0 });

  addSkill('python');
  addSkill('django');
  addSkill('aws');
  fireEvent.click(searchButton());
  await screen.findByText(/no candidates match all 3 keywords/i);

  // One click, and the other two terms are untouched.
  fireEvent.click(skillChip('aws'));
  expect(skillChip('aws').getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(searchButton());

  await screen.findByText(/showing 8 of 8 profiles/i);
  expect(calls.at(-1).body.keywords).toBe('python django');
  // Still there to switch back on, not deleted.
  expect(skillChip('aws')).toBeTruthy();
});

test('a single keyword that genuinely matches nobody is not blamed on the AND', async () => {
  poolBackend({ quantumnonsenseterm: 0 });

  addSkill('quantumnonsenseterm');
  fireEvent.click(searchButton());

  await screen.findByText(/^no matching candidates found\.$/i);
  expect(screen.queryByText(/turn a skill off/i)).toBeNull();
});

test('a committed term satisfies the keyword requirement on its own', async () => {
  poolBackend({ python: 234 });

  // Nothing typed in the box, but a term is committed, so the form is complete
  // and the browser must not refuse to submit it.
  addSkill('python');
  expect(keywordBox().value).toBe('');
  expect(keywordBox().required).toBe(false);
  expect(keywordBox().getAttribute('aria-required')).toBe('true');
  expect(searchButton().disabled).toBe(false);

  // And with the term turned off, the requirement is unmet again.
  fireEvent.click(skillChip('python'));
  expect(searchButton().disabled).toBe(true);
  expect(keywordBox().required).toBe(true);
});

test('removing a term drops it from the search entirely', async () => {
  poolBackend({ python: 234 });

  addSkill('python');
  addSkill('django');
  fireEvent.click(screen.getByRole('button', { name: /remove django/i }));

  expect(skillChips()).not.toContain('django');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 25 of 234 profiles/i);
  expect(calls.at(-1).body.keywords).toBe('python');
});

test('reset clears the terms and the record of pool sizes', async () => {
  poolBackend({ python: 234, 'python django': 8 });

  addSkill('python');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 25 of 234 profiles/i);
  addSkill('django');
  fireEvent.click(searchButton());
  await screen.findByText(/showing 8 of 8 profiles/i);
  expect(document.querySelector('.refine-trail')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /reset filters/i }));
  expect(skillChips()).not.toContain('python');
  expect(document.querySelector('.refine-trail')).toBeNull();
});

// --- Finding one person among the rows already loaded -----------------------
//
// Local only: this box sends nothing to Apollo, so it costs nothing and cannot
// see past the loaded page. Both of those are asserted below.

function rowSearch() {
  return screen.getByLabelText(/find a candidate/i);
}

function nameSearchButton() {
  // The label states the scope, so it is matched on the stable part.
  return screen.getByRole('button', { name: /by name/i });
}

// Present only when at least one pool filter holds a value.
function nameScopeToggle() {
  return screen.getByRole('checkbox', { name: /also narrow the name search/i });
}

function visibleNames() {
  return [...document.querySelectorAll('.candidate-row .identity strong')].map((cell) => cell.textContent);
}

const poolOf = (people, total) => ({ candidates: people, page: 1, perPage: 25, total: total ?? people.length });

async function loadedPool(people, total) {
  mockBackend({ search: () => poolOf(people, total) });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  for (const person of people) await screen.findByText(person.name);
}

test('the results search box narrows the loaded rows by name, company or title', async () => {
  await loadedPool([
    { ...bareCandidate('person-1', 'Zahid'), company: 'eBhasha Setu' },
    { ...bareCandidate('person-2', 'Aman'), company: 'Canopy' },
    { ...bareCandidate('person-3', 'Sachin'), company: 'Palni Inc', title: 'Senior Python Developer' }
  ]);
  expect(visibleNames()).toEqual(['Zahid', 'Aman', 'Sachin']);

  // By name.
  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  expect(visibleNames()).toEqual(['Aman']);

  // By company.
  fireEvent.change(rowSearch(), { target: { value: 'palni' } });
  expect(visibleNames()).toEqual(['Sachin']);

  // By title, which is the one field that differs between these rows.
  fireEvent.change(rowSearch(), { target: { value: 'senior' } });
  expect(visibleNames()).toEqual(['Sachin']);

  // Cleared, everyone is back.
  fireEvent.change(rowSearch(), { target: { value: '' } });
  expect(visibleNames()).toEqual(['Zahid', 'Aman', 'Sachin']);
});

test('the results search never calls Apollo', async () => {
  await loadedPool([bareCandidate('person-1', 'Zahid'), bareCandidate('person-2', 'Aman')]);
  const before = calls.length;

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  fireEvent.change(rowSearch(), { target: { value: 'zah' } });
  fireEvent.change(rowSearch(), { target: { value: 'nobody' } });

  // Typing must not spend a search per keystroke.
  expect(calls.length).toBe(before);
});

test('the box says it only sees the loaded page, not the whole pool', async () => {
  await loadedPool([bareCandidate('person-1', 'Zahid'), bareCandidate('person-2', 'Aman')], 234);

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  expect(screen.getByText(/1 of 2 loaded rows on this page match/i)).toBeTruthy();
  // The honest limit, and the way out of it.
  expect(screen.getByText(/searching by name looks through all of apollo for that name, narrowed by your role, location and skills/i)).toBeTruthy();
});

test('a query matching nothing on this page says so without claiming the pool is empty', async () => {
  await loadedPool([bareCandidate('person-1', 'Zahid')], 234);

  fireEvent.change(rowSearch(), { target: { value: 'nobody here' } });
  expect(screen.getByText(/nothing on this page matches "nobody here"/i)).toBeTruthy();
  expect(visibleNames()).toEqual([]);
  // Not reported as an empty market.
  expect(screen.queryByText(/no matching candidates found/i)).toBeNull();
});

test('a row hidden by the search box is never selected by Select all', async () => {
  await loadedPool([
    { ...bareCandidate('person-1', 'Zahid'), hasEmailOnFile: true },
    { ...bareCandidate('person-2', 'Aman'), hasEmailOnFile: true }
  ]);

  fireEvent.change(rowSearch(), { target: { value: 'aman' } });
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));

  // Credit safety: Select all must not reach past what is on screen.
  expect(selectionCount()).toMatch(/Selected: *1/);
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));
  await screen.findByText(/revealing contact details for 1 candidate/i);
});

test('the search box works alongside the personal email filter', async () => {
  await loadedPool([
    { ...bareCandidate('person-1', 'Zahid'), company: 'Canopy' },
    { ...bareCandidate('person-2', 'Aman'), company: 'Canopy' }
  ]);

  // Both narrow the same list rather than fighting over it.
  fireEvent.change(rowSearch(), { target: { value: 'canopy' } });
  expect(visibleNames()).toEqual(['Zahid', 'Aman']);
  fireEvent.change(rowSearch(), { target: { value: 'zahid' } });
  expect(visibleNames()).toEqual(['Zahid']);
  fireEvent.click(screen.getByRole('checkbox', { name: /^personal email only/i }));
  // Neither has been revealed, so neither is confirmed to lack a personal
  // address, and the name filter still applies.
  expect(visibleNames()).toEqual(['Zahid']);
});

test('the skill terms area is visible before any term exists', async () => {
  mockBackend({});
  render(<App />);
  // The defect this locks out: the terms feature only appeared once a term
  // existed, so there was nothing on screen to tell anyone it was there.
  expect(screen.getByText(/skills apollo must match/i)).toBeTruthy();
  expect(screen.getByText(/press enter to add it as its own term/i)).toBeTruthy();
});

// --- Searching every page for one candidate by name -------------------------
//
// Apollo's own q_person_name filter, so the search covers the whole pool
// instead of the page in hand. Verified live against the API: "Sachin" with a
// python-developer/hyderabad pool returned 1 and "Aman" returned 2, against a
// 2,408-profile baseline.

// Answers a name-filtered search with its own pool, so the difference between
// "this page" and "every page" is observable.
function namePool({ base, byName }) {
  mockBackend({
    search: (body) => {
      const set = body.personName ? (byName[body.personName] || []) : base;
      return { candidates: set.slice(0, 25), page: body.page || 1, perPage: 25, total: set.length };
    }
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
}

const rows = (names) => names.map((name, index) => bareCandidate(`person-${index + 1}`, name));

test('a name is sent to Apollo so the search covers every page, not just this one', async () => {
  const base = rows(Array.from({ length: 25 }, (_, i) => `Candidate ${i + 1}`));
  namePool({ base: [...base, ...rows(['padding'])], byName: { Adhitya: rows(['Adhitya K', 'Adhitya R']) } });
  await screen.findByText('Candidate 1');

  fireEvent.change(rowSearch(), { target: { value: 'Adhitya' } });
  // Nothing on this page, but the pool has 26 profiles, so there is more to look at.
  expect(screen.getByText(/nothing on this page matches "adhitya"/i)).toBeTruthy();

  fireEvent.click(nameSearchButton());

  await screen.findByText('Adhitya K');
  expect(screen.getByText('Adhitya R')).toBeTruthy();
  // Apollo did the filtering, across the whole pool.
  expect(calls.at(-1).body.personName).toBe('Adhitya');
  expect(calls.at(-1).body.page).toBe(1);
});

test('Enter in the box runs the same whole-pool search as the button', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Sachin: rows(['Sachin']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Sachin' } });
  fireEvent.keyDown(rowSearch(), { key: 'Enter' });

  await screen.findByText('Sachin');
  expect(calls.at(-1).body.personName).toBe('Sachin');
});

test('an active name filter is stated plainly and can be cleared', async () => {
  namePool({ base: rows(['Someone Else', 'Another One']), byName: { Aman: rows(['Aman', 'Aman Two']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aman');

  // The pool itself is filtered now, so the recruiter is told rather than left
  // wondering why the totals changed.
  // Filters are applied by default, and the copy says so rather than implying
  // the list is everyone with that name.
  expect(screen.getByText(/showing people named "aman" who also match your role, location and skills/i)).toBeTruthy();
  expect(screen.getByText(/2 profiles match\./i)).toBeTruthy();
  expect(screen.getByText(/untick the box above and search again to see everyone with that name/i)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /clear name filter/i }));
  await screen.findByText('Someone Else');
  expect(calls.at(-1).body.personName).toBe('');
  expect(screen.queryByText(/apollo is filtering the whole pool/i)).toBeNull();
});

test('a name Apollo has nobody for is reported as its own answer', async () => {
  namePool({ base: rows(['Someone Else']), byName: {} });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Nobody' } });
  fireEvent.click(nameSearchButton());

  // Not blamed on the keywords, which is a different problem with a different fix.
  // Narrowed by the filters, so they are the likely cause and the message says
  // so instead of claiming Apollo has nobody by that name at all.
  await screen.findByText(/nobody named "nobody" matches your role, location and skills/i);
  expect(screen.queryByText(/turn a skill off/i)).toBeNull();

  // Unnarrowed, the same empty result means something else entirely.
  fireEvent.click(nameScopeToggle());
  fireEvent.click(nameSearchButton());
  await screen.findByText(/apollo has nobody by the name "nobody"/i);
  expect(screen.getByText(/nothing else was applied to this search/i)).toBeTruthy();
});

test('the same name is not searched twice in a row', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aman');

  const searches = calls.filter((call) => call.url === '/api/candidates/search').length;
  // Already the active filter, so the button is spent and clicking does nothing.
  expect(nameSearchButton().disabled).toBe(true);
  fireEvent.keyDown(rowSearch(), { key: 'Enter' });
  expect(calls.filter((call) => call.url === '/api/candidates/search').length).toBe(searches);
});

test('paging keeps the name filter instead of reverting to the whole pool', async () => {
  const many = rows(Array.from({ length: 30 }, (_, i) => `Aman ${i + 1}`));
  namePool({ base: rows(['Someone Else']), byName: { Aman: many } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aman 1');

  fireEvent.click(screen.getByRole('button', { name: /next →/i }));
  await waitFor(() => expect(calls.at(-1).body.page).toBe(2));
  // The name must travel with the page, or page 2 would be the unfiltered pool.
  expect(calls.at(-1).body.personName).toBe('Aman');
});

test('a name search can be sent on its own, with no role, location or skills', async () => {
  // Unticked, the name goes to Apollo alone - which is what finds a real person
  // who happens not to match the pool the recruiter last described.
  namePool({ base: rows(['Someone Else']), byName: { 'Aditya Sai': rows(['Aditya Sai', 'Aditya Sai Kumar']) } });
  await screen.findByText('Someone Else');
  // The pool filters are still filled in from the search above.
  expect(screen.getByLabelText(/role \/ job title/i).value).toBe('java developer');

  fireEvent.click(nameScopeToggle());
  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  fireEvent.click(nameSearchButton());

  await screen.findByText('Aditya Sai');
  expect(screen.getByText('Aditya Sai Kumar')).toBeTruthy();

  const sent = calls.at(-1).body;
  expect(sent.personName).toBe('Aditya Sai');
  // Nothing else went with it, even though the form still shows those values.
  expect(sent.jobTitle).toBe('');
  expect(sent.location).toBe('');
  expect(sent.keywords).toBe('');
  expect(sent.company).toBe('');
  expect(sent.industry).toBe('');
  expect(sent.seniority).toBe('');
});

test('searching the pool again drops the name instead of ANDing it on', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aman');

  // Describing a pool is the opposite question to naming a person.
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Someone Else');
  const sent = calls.at(-1).body;
  expect(sent.personName).toBe('');
  expect(sent.jobTitle).toBe('java developer');
});

test('a name search does not clutter the skill-narrowing trail', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aman: rows(['Aman']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aman' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aman');

  // The trail records narrowing a pool by skill. A name search does neither,
  // so it must not appear there as a mystery zero.
  const trail = document.querySelector('.refine-trail');
  if (trail) expect(trail.textContent).not.toMatch(/Aman/);
});

test('repeating the same pool search does not repeat the trail entry', async () => {
  poolBackend({ python: 0 });

  addSkill('python');
  fireEvent.click(searchButton());
  await screen.findByText(/no matching candidates found/i);
  fireEvent.click(searchButton());
  await screen.findByText(/no matching candidates found/i);
  fireEvent.click(searchButton());

  // Three identical searches are one piece of information, not three.
  await waitFor(() => {
    const entries = document.querySelectorAll('.refine-trail li');
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});

test('every profile a name search returns is actually rendered', async () => {
  // The bug this locks out: Apollo matches a name against a first or a last
  // name, so "Aditya Sai" comes back with people recorded as "Sai" and as
  // "Aditya". The local box filter then required the whole string and threw all
  // of them away, leaving an empty table under "Showing 18 of 18 profiles".
  namePool({
    base: rows(['Someone Else']),
    byName: { 'Aditya Sai': rows(['Sai', 'Aditya', 'Aditya Sai', 'Sai Kumar']) }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  fireEvent.click(nameSearchButton());

  await screen.findByText('Aditya Sai');
  // All four, not just the one whose name contains the full string.
  expect(visibleNames()).toEqual(['Sai', 'Aditya', 'Aditya Sai', 'Sai Kumar']);
  expect(screen.getByText(/4 profiles match\./i)).toBeTruthy();
});

test('typing something new still narrows the rows a name search returned', async () => {
  namePool({
    base: rows(['Someone Else']),
    byName: { 'Aditya Sai': [
      { ...bareCandidate('person-1', 'Sai'), company: 'Clarivate' },
      { ...bareCandidate('person-2', 'Aditya'), company: 'LexisNexis' }
    ] }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Sai');
  expect(visibleNames()).toEqual(['Sai', 'Aditya']);

  // Once the box says something other than the searched name, it is a local
  // filter again and narrows what Apollo returned.
  fireEvent.change(rowSearch(), { target: { value: 'clarivate' } });
  expect(visibleNames()).toEqual(['Sai']);
  expect(calls.at(-1).body.personName).toBe('Aditya Sai');
});

test('Select all reaches every row a name search returned', async () => {
  namePool({
    base: rows(['Someone Else']),
    byName: { 'Aditya Sai': [
      { ...bareCandidate('person-1', 'Sai'), hasEmailOnFile: true },
      { ...bareCandidate('person-2', 'Aditya'), hasEmailOnFile: true }
    ] }
  });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya Sai' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Sai');

  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  // Both, because neither is hidden any more.
  expect(selectionCount()).toMatch(/Selected: *2/);
});

test('a name search is narrowed by the pool filters by default', async () => {
  // The complaint this answers: a bare name returns tens of thousands of people
  // in unrelated roles, which is no use for sourcing.
  namePool({ base: rows(['Someone Else']), byName: { Aditya: rows(['Aditya']) } });
  await screen.findByText('Someone Else');

  expect(nameScopeToggle().checked).toBe(true);
  expect(nameScopeToggle().parentElement.textContent).toMatch(/also narrow the name search by role, location and skills/i);

  fireEvent.change(rowSearch(), { target: { value: 'Aditya' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aditya');

  const sent = calls.at(-1).body;
  expect(sent.personName).toBe('Aditya');
  // The role and the rest travel with it, so the results are people who could
  // actually be sourced for this requirement.
  expect(sent.jobTitle).toBe('java developer');
  expect(sent.location).toBe('delhi');
  expect(sent.keywords).toBe('java');
});

test('changing the scope re-enables the search for the same name', async () => {
  namePool({ base: rows(['Someone Else']), byName: { Aditya: rows(['Aditya']) } });
  await screen.findByText('Someone Else');

  fireEvent.change(rowSearch(), { target: { value: 'Aditya' } });
  fireEvent.click(nameSearchButton());
  await screen.findByText('Aditya');
  // Same name, same scope: nothing left to ask.
  expect(nameSearchButton().disabled).toBe(true);

  // Same name at a different scope is a genuinely different search.
  fireEvent.click(nameScopeToggle());
  expect(nameSearchButton().disabled).toBe(false);
  fireEvent.click(nameSearchButton());
  await waitFor(() => expect(calls.at(-1).body.jobTitle).toBe(''));
  expect(calls.at(-1).body.personName).toBe('Aditya');
});

test('the scope toggle is absent when there are no filters to narrow by', async () => {
  mockBackend({ search: () => ({ candidates: [bareCandidate('person-1', 'Someone')], page: 1, perPage: 25, total: 1 }) });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Someone');

  fireEvent.click(screen.getByRole('button', { name: /reset filters/i }));
  // Nothing to narrow by, so offering the choice would be meaningless.
  expect(screen.queryByRole('checkbox', { name: /also narrow the name search/i })).toBeNull();
  expect(nameSearchButton().textContent).toMatch(/search all of apollo by name/i);
});

// --- Revealing a phone number -----------------------------------------------
//
// The dearest thing the app can ask Apollo for, so every one of these asserts
// either that a number is reported honestly or that no credit was spent.

function phoneButton() {
  return screen.getByRole('button', { name: /^reveal phone/i });
}

// The normalized shape a phone job answers with: the person id, whatever number
// Apollo held, and nothing else.
const phoneAnswer = (id, overrides = {}) => ({
  id, requestedId: id, name: null, title: null, headline: null, company: null,
  location: null, seniority: null, departments: [], skills: [], linkedinUrl: null,
  email: null, emailType: null, personalEmail: null, hasEmailOnFile: null, phone: null,
  emailAvailable: false, phoneAvailable: false, employmentHistory: [], enriched: true,
  vendors: [], waterfallChecked: false, phoneChecked: true, ...overrides
});

async function phoneFlow(people, { phone, poll }) {
  mockBackend({ search: () => searchResult(people), phone, poll });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  for (const person of people) await screen.findByText(person.name);
  for (const person of people) {
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`select ${person.name}`, 'i') }));
  }
  fireEvent.click(phoneButton());
}

test('a phone reveal states its cost and spends nothing until confirmed', async () => {
  let called = false;
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => { called = true; return { requestedIds: ['person-1'], requests: [], candidates: [], failedIds: [], skippedIds: [] }; }
  });

  // Mobile credits cost more than an email, and the confirmation says so.
  expect(screen.getByText(/spends apollo mobile credits, which cost more than an email/i)).toBeTruthy();
  expect(screen.getByText(/apollo returns numbers asynchronously/i)).toBeTruthy();
  expect(called).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  await screen.findByText(/phone reveal cancelled\. no apollo credits were spent/i);
  expect(called).toBe(false);
  expect(calls.some((call) => call.url === '/api/candidates/phone')).toBe(false);
});

test('a confirmed reveal shows the number Apollo returns', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({
      status: 'ready', kind: 'phone',
      candidates: [phoneAnswer('person-1', { phone: '+1 555 0100 111', phoneAvailable: true })]
    })
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));

  await screen.findByText(/found 1 phone number/i);
  const link = within(rowFor('Test Candidate').querySelector('.candidate-row .contact')).getByRole('link', { name: '+1 555 0100 111' });
  expect(link.getAttribute('href')).toBe('tel:+1 555 0100 111');
  // The row keeps everything the search already told us.
  expect(within(rowFor('Test Candidate').querySelector('.candidate-row .identity')).getByText('Test Candidate')).toBeTruthy();
});

test('a candidate Apollo has no number for is told apart from one never asked', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));

  await screen.findByText(/apollo holds no phone number for these candidates/i);
  // Asked and answered, which is not the same as never asked.
  const contact = rowFor('Test Candidate').querySelector('.candidate-row .contact');
  expect(within(contact).getByText('No phone number found')).toBeTruthy();
  // And it is reported as information, not as a failure.
  expect(document.querySelector('.status.error')).toBeNull();
});

test('a phone answer does not claim the personal email was checked', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));
  await screen.findByText(/apollo holds no phone number/i);

  // A phone job looked for no address, so the row must not say one was not found.
  const contact = rowFor('Test Candidate').querySelector('.candidate-row .contact');
  expect(within(contact).queryByText('No personal email found')).toBeNull();
  // And the personal-email filter must not treat it as confirmed-none.
  fireEvent.click(screen.getByRole('checkbox', { name: /^personal email only/i }));
  expect(screen.getByText('Test Candidate')).toBeTruthy();
  expect(screen.queryByText(/hidden - apollo returned no personal address/i)).toBeNull();
});

test('a number already on screen is never paid for twice', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({
      status: 'ready', kind: 'phone',
      candidates: [phoneAnswer('person-1', { phone: '+1 555 0100 111' })]
    })
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));
  await screen.findByText(/found 1 phone number/i);

  const before = calls.filter((call) => call.url === '/api/candidates/phone').length;
  fireEvent.click(phoneButton());
  await screen.findByText(/a number is already on screen for that candidate/i);
  // Not even a confirmation, so there is nothing to mis-click.
  expect(screen.queryByRole('button', { name: /^reveal 1 phone number$/i })).toBeNull();
  expect(calls.filter((call) => call.url === '/api/candidates/phone').length).toBe(before);
});

test('a candidate Apollo already answered "no number" for is not asked again', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => ({
      requestedIds: ['person-1'],
      requests: [{ requestId: '991', ids: ['person-1'] }],
      candidates: [], failedIds: [], skippedIds: []
    }),
    poll: () => ({ status: 'ready', kind: 'phone', candidates: [phoneAnswer('person-1')] })
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));
  await screen.findByText(/apollo holds no phone number/i);

  const before = calls.filter((call) => call.url === '/api/candidates/phone').length;
  fireEvent.click(phoneButton());
  await screen.findByText(/already been asked for that candidate and holds no number/i);
  expect(calls.filter((call) => call.url === '/api/candidates/phone').length).toBe(before);
});

test('an unreachable webhook is reported without leaving the row broken', async () => {
  await phoneFlow([bareCandidate('person-1', 'Test Candidate')], {
    phone: () => new Error('APOLLO_WEBHOOK_URL is not set. Apollo posts the phone numbers there and charges for them either way, so nothing was requested.')
  });
  fireEvent.click(screen.getByRole('button', { name: /^reveal 1 phone number$/i }));

  await screen.findByText(/apollo_webhook_url is not set/i);
  // The candidate is left as it was, not marked failed for something that never
  // reached Apollo.
  expect(within(rowFor('Test Candidate')).getByText('Not enriched')).toBeTruthy();
});

test('Apollo saying it has no number means no mobile credit is spent', async () => {
  // has_direct_phone came back false, free, on the search. Asking anyway could
  // only return nothing, and a mobile credit is the dearest thing here.
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'No Number'), hasPhoneOnFile: false }]),
    phone: () => { throw new Error('Apollo must not be asked for a number it has already said it lacks'); }
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('No Number');

  fireEvent.click(screen.getByRole('checkbox', { name: /select no number/i }));
  fireEvent.click(phoneButton());

  await screen.findByText(/apollo holds no phone number for that candidate, so asking would return nothing and no credit was spent/i);
  expect(screen.queryByRole('button', { name: /^reveal 1 phone number$/i })).toBeNull();
  expect(calls.some((call) => call.url === '/api/candidates/phone')).toBe(false);
});

test('the confirmation says how many numbers Apollo has already confirmed', async () => {
  mockBackend({
    search: () => searchResult([
      { ...bareCandidate('person-1', 'Has Number'), hasPhoneOnFile: true, phoneAvailable: true },
      { ...bareCandidate('person-2', 'Maybe Number'), hasPhoneOnFile: null }
    ]),
    phone: () => ({ requestedIds: [], requests: [], candidates: [], failedIds: [], skippedIds: [] })
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Has Number');

  // Apollo says "Available" for the one it confirmed, before any credit.
  const contact = rowFor('Has Number').querySelector('.candidate-row .contact');
  expect(within(contact).getByText('Phone').parentElement.textContent).toMatch(/available/i);

  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  fireEvent.click(phoneButton());

  // Both are eligible - "Maybe" is not a no - and the cost is stated with what
  // Apollo has actually committed to.
  expect(screen.getByText(/apollo says it holds a direct number for 1 of them/i)).toBeTruthy();
});

test('the reveal dialog offers the phone in the same action', async () => {
  // The confusion this answers: a button called "reveal contact details" that
  // asked for the email and not the number, with the phone behind a second
  // button nobody found.
  let phoneAsked = null;
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'Sandhya'), hasEmailOnFile: true, hasPhoneOnFile: true, phoneAvailable: true }]),
    reveal: () => ({
      requestedIds: ['person-1'], revealedPersonalEmails: true, failedIds: [], skippedIds: [],
      candidates: [enrichedCandidate('person-1', 'Sandhya', { email: 'work@example-co.test', emailType: 'work' })]
    }),
    phone: (body) => {
      phoneAsked = body.ids;
      return { requestedIds: body.ids, requests: [{ requestId: '991', ids: body.ids }], candidates: [], failedIds: [], skippedIds: [] };
    },
    poll: () => ({
      status: 'ready', kind: 'phone',
      candidates: [{ ...bareCandidate('person-1', null), requestedId: 'person-1', phone: '+1 555 0100 111', phoneChecked: true, enriched: true }]
    })
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Sandhya');

  fireEvent.click(screen.getByRole('checkbox', { name: /select sandhya/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));

  // The dialog says the number is available and what it costs.
  const alsoPhone = screen.getByRole('checkbox', { name: /also ask for a phone number/i });
  expect(alsoPhone.parentElement.textContent).toMatch(/apollo confirms a direct number for 1/i);
  expect(alsoPhone.parentElement.textContent).toMatch(/extra mobile credits, which cost more than an email/i);
  expect(alsoPhone.checked).toBe(false);

  fireEvent.click(alsoPhone);
  fireEvent.click(screen.getByRole('button', { name: /spend up to 1 credit plus mobile/i }));

  // One confirmed action, both questions asked, and the number lands on the row.
  await waitFor(() => expect(phoneAsked).toEqual(['person-1']));
  await screen.findByText(/found 1 phone number/i);
  const contact = rowFor('Sandhya').querySelector('.candidate-row .contact');
  expect(within(contact).getByRole('link', { name: '+1 555 0100 111' })).toBeTruthy();
  expect(within(contact).getByRole('link', { name: 'work@example-co.test' })).toBeTruthy();
});

test('a reveal left unticked still asks for the email only', async () => {
  let phoneCalled = false;
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'Sandhya'), hasEmailOnFile: true, hasPhoneOnFile: true }]),
    reveal: () => ({
      requestedIds: ['person-1'], revealedPersonalEmails: true, failedIds: [], skippedIds: [],
      candidates: [enrichedCandidate('person-1', 'Sandhya', { email: 'work@example-co.test', emailType: 'work' })]
    }),
    phone: () => { phoneCalled = true; return { requestedIds: [], requests: [], candidates: [], failedIds: [], skippedIds: [] }; }
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('Sandhya');

  fireEvent.click(screen.getByRole('checkbox', { name: /select sandhya/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));
  fireEvent.click(screen.getByRole('button', { name: /^spend up to 1 credit$/i }));

  await screen.findByText(/contact details requested for 1 candidate/i);
  // No mobile credit is spent unless it was asked for.
  expect(phoneCalled).toBe(false);
});

test('the dialog says so when Apollo has no number to ask for', async () => {
  mockBackend({
    search: () => searchResult([{ ...bareCandidate('person-1', 'No Number'), hasEmailOnFile: true, hasPhoneOnFile: false }]),
    reveal: () => ({ requestedIds: ['person-1'], revealedPersonalEmails: true, candidates: [], failedIds: [], skippedIds: [] })
  });
  render(<App />);
  fillRequired();
  fireEvent.click(screen.getByRole('button', { name: /search candidates/i }));
  await screen.findByText('No Number');

  fireEvent.click(screen.getByRole('checkbox', { name: /select no number/i }));
  fireEvent.click(screen.getByRole('button', { name: /^reveal email/i }));

  // Offering a number Apollo has already said it lacks would invite a wasted
  // mobile credit.
  expect(screen.queryByRole('checkbox', { name: /also ask for a phone number/i })).toBeNull();
  expect(screen.getByText(/asks for email addresses only\. apollo holds no phone number to ask for on this candidate/i)).toBeTruthy();
});
