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
function mockBackend({ search = () => searchResult([]), enrich = () => ({ requestedIds: [], candidates: [], failedIds: [], skippedIds: [] }) } = {}) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const target = String(url);
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url: target, body });
    if (target === '/api/candidates/search') return jsonResponse(search(body));
    if (target === '/api/candidates/enrich') {
      const result = enrich(body);
      if (result instanceof Error) return jsonResponse({ error: result.message }, 502);
      return jsonResponse(result);
    }
    throw new Error(`The application must not request ${target}`);
  });
}

function jsonResponse(payload, status = 200) {
  const text = JSON.stringify(payload);
  return { ok: status < 400, status, text: async () => text, json: async () => payload };
}

// What Vite's proxy returns when it cannot reach our backend: status 500 with
// a zero-length body.
function unreachableBackend() {
  return { ok: false, status: 500, text: async () => '', json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
}

async function searchWith(people, enrich) {
  mockBackend({ search: () => searchResult(people), enrich });
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
  fireEvent.click(screen.getByRole('button', { name: /select all/i }));
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox.checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox.checked).toBe(false);
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
  for (const label of ['Professional headline', 'Seniority', 'Department', 'Skills', 'Current employment', 'Previous employment', 'Email', 'Phone', 'LinkedIn']) {
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
