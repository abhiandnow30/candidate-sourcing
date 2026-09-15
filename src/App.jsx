import React, { useEffect, useRef, useState } from 'react';
import {
  ENRICHED, ENRICHING, FAILED, NOT_ENRICHED, REVEALING, REVEALING_PHONE,
  applyEnriched, applyStates, applyWaterfall, deliveryShortfall, deliveryShortfallMessage,
  enrichmentLabel, enrichmentSummary, idsToEnrich,
  idsToRevealPhone, markState, mergeCandidate, reconcile, stateOf, withoutAnswerFlags
} from './enrichment.js';

// personName is not one of the form fields: it is driven by the results search
// box, because that is where a recruiter is when they realise the person they
// want is on one of the other pages.
const initialFilters = { jobTitle: '', location: '', seniority: '', keywords: '', personName: '' };
// Nothing is required. The app opens on the whole pool and every filter cuts
// it down, which is the order a recruiter actually works in: see who is there,
// then narrow. Requiring a role first meant the first screen was empty and the
// location list had nothing to draw on.
// Fields holding a comma-separated list, shown as removable chips so the search
// reads as a list rather than as punctuation.
const MULTI_VALUE_FIELDS = ['keywords', 'location'];
// Which half-typed boxes a filter change *elsewhere* may commit on the
// recruiter's behalf. A skill typed but never entered is plainly meant to be
// searched on, so it goes in.
//
// Location does not. Its box searches the city list as you type - the cities
// themselves are ticked - so text sitting in it is a search term, not a filter.
// Committing it when some other control fired turned "Chen", typed to find
// Chennai, into a location filter of its own; Apollo ORs locations, so that
// widened the pool instead of narrowing it and left a bogus chip behind.
// Enter in that box still commits it, through commitDraft below.
const INCIDENTAL_DRAFT_FIELDS = ['keywords'];
const NO_DRAFTS = { keywords: '', location: '' };

// Apollo has no facet endpoint, and - measured against the live API - it
// returns no location on a search row either, so the cities a search "found"
// are almost always none. The list therefore starts from the places people are
// actually hired in, and any city a result does name is added to it. Plain text
// passed straight to Apollo: this narrows nothing by itself, and the box under
// the list still takes anything not on it.
// Cities only. A country belongs here about as much as "anywhere" does:
// locations are an OR at Apollo, so ticking one beside a city would quietly
// widen the search to the whole country rather than narrow it. The box under
// the list still takes a country, a state or a city nobody listed.
//
// Visakhapatnam and Vizag are the same place under two names. Both are offered
// because Apollo matches the text it holds, not the city it means, and profiles
// there are written either way - ticking both is an OR, so it costs nothing and
// catches the records the other spelling would miss.
const LOCATION_SUGGESTIONS = [
  'Chennai', 'Coimbatore', 'Trivandrum', 'Cochin', 'Bangalore', 'Mangalore',
  'Hyderabad', 'Visakhapatnam', 'Vizag', 'Bhubaneshwar', 'Pune', 'Mumbai',
  'Bhopal', 'Noida', 'Kanpur', 'Delhi', 'Gurgaon', 'Kolkata', 'Ahmedabad'
];

// Commas, not spaces: "Machine Learning" is one skill. De-duplicated to match
// what the server sends Apollo, so a value typed twice is one filter and not
// two identical chips fighting over the same React key.
function splitList(value) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

// Company and Industry were here and are gone, both measured against the live
// API rather than judged by eye:
//
//   organization_names is ignored outright - "Infosys", "Tata Consultancy
//   Services" and "zzz-does-not-exist" all returned the same 21,081 as no
//   filter at all, so the field could never do anything.
//
//   organization_industries works only for Apollo's own taxonomy names:
//   "computer software" 10,086 and "banking" 569, but "information technology"
//   and "staffing and recruiting" both 0. As free text it was a way to empty a
//   search with no explanation, the same trap the junior seniority was. It
//   could come back as a validated dropdown; as a text box it could not.


// How many past queries to keep in the refine trail. Enough to see which skill
// narrowed the pool, short enough not to become a wall of numbers.
const REFINE_TRAIL_LENGTH = 6;

// The seniority levels a technical hire actually sits at, measured against the
// live API for python developer, java developer and data scientist in one city:
//
//   entry 209/514/917 · senior 15/72/438 · manager 7/16/146 · intern 2/1/2
//   head, director, partner 0/0/0 · vp, c_suite, owner, founder 0-6
//
// Apollo's remaining levels are its sales-prospecting tiers and return nothing
// for engineering titles, so offering them is a way to get an empty result.
// "junior" and "mid_level" were offered here and are not Apollo values at all -
// picking either took any search to zero with no explanation.
const SENIORITIES = [
  ['intern', 'Intern'],
  ['entry', 'Entry'],
  ['senior', 'Senior'],
  ['manager', 'Manager']
];

// Suggested job titles, each verified against the live API to return a real
// pool rather than nothing. Offered as suggestions, not as the only choices:
// Apollo knows thousands of titles, and the field still takes anything typed
// into it - including several separated by commas, which Apollo ORs.
const ROLE_SUGGESTIONS = [
  'Software Engineer', 'Full Stack Developer', 'Backend Developer', 'Frontend Developer',
  'Python Developer', 'Java Developer', 'Android Developer', 'iOS Developer',
  'Data Scientist', 'Data Engineer', 'AI/ML Engineer', 'Machine Learning Engineer',
  'DevOps Engineer', 'Cloud Engineer', 'QA Engineer', 'Test Engineer',
  'UI/UX Designer', 'Business Analyst', 'Project Manager', 'Product Manager',
  'HR Executive', 'Sales Executive'
];

// Skills worth suggesting for each role, every one measured against the live
// API for a real pool in one city rather than guessed at. The number after each
// is what Apollo held for it alone:
//
//   java 835 · aws 717 · azure 663 · sql 530 · python 297 · react 131 ·
//   angular 92 · machine learning 381 · data science 510 · llm 25 ·
//   devops 3125 · automation 2218 · testing 575 · sales 10678 · agile 359
//
// Skills that returned nothing at all - tensorflow and figma among them - are
// deliberately absent: suggesting one is handing over an empty search. The
// field still takes anything typed into it.
const SKILLS_BY_ROLE = {
  'software engineer': ['java', 'python', 'sql', 'aws', 'javascript', 'agile'],
  'full stack developer': ['javascript', 'react', 'angular', 'java', 'sql', 'aws'],
  'backend developer': ['java', 'python', 'sql', 'spring boot', 'aws'],
  'frontend developer': ['javascript', 'react', 'angular', 'typescript'],
  'python developer': ['python', 'django', 'sql', 'aws', 'machine learning'],
  'java developer': ['java', 'spring boot', 'sql', 'aws'],
  'android developer': ['android', 'java', 'kotlin'],
  'ios developer': ['ios', 'swift'],
  'data scientist': ['python', 'machine learning', 'data science', 'sql', 'deep learning', 'nlp'],
  'data engineer': ['sql', 'python', 'aws', 'azure', 'data science'],
  'ai/ml engineer': ['machine learning', 'python', 'deep learning', 'llm', 'nlp'],
  'machine learning engineer': ['machine learning', 'python', 'deep learning', 'llm', 'nlp'],
  'devops engineer': ['devops', 'aws', 'azure', 'kubernetes', 'jenkins', 'terraform'],
  'cloud engineer': ['aws', 'azure', 'kubernetes', 'devops'],
  'qa engineer': ['testing', 'automation', 'selenium', 'agile'],
  'test engineer': ['testing', 'automation', 'selenium'],
  'ui/ux designer': ['user experience', 'agile'],
  'business analyst': ['business analysis', 'sql', 'data analysis', 'agile', 'excel'],
  'project manager': ['project management', 'agile'],
  'product manager': ['product management', 'agile'],
  'hr executive': ['recruitment', 'communication'],
  'sales executive': ['sales', 'communication', 'salesforce']
};

// Shown when no role is chosen, or a role nothing is mapped for.
const COMMON_SKILLS = ['python', 'java', 'sql', 'aws', 'machine learning', 'testing', 'agile'];

const NOT_AVAILABLE = 'Not available';
const DEFAULT_PER_PAGE = 25;
// Mirrors MAX_PHONE_PER_REQUEST on the backend. Mobile credits are the dearest
// thing this app spends, so the confirmation can state the real cost rather
// than a number the server will then cut down.
const PHONE_LIMIT = 5;
// Backoff for the retries below. A `node --watch` restart can take a second or
// more to rebind, and a single short retry lands inside the same gap, so this
// spans about three seconds in total. Safe only because search is free and
// repeatable; nothing that spends credits retries at all.
const RESTART_RETRY_DELAYS_MS = [400, 900, 1600];
// A waterfall runs for minutes. Poll no faster than Apollo asks, and give up
// rather than polling forever if it never finishes.
const WATERFALL_MAX_WAIT_MS = 5 * 60 * 1000;

function valueOrUnavailable(value) { return value || NOT_AVAILABLE; }

function Unavailable() { return <span className="muted">{NOT_AVAILABLE}</span>; }

// Apollo says which kind of address it gave us. A waterfall answer can carry an
// address Apollo stated no kind for, and calling that one a work address would
// be our claim rather than Apollo's, so it is labelled plainly. Anything else
// reads as a work address, which is what an unrevealed or missing one is
// expected to be.
function emailLabel(candidate) {
  if (candidate.emailType === 'personal') return 'Personal email';
  if (candidate.emailType === 'unknown') return 'Email';
  return 'Work email';
}

// A candidate's personal address, whichever slot Apollo's answer put it in: its
// own field when there is also a work address, or the primary one when the only
// address Apollo held was personal.
function personalEmailOf(candidate) {
  return candidate.personalEmail || (candidate.emailType === 'personal' ? candidate.email : null);
}

// What Apollo has said about a personal address is four different things, and a
// blank row cannot tell them apart. A found address wins; a waterfall still
// running says so; a finished one that found nothing says that, because a
// successful search with no result is a real answer and not a failure; and a
// candidate nobody has asked about stays "Not available".
function PersonalEmailStatus({ candidate }) {
  const personal = personalEmailOf(candidate);
  if (personal) return <a href={`mailto:${personal}`}>{personal}</a>;
  // A reveal that found nothing is an answer, and a paid one. Saying nothing
  // left the recruiter looking at the work address they already had, with no
  // way to tell whether the reveal had failed, been skipped, or simply come
  // back empty - so a credit was spent and the screen did not change.
  if (candidate.waterfallChecked || candidate.contactRevealed) {
    return <span className="muted">Apollo holds no personal email</span>;
  }
  return <Unavailable />;
}

// The same four states as the personal address, for the number. A phone job
// answers nothing about an email and vice versa, so this reads phoneChecked and
// never contactRevealed.
function PhoneStatus({ candidate, state }) {
  if (candidate.phone) return <a href={`tel:${candidate.phone}`}>{candidate.phone}</a>;
  if (state === REVEALING_PHONE) return <span className="muted">Checking for phone number...</span>;
  if (candidate.phoneChecked) return <span className="muted">No phone number found</span>;
  return <ContactValue value={null} available={candidate.phoneAvailable} />;
}

// Whether the dedicated personal line belongs on this row at all. It is
// suppressed when the primary line is already showing the personal address, so
// the same value is never displayed twice under two labels, and it stays hidden
// for a candidate no search of other sources has touched.
function showPersonalLine(candidate) {
  if (candidate.emailType === 'personal') return false;
  return Boolean(candidate.personalEmail)
    || Boolean(candidate.waterfallChecked)
    || Boolean(candidate.contactRevealed);
}

// Our backend always answers with JSON, but a proxy or gateway in front of it
// may not: an unreachable backend (a dev-server restart, for instance) yields
// an empty 500. Read the body as text first so that case becomes a message the
// recruiter can act on instead of a raw JSON parse failure.
async function readJson(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    if (data?.error) {
      const error = new Error(data.error);
      // Carried so a caller can tell a permanent failure from a retryable one.
      error.code = data.code;
      throw error;
    }
    throw new Error(response.status >= 500
      ? 'The candidate API is not reachable right now. If the dev server is restarting, try again in a moment.'
      : `The candidate API rejected the request (${response.status}).`);
  }
  if (!data) throw new Error('The candidate API returned an empty response.');
  return data;
}

// True when a 503 came from the dev proxy because nothing was listening, as
// opposed to a real answer from our backend. Reads a clone so the original
// response body stays available to readJson.
async function peekUnreachable(response) {
  try {
    const text = await response.clone().text();
    return JSON.parse(text)?.code === 'API_UNREACHABLE';
  } catch {
    return false;
  }
}

function DetailField({ label, children }) {
  return <div className="detail-field"><span className="detail-label">{label}</span><div className="detail-value">{children}</div></div>;
}

// Apollo is the only source for anything rendered here. A field Apollo did
// not return stays "Not available"; nothing is inferred from the LinkedIn URL,
// which is a manual link for the recruiter and never fetched by this app.
function EmploymentList({ roles }) {
  if (!roles.length) return <Unavailable />;
  return <ul className="plain">
    {roles.map((role, index) => <li key={`${role.organization || 'org'}-${role.title || 'title'}-${index}`}>
      <strong>{valueOrUnavailable(role.organization)}</strong>
      {role.title ? ` — ${role.title}` : ''}
      {(role.startDate || role.endDate) && <span className="dates"> ({role.startDate || NOT_AVAILABLE} to {role.endDate || 'present'})</span>}
    </li>)}
  </ul>;
}

function ContactValue({ value, available, href }) {
  if (value) return <a href={href}>{value}</a>;
  return <span className={available ? 'available' : 'muted'}>{available ? 'Available' : NOT_AVAILABLE}</span>;
}

// One contact line. A real value wins; otherwise the recruiter sees whether
// Apollo says it exists at all, never a fabricated address.
function ContactLine({ label, children }) {
  return <div className="contact-line"><span className="contact-label">{label}</span>{children}</div>;
}

function EnrichedDetails({ candidate, onRefresh, busy, revealing, state }) {
  const history = candidate.employmentHistory || [];
  const current = history.filter((role) => role.current);
  const previous = history.filter((role) => !role.current);
  const skills = candidate.skills || [];
  const departments = candidate.departments || [];
  return <section className="enriched-details" aria-label={`Enriched details for ${valueOrUnavailable(candidate.name)}`}>
    <div className="enriched-head">
      <h4>Enriched Details</h4>
      <div className="enriched-actions">
        <button type="button" className="link-button" onClick={onRefresh} disabled={busy}>
          {busy && !revealing ? 'Refreshing...' : 'Refresh from Apollo'}
        </button>
      </div>
    </div>
    <div className="detail-grid">
      <DetailField label="Location">{candidate.location ? candidate.location : <Unavailable />}</DetailField>
      <DetailField label="Professional headline">{candidate.headline ? candidate.headline : <Unavailable />}</DetailField>
      <DetailField label="Seniority">{candidate.seniority ? candidate.seniority : <Unavailable />}</DetailField>
      <DetailField label="Department">{departments.length ? departments.join(', ') : <Unavailable />}</DetailField>
      <DetailField label="Skills">
        {skills.length ? <ul className="chips">{skills.map((skill) => <li key={skill}>{skill}</li>)}</ul> : <Unavailable />}
      </DetailField>
      <DetailField label="Current employment"><EmploymentList roles={current} /></DetailField>
      <DetailField label="Previous employment"><EmploymentList roles={previous} /></DetailField>
      <DetailField label={emailLabel(candidate)}><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></DetailField>
      {showPersonalLine(candidate) && <DetailField label="Personal email">
        <PersonalEmailStatus candidate={candidate} />
      </DetailField>}
      <DetailField label="Phone"><PhoneStatus candidate={candidate} state={state} /></DetailField>
      <DetailField label="LinkedIn">
        {candidate.linkedinUrl
          ? <a className="linkedin-url" href={candidate.linkedinUrl} target="_blank" rel="noreferrer">{candidate.linkedinUrl}</a>
          : <Unavailable />}
      </DetailField>
    </div>
  </section>;
}

function CandidateBlock({ candidate, selected, selectable, state, expanded, busy, onToggle, onExpand, onRetry, onRefresh }) {
  const name = valueOrUnavailable(candidate.name);
  // The whole row is the checkbox: selecting people is what this table is for,
  // and hunting a 15px box for every one of 25 rows was the slowest thing on
  // the page. Anything inside the row that does its own job - a link, a button,
  // the box itself - is left alone.
  function selectFromRow(event) {
    if (!selectable) return;
    if (event.target.closest('a, button, input, label')) return;
    onToggle();
  }
  return <div className={`candidate-block${selected ? ' is-selected' : ''}`}>
    <article className="candidate-row" onClick={selectFromRow}>
      <label className="check">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={!selectable}
          aria-label={selectable ? `Select ${name}` : 'Cannot select: Apollo returned no person ID for this result'}
        />
        <span />
      </label>
      <div className="identity">
        <strong>{name}</strong>
        <span>{valueOrUnavailable(candidate.title)}</span>
        {(candidate.matchedSkills || []).length > 0 && <ul className="matched-skills">
          {candidate.matchedSkills.map((skill) => <li key={skill}>{skill}</li>)}
        </ul>}
        {/* Only a state worth reporting. "Not enriched" was a column of its own
            saying nothing: it is the state every row starts in. */}
        {state !== NOT_ENRICHED && <span className={`status-badge state-${state}`}>{enrichmentLabel(state)}</span>}
      </div>
      <div data-label="Company">{valueOrUnavailable(candidate.company)}</div>
      <div className="contact" data-label="Contact">
        <ContactLine label={emailLabel(candidate)}><ContactValue value={candidate.email} available={candidate.emailAvailable} href={candidate.email ? `mailto:${candidate.email}` : undefined} /></ContactLine>
        {showPersonalLine(candidate) && <ContactLine label="Personal">
          <PersonalEmailStatus candidate={candidate} />
        </ContactLine>}
        <ContactLine label="Phone"><PhoneStatus candidate={candidate} state={state} /></ContactLine>
        <ContactLine label="LinkedIn">
          {candidate.linkedinUrl
            ? <a href={candidate.linkedinUrl} target="_blank" rel="noreferrer">View LinkedIn Profile</a>
            : <Unavailable />}
        </ContactLine>
      </div>
      <div className="row-actions">
        {state === FAILED && <button type="button" className="link-button" onClick={onRetry} disabled={busy}>Retry</button>}
        {state === ENRICHED && <button
          type="button"
          className="link-button"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} enriched details for ${name}`}
        >{expanded ? 'Hide details' : 'View details'}</button>}
      </div>
    </article>
    {/* Kept open through a reveal so the panel does not vanish under the
        recruiter the moment they click the button inside it. */}
    {expanded && (state === ENRICHED || state === REVEALING || state === REVEALING_PHONE) && candidate.enriched
      && <EnrichedDetails
        candidate={candidate}
        onRefresh={onRefresh}
        busy={busy}
        revealing={state === REVEALING}
        state={state}
      />}
  </div>;
}

function SkeletonRows({ count = 5 }) {
  return <div className="skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index}>
      <span className="bar wide" /><span className="bar" /><span className="bar" /><span className="bar" />
    </div>)}
  </div>;
}

export default function App() {
  const [filters, setFilters] = useState(initialFilters);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [enriched, setEnriched] = useState(new Map());
  const [states, setStates] = useState(new Map());
  const [expanded, setExpanded] = useState(new Set());
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE);
  const [total, setTotal] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState('');
  // Apollo exposes no personal-email signal before a reveal, so this filters
  // what has already come back rather than narrowing the search.
  // Every search asks Apollo for candidates whose address it rates verified or
  // likely to engage. It is not a choice the recruiter has to make: an
  // unreachable candidate cannot be contacted and cannot be revealed, so the
  // wider pool was only ever a way to fill the table with dead ends. The
  // backend still accepts the flag, so widening stays one line away.
  const verifiedEmailOnly = true;
  // Narrows the rows already on screen. Purely local: it sends nothing to
  // Apollo, so it costs nothing and cannot reach past the loaded page.
  const [rowQuery, setRowQuery] = useState('');
  // The name box shows its controls only while it is in use: an idle box is a
  // box, not a toolbar.
  const [nameFocused, setNameFocused] = useState(false);
  // What each query actually returned, so the effect of adding a skill is
  // visible instead of guessed. This is only ever appended to by a search the
  // recruiter asked for; nothing here triggers a request.
  const [refineTrail, setRefineTrail] = useState([]);
  // What Apollo said for each skill on the last search, so the results can say
  // which skills were asked about and how big each one's pool was.
  const [lastSkillTotals, setLastSkillTotals] = useState([]);
  const [matchedAll, setMatchedAll] = useState(false);
  // Whether the next search asks for every skill or any of them. Off by
  // default: "any" finds people, "all" is Apollo's AND and finds almost nobody.
  const [matchAllSkills, setMatchAllSkills] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // What is committed lives in `filters` and goes to Apollo; what is still
  // being typed lives here and does not, until something commits it. Keeping
  // the two apart is what lets a chip list be a list rather than a string of
  // punctuation the recruiter has to edit by hand.
  const [drafts, setDrafts] = useState(NO_DRAFTS);
  const roleFieldRef = useRef(null);
  const skillFieldRef = useRef(null);

  function updateFilter(event) { setFilters({ ...filters, [event.target.name]: event.target.value }); }

  function committedValues(field) { return splitList(filters[field]); }

  // Every filter applies the moment it is committed - a role picked, a chip
  // added or dropped, a level chosen - which is why there is no Search button
  // to forget. Typing alone never sends a request: Apollo bills per search, so
  // a half-typed word must not become one.
  //
  // The new filters are passed to search() as overrides because React has not
  // re-rendered yet, so reading them back off state here would send the
  // previous value.
  function applyFilters(next, pending = drafts, fields = INCIDENTAL_DRAFT_FIELDS) {
    // Whatever is still in a box joins the filters it was typed beside: a skill
    // typed but never entered is one the recruiter plainly meant to search on,
    // so it is committed here rather than quietly dropped. `fields` says which
    // boxes that applies to - see INCIDENTAL_DRAFT_FIELDS.
    const merged = { ...next };
    for (const field of fields) {
      const draft = (pending[field] || '').trim();
      if (draft) merged[field] = splitList(`${merged[field]}, ${draft}`).join(', ');
    }
    // A name filter describes one person and these filters describe a pool, so
    // committing a pool filter drops it rather than silently ANDing the two.
    // It is cleared from the filters as well as from the search: leaving it set
    // showed the un-named pool under a `Named "X"` banner, and made Next re-apply
    // the name, so page 2 answered a different query than page 1.
    setFilters({ ...merged, personName: '' });
    setDrafts(NO_DRAFTS);
    setRowQuery('');
    search(1, { ...merged, personName: '' });
  }

  function draftValue(field) { return drafts[field]; }

  // Typing alone commits nothing and searches nothing - except at a comma,
  // which is how a list is written: everything before the last one becomes a
  // chip, so a pasted "Hyderabad, Bangalore, Pune" turns into the three values
  // it describes rather than sitting there as punctuation.
  function setDraft(field, text) {
    const cut = text.lastIndexOf(',');
    if (cut === -1) return setDrafts({ ...drafts, [field]: text });
    setFilters({ ...filters, [field]: splitList(`${filters[field]}, ${text.slice(0, cut)}`).join(', ') });
    setDrafts({ ...drafts, [field]: text.slice(cut + 1).replace(/^\s+/, '') });
  }

  // Enter in a box: commit whatever is in it - in either box - and search on
  // the result.
  // Enter in a filter box: an explicit commit, so every box's draft counts -
  // including Location, which is the only way to add a city the list does not
  // already offer.
  function commitDraft() {
    applyFilters({ ...filters }, drafts, MULTI_VALUE_FIELDS);
  }

  // A value picked from the list, which replaces whatever was half-typed in
  // that box rather than committing both.
  function addValue(field, rawValue) {
    const value = rawValue.trim();
    if (!value) return;
    applyFilters(
      { ...filters, [field]: splitList(`${filters[field]}, ${value}`).join(', ') },
      { ...drafts, [field]: '' }
    );
  }

  // Promotes what is typed in the results box into Apollo's own name filter, so
  // the search covers every page instead of the one in hand. It is an explicit
  // action rather than something typing triggers: each one is a real request.
  function searchWholePoolByName() {
    const personName = rowQuery.trim();
    // The same name is the search already on screen.
    if (!personName || personName === filters.personName) return;
    setFilters({ ...filters, personName });
    search(1, { personName });
  }

  // The cross inside the box. It clears what was typed, and - if that name is
  // the filter Apollo is currently applying - drops the filter too, which is a
  // search back to the pool the recruiter was looking at before.
  function clearNameBox() {
    if (filters.personName) return clearNameFilter();
    setRowQuery('');
  }

  function clearNameFilter() {
    setRowQuery('');
    setFilters({ ...filters, personName: '' });
    search(1, { personName: '' });
  }

  // One role is the normal case, so a pick replaces the field rather than
  // adding to it. Several titles still work by typing them with commas, which
  // Apollo ORs - the picker just does not build that list for you.
  function chooseRole(role) {
    setRolesOpen(false);
    applyFilters({ ...filters, jobTitle: role });
  }

  // Enter in the role box searches on whatever has been typed, so a title
  // Apollo knows but the picker does not suggest is still one keystroke away.
  function commitRole() {
    setRolesOpen(false);
    commitDraft();
  }

  // The pool as it stands, before anything has been asked of it. Runs once:
  // the ref survives the double-invoke React does in development, which would
  // otherwise open the app with two identical requests.
  const openedRef = useRef(false);
  // Which search is the newest. Compared after every await so a slow answer
  // cannot overwrite a faster one sent later.
  const searchTicket = useRef(0);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    search(1, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!rolesOpen && !skillsOpen) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!roleFieldRef.current?.contains(event.target)) setRolesOpen(false);
      if (!skillFieldRef.current?.contains(event.target)) setSkillsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [rolesOpen, skillsOpen]);

  // Skills do accumulate, unlike the role: a search asks about several of them,
  // and each one is its own Apollo request.
  // Picking a skill finishes that skill: the list closes and the box gives up
  // focus, so the picker does not spring straight back open over the chip that
  // was just added. Clicking the box again starts the next one.
  function chooseSkill(skill, event) {
    setSkillsOpen(false);
    event?.currentTarget?.closest('.filter-block')?.querySelector('input')?.blur();
    addValue('keywords', skill);
  }

  // A location or a level is held as the same comma-separated text as the rest,
  // so ticking one is adding a value and unticking it is removing one.
  function toggleValue(field, value) {
    const current = splitList(filters[field]);
    const kept = current.filter((entry) => entry.toLowerCase() !== value.toLowerCase());
    const next = kept.length === current.length ? [...current, value] : kept;
    applyFilters({ ...filters, [field]: next.join(', ') });
  }

  // Drops one location and leaves the others alone. Locations are held as the
  // text the recruiter typed, so this rewrites that text rather than a list.
  // Drops one value from a comma-separated field and leaves the rest alone.
  // Both multi-value fields are held as the text the recruiter typed, so this
  // rewrites that text rather than a list.
  function removeValue(field, value) {
    const kept = splitList(filters[field]).filter((entry) => entry !== value);
    // Dropping a filter is as much a change of question as adding one, so it
    // re-runs the search instead of leaving the old rows under new chips.
    applyFilters({ ...filters, [field]: kept.join(', ') });
  }

  function resetFilters() {
    setFilters(initialFilters);
    setDrafts(NO_DRAFTS);
    setRefineTrail([]);
  }

  function toggle(id) { const next = new Set(selected); next.has(id) ? next.delete(id) : next.add(id); setSelected(next); }
  // Every row on the page, with whatever enrichment has come back merged in.
  // Nothing is hidden locally: the name box asks Apollo about the whole filtered
  // pool, so hiding rows here as well would have thrown away the answer.
  function shownList() {
    return candidates.map((candidate) => (candidate.id && enriched.get(candidate.id)) || candidate);
  }

  function clearSelection() { setSelected(new Set()); }
  function toggleExpanded(id) {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  }

  // Search behavior is unchanged: it never enriches, and it never touches
  // anything but our own backend.
  //
  // The one retry here is deliberately limited to search. A dev-server restart
  // drops whatever request is in flight, and search is free and repeatable, so
  // retrying it silently is strictly better than showing an error the recruiter
  // can only answer by clicking the same button again. Enrich and reveal must
  // never do this: a dropped connection does not prove Apollo went unasked, so
  // an automatic retry there could pay for the same candidate twice.
  // What a search actually asks Apollo for.
  //
  // A name search is deliberately not narrowed by the pool filters. Looking
  // someone up by name is a different question from describing a pool, and
  // ANDing a role, a location and a skill onto it is exactly what made a real
  // name return nothing. So a name goes to Apollo on its own, the way a name
  // search anywhere else behaves.
  function queryFor(overrides = {}) {
    const personName = overrides.personName !== undefined ? overrides.personName : filters.personName;
    if (personName) {
      // Location is dropped, and only location. Measured against the live API:
      // a name alone returns tens of thousands of people in unrelated roles,
      // role and skills narrow that to a handful of real matches, and adding
      // location takes it to nothing - because Apollo returns no location on a
      // search row, so a name filtered by one matches almost no record it has.
      return { ...filters, ...overrides, location: '', personName };
    }
    return { ...filters, ...overrides, personName: '' };
  }

  // `overrides` carries a filter the recruiter changed in the same click.
  // React has not re-rendered yet at that point, so reading it from state here
  // would send the previous value.
  async function search(nextPage = 1, overrides = {}, matchAll = matchAllSkills) {
    // Every filter change fires a search, and Apollo does not answer them in
    // the order they were sent. Without this, two quick chip toggles could land
    // out of order and leave the table and the pool count showing the older
    // query. Only the newest search may write to the screen; the rest still run
    // to completion (they are already paid for) but their answers are dropped.
    const ticket = ++searchTicket.current;
    const current = () => searchTicket.current === ticket;

    setLoading('search'); setStatus(null); setPage(nextPage);
    const query = queryFor(overrides);
    const keywords = query.keywords;
    const send = () => fetch('/api/candidates/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...query, page: nextPage, verifiedEmailOnly, matchAllSkills: matchAll })
    });
    try {
      let response = await send();
      for (const delay of RESTART_RETRY_DELAYS_MS) {
        if (response.status !== 503 || !(await peekUnreachable(response))) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        response = await send();
      }
      const data = await readJson(response);
      if (!current()) return;
      setCandidates(data.candidates); setTotal(data.total); setSelected(new Set());
      // Rows the backend served from our own store are already enriched: the
      // credit was spent on a previous search, so the details open without
      // asking for it again.
      const known = data.candidates.filter((candidate) => candidate.enriched && candidate.id);
      if (known.length) {
        setEnriched((previous) => {
          const next = new Map(previous);
          for (const candidate of known) next.set(candidate.id, mergeCandidate(next.get(candidate.id), candidate));
          return next;
        });
        setStates((previous) => markState(previous, known.map((candidate) => candidate.id), ENRICHED));
      }
      setPerPage(data.perPage || DEFAULT_PER_PAGE);
      setLastSkillTotals(data.skillTotals || []);
      setMatchedAll(data.matchedAllSkills === true);
      // Recorded so the recruiter can see which term narrowed the pool and by
      // how much, rather than having to remember the last count.
      const total = typeof data.total === 'number' ? data.total : data.candidates.length;
      // Only pool searches belong here: the trail is a record of narrowing by
      // skill, which a name search does not do. Repeating the same query is not
      // new information either, so an identical entry replaces the last one.
      if (!query.personName) {
        // Recorded with the filters that distinguish it: the same keywords at a
        // different seniority or email scope is a different query, and showing
        // both as bare keywords made the trail read as a contradiction.
        const entry = { keywords, seniority: query.seniority, total };
        setRefineTrail((previous) => {
          const last = previous[previous.length - 1];
          if (last && last.keywords === entry.keywords && last.seniority === entry.seniority
            && last.total === entry.total) return previous;
          return [...previous, entry].slice(-REFINE_TRAIL_LENGTH);
        });
      }

      if (!data.candidates.length) {
        // Apollo requires every keyword to match, so an empty pool after two or
        // more skills is almost always one skill too many rather than a
        // genuinely empty market. Say which, and what to do about it.
        const terms = keywords.split(/\s+/).filter(Boolean);
        const lastHit = [...refineTrail].reverse().find((entry) => entry.total > 0);
        setStatus({
          type: 'info',
          // A name filter that finds nobody is its own answer, and blaming the
          // keywords for it would send the recruiter after the wrong thing.
          // A name search finding nothing has two quite different causes, and
          // pointing at the wrong one sends the recruiter after the wrong fix.
          text: query.personName
            ? nameNarrowedBy
              ? `Nobody named "${query.personName}" matches your ${nameNarrowedBy}. Clear a filter and search the name again, or try a different spelling.`
              : `Apollo has nobody by the name "${query.personName}". Try a different spelling, or just the first or last name on its own.`
            : terms.length > 1
              ? `No candidates match all ${terms.length} keywords at once - Apollo requires every one of them. ${lastHit ? `"${lastHit.keywords}" matched ${lastHit.total.toLocaleString()}. ` : ''}Turn a skill off and search again.`
              : 'No matching candidates found.'
        });
      }
    } catch (error) {
      if (current()) setStatus({ type: 'error', text: error.message || 'Unable to connect to Apollo. Please try again.' });
    } finally {
      // A superseded search must not clear the spinner the newer one set.
      if (current()) setLoading('');
    }
  }

  // Enter anywhere in the filter form. Every field commits its own value on
  // Enter, so this only has to catch the case where nothing did.
  function submitSearch(event) {
    event.preventDefault();
    applyFilters({ ...filters, personName: '' });
  }

  // Switching between "any of these skills" and "all of them" is a different
  // question about the same filters, so it re-runs the search on the value it
  // just set rather than the one React has yet to apply.
  function toggleMatchAllSkills() {
    const next = !matchAllSkills;
    setMatchAllSkills(next);
    // Same reason as applyFilters: this searches the pool, so the name filter is
    // dropped from the state it is displayed from, not only from the request.
    setFilters((previous) => ({ ...previous, personName: '' }));
    setRowQuery('');
    search(1, { personName: '' }, next);
  }

  // Enrich and reveal post the same body to backend routes that answer in the
  // same shape. They differ in the state a row shows while in flight and, on
  // the backend, in whether Apollo was asked to spend credits on contact data.
  async function runEnrichment({ path, requested, busyKey, inFlightState, summarize, failureText, restoreOnError = false, notice = '', refresh = false }) {
    const before = new Map(requested.map((id) => [id, stateOf(states, id)]));
    setStates((previous) => markState(previous, requested, inFlightState));
    setLoading(busyKey); setStatus(null);
    try {
      // `refresh` is what "Refresh from Apollo" sends: it buys a new copy
      // instead of being handed the one already stored.
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested, refresh }) });
      const data = await readJson(response);
      // Applied as functional updates so an overlapping retry cannot reconcile
      // against a stale snapshot and discard an earlier result.
      const outcome = reconcile(data.requestedIds || requested, data);
      setStates((previous) => applyStates(previous, outcome));
      // The backend says whether this response came from a request that asked
      // Apollo for contact data, so the filter can trust it later.
      setEnriched((previous) => applyEnriched(previous, outcome, { contactRevealed: data.revealedPersonalEmails === true }));
      // Open what we just enriched: the recruiter asked for this data, so do
      // not make them click again to see it.
      setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
      setStatus({ type: outcome.failed ? 'info' : 'success', text: [notice, summarize(outcome)].filter(Boolean).join(' ') });
    } catch (error) {
      // An exhausted credit balance is not the candidate's failure: nothing was
      // asked of Apollo, so the rows must not be left showing Retry for
      // something that cannot succeed until the account is topped up.
      const restore = restoreOnError || error.code === 'APOLLO_CREDITS_EXHAUSTED';
      setStates((previous) => (restore
        // A reveal that never reached Apollo must not erase what the row
        // already showed, so each candidate goes back the way it was.
        ? new Map([...previous, ...before])
        // The request never completed, so these stay retryable rather than
        // being recorded as answered by Apollo.
        : markState(previous, requested, FAILED)));
      setStatus({ type: 'error', text: error.message || failureText });
    } finally { setLoading(''); }
  }

  async function enrich(explicitIds, { refresh = false } = {}) {
    const requested = idsToEnrich(explicitIds || [...selected], states, { refresh });
    if (!requested.length) {
      return setStatus({ type: 'info', text: 'Every selected candidate is already enriched. Use Refresh from Apollo to fetch it again.' });
    }
    return runEnrichment({
      path: '/api/candidates/enrich', requested, busyKey: 'enrich', inFlightState: ENRICHING,
      summarize: enrichmentSummary, failureText: 'Unable to enrich this candidate.', refresh
    });
  }

  // Asks Apollo for phone numbers. The dearest thing this app can spend, so it
  // works out who would actually be charged for and then asks; nothing reaches
  // Apollo until the recruiter confirms below.
  function revealPhones(explicitIds, { refresh = false } = {}) {
    const ids = explicitIds || [...selected];
    const asked = idsToRevealPhone(ids, states, enriched, { refresh });
    // Apollo told us free, in the search response, that it holds no number for
    // these. Asking would return nothing and a mobile credit is the dearest
    // thing here, so they are dropped and the recruiter is told.
    const byId = new Map(shownList().map((candidate) => [candidate.requestedId || candidate.id, candidate]));
    const eligible = refresh
      ? asked.filter((id) => (enriched.get(id) || byId.get(id))?.hasPhoneOnFile !== false)
      : phoneWorthAsking(ids);
    const noneOnFile = asked.length - eligible.length;
    if (!eligible.length && noneOnFile) {
      return setStatus({
        type: 'info',
        text: `Apollo holds no phone number for ${noneOnFile === 1 ? 'that candidate' : `those ${noneOnFile} candidates`}, so asking would return nothing and no credit was spent.`
      });
    }
    if (!eligible.length) {
      const alreadyHave = ids.filter((id) => enriched.get(id)?.phone).length;
      const alreadyAsked = ids.filter((id) => enriched.get(id)?.phoneChecked && !enriched.get(id)?.phone).length;
      return setStatus({
        type: 'info',
        text: !ids.length
          ? 'Select at least one candidate to reveal a phone number for.'
          : alreadyHave
            ? `A number is already on screen for ${alreadyHave === 1 ? 'that candidate' : `those ${alreadyHave} candidates`}, so nothing was requested and no credit was spent.`
            : alreadyAsked
              ? `Apollo has already been asked for ${alreadyAsked === 1 ? 'that candidate' : `those ${alreadyAsked} candidates`} and holds no number, so nothing was requested again.`
              : 'Nothing to request.'
      });
    }
    return runPhoneReveal(eligible.slice(0, PHONE_LIMIT), noneOnFile
      ? `${noneOnFile} selected candidate${noneOnFile === 1 ? ' has' : 's have'} no phone number on file at Apollo and ${noneOnFile === 1 ? 'was' : 'were'} left out, so no credit is wasted on ${noneOnFile === 1 ? 'it' : 'them'}.`
      : '', refresh);
  }

  // Sends the phone request. Separate from the confirmation above so the email
  // reveal can run it as part of the same confirmed action.
  async function runPhoneReveal(requested, notice = '', refresh = false) {
    if (!requested.length) return;

    // A phone reveal does not enrich anybody: it asks one question and answers
    // it. So each row goes back to the state it was in, whether the request
    // succeeds, finds nothing, or never reaches Apollo - claiming "enriched"
    // for a candidate nobody enriched would be a plain falsehood.
    const before = new Map(requested.map((id) => [id, stateOf(states, id)]));
    setStates((previous) => markState(previous, requested, REVEALING_PHONE));
    setLoading('phone'); setStatus(null);
    try {
      const data = await readJson(await fetch('/api/candidates/phone', {
        // refresh is forwarded: without it the route's cache bypass was
        // unreachable, so a stale stored number could never be bought again and
        // "Found 1 phone number" was reported over the same old value.
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: requested, refresh })
      }));

      // Whatever Apollo already held arrives at once; show it rather than
      // making the recruiter wait on the slow half for data already in hand.
      const immediate = reconcile(data.requestedIds || requested, { candidates: data.candidates, skippedIds: data.skippedIds });
      setEnriched((previous) => applyWaterfall(previous, immediate, {
        baseById: baseCandidateMap(), mark: { phoneChecked: true }
      }));
      setExpanded((previous) => new Set([...previous, ...immediate.matchedIds]));

      // Numbers that needed no job at all: served from the cache, or held by
      // Apollo and returned on the spot. They are already on the rows, so the
      // summary must count them or it reports "none found" over a visible number.
      const alreadyFound = [...immediate.candidatesByKey.values()].filter((candidate) => candidate.phone).length;
      const stillComing = (data.requests || []).length;

      if (stillComing) {
        setStatus({ type: 'info', text: [notice, `Asking Apollo for ${requested.length} phone number${requested.length === 1 ? '' : 's'}. Numbers arrive here as Apollo returns them.`].filter(Boolean).join(' ') });
      }
      await collectAsyncJobs(data.requests || [], { kind: 'phone', before, notice, alreadyFound });
    } catch (error) {
      setStates((previous) => new Map([...previous, ...before]));
      setStatus({ type: 'error', text: error.message || 'Unable to reveal phone numbers.' });
    } finally { setLoading(''); }
  }

  // What an asynchronous job needs beyond the polling itself. Phone is the only
  // one now: the email waterfall had a button here and it was removed, because
  // Apollo stops the waterfall as soon as its own step finds an address, so for
  // anyone with a work email on file it never reached the third-party vendors
  // and only ever returned what a plain reveal already gives.
  const ASYNC_JOBS = {
    phone: {
      mark: { phoneChecked: true },
      // What counts as this job having found something for a candidate.
      found: (candidate) => Boolean(candidate.phone),
      readFailure: 'Unable to read the phone result.',
      foundText: (n) => `Found ${n} phone number${n === 1 ? '' : 's'}.`,
      expiredText: (n) => `Apollo could not return ${n === 1 ? 'the result' : `${n} of the results`} for this request, so it is unknown whether a number was found. Try again before spending more.`,
      stillRunningText: 'Apollo is still working on this. Numbers were not ready in time; try again shortly.',
      emptyText: 'Apollo holds no phone number for these candidates.'
    }
  };

  // Polls each outstanding asynchronous job. Polling costs no credits, so the
  // only cost of waiting is time.
  async function collectAsyncJobs(requests, { kind, before = new Map(), notice = '', alreadyFound = 0 }) {
    const job_ = ASYNC_JOBS[kind];
    const deadline = Date.now() + WATERFALL_MAX_WAIT_MS;
    const outstanding = [...requests];
    const baseById = baseCandidateMap();
    let found = 0;
    let expired = 0;
    // Why the loop stopped early, if it did. Reported ahead of any summary: not
    // knowing an answer is a different thing from knowing there is none.
    let readError = '';
    // Jobs Apollo charged for whose answer never reached the webhook. Kept
    // apart from `expired`: Apollo finished these, so retrying spends again.
    const undelivered = [];

    while (outstanding.length && Date.now() < deadline) {
      const job = outstanding.shift();
      let result;
      try {
        result = await readJson(await fetch(`/api/candidates/waterfall/${encodeURIComponent(job.requestId)}`));
      } catch (error) {
        // Kept rather than set here: the summary below runs on every exit from
        // this loop, and setting it now only to be overwritten there is how the
        // real error used to be replaced by "Apollo holds no number".
        readError = error.message || job_.readFailure;
        break;
      }

      if (result.status === 'pending') {
        outstanding.push(job);
        await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number(result.retryAfterSeconds) || 10) * 1000));
        continue;
      }
      if (result.status === 'ready') {
        const shortfall = deliveryShortfall(result, { kind });
        // A job whose answer was lost in transit is not an answer about anybody,
        // so the record is stripped of the flags that claim it is one. Clearing
        // the mark alone was not enough: the server sets those flags on the
        // record itself, and the merge carried them in regardless.
        const answered = shortfall
          ? result.candidates.map(withoutAnswerFlags)
          : result.candidates;
        const outcome = reconcile(job.ids, { candidates: answered, skippedIds: [] });
        setEnriched((previous) => applyWaterfall(previous, outcome, shortfall
          ? { baseById, checkedIds: [], mark: {} }
          : { baseById, checkedIds: job.ids, mark: job_.mark }));
        setExpanded((previous) => new Set([...previous, ...outcome.matchedIds]));
        if (shortfall) undelivered.push(shortfall);
        found += result.candidates.filter(job_.found).length;
      }
      if (result.status === 'expired') expired += 1;
    }

    setStates((previous) => new Map([...previous, ...before]));
    // Reported even alongside numbers that did arrive: a partial delivery still
    // means the account paid for answers it never received.
    const lost = undelivered.length ? deliveryShortfallMessage(undelivered, { kind }) : '';
    // Anything already on screen for these people counts as found, whether it
    // came from this poll or was served from the cache without a job at all.
    // Without this, a fully cached answer reported "none found" with the
    // numbers visible on the rows.
    found += alreadyFound;
    if (readError) {
      setStatus({ type: 'error', text: [notice, readError].filter(Boolean).join(' ') });
    } else if (found) {
      setStatus({
        type: lost ? 'error' : 'success',
        text: [notice, job_.foundText(found), lost].filter(Boolean).join(' ')
      });
    } else if (lost) {
      setStatus({ type: 'error', text: [notice, lost].filter(Boolean).join(' ') });
    } else if (expired) {
      setStatus({ type: 'error', text: job_.expiredText(expired) });
    } else if (outstanding.length) {
      setStatus({ type: 'info', text: job_.stillRunningText });
    } else {
      setStatus({ type: 'info', text: [notice, job_.emptyText].filter(Boolean).join(' ') });
    }
  }

  // What each row already shows, so a sparse asynchronous answer is merged over
  // the record rather than replacing it with a husk.
  function baseCandidateMap() {
    return new Map(candidates
      .map((candidate) => [candidate.requestedId || candidate.id, candidate])
      .filter(([key]) => key));
  }

  // The subset of a selection a phone request should actually be spent on:
  // nobody already holding a number, nobody Apollo has already answered for,
  // and nobody Apollo said outright it has no number for.
  function phoneWorthAsking(ids) {
    const known = new Map(shownList().map((candidate) => [candidate.requestedId || candidate.id, candidate]));
    return idsToRevealPhone(ids, states, enriched, { refresh: false })
      .filter((id) => (enriched.get(id) || known.get(id))?.hasPhoneOnFile !== false);
  }

  const mergedCandidates = shownList();
  const visibleCandidates = mergedCandidates;
  const totalPages = total !== null && perPage ? Math.max(1, Math.ceil(total / perPage)) : null;
  const searching = loading === 'search';
  // Every enabled term, plus what is still uncommitted in the box. Joined with
  // spaces because that is how Apollo reads them: one pool that matches all of
  // them, not one per term.
  // Cities Apollo actually returned for the pool on screen, most common first,
  // so the picker offers places that exist in this result rather than a guessed
  // list. Apollo writes a location as "Hyderabad, Telangana, India" and only
  // the city is worth filtering on, so the first part is what is offered.
  const locationCounts = new Map();
  for (const candidate of mergedCandidates) {
    const city = (candidate.location || '').split(',')[0].trim();
    if (city) locationCounts.set(city, (locationCounts.get(city) || 0) + 1);
  }
  const chosenLocations = splitList(filters.location).map((value) => value.toLowerCase());
  const chosenSeniorities = splitList(filters.seniority);
  // Every city the results hold, plus any already ticked - a city must not
  // vanish from the list because the search it produced no longer returns it,
  // or there would be no way to untick it.
  // Ticked cities lead, so one can always be unticked; then the cities these
  // results actually named, commonest first; then the standing list. Each city
  // appears once, however many of those three it came from.
  const seenCities = new Set();
  const locationOptions = [
    ...splitList(filters.location).map((city) => [city, locationCounts.get(city) ?? null]),
    ...[...locationCounts.entries()].sort((a, b) => b[1] - a[1]),
    ...LOCATION_SUGGESTIONS.map((city) => [city, null])
  ].filter(([city]) => {
    const key = city.toLowerCase();
    if (seenCities.has(key)) return false;
    seenCities.add(key);
    return true;
  });
  const locationQuery = draftValue('location').trim().toLowerCase();
  const visibleLocations = locationOptions.filter(([city]) => !locationQuery
    || chosenLocations.includes(city.toLowerCase())
    || city.toLowerCase().includes(locationQuery));
  const anyFilterSet = Object.values(filters).some((value) => value.trim() !== '');
  // What the two spending buttons would cost right now. Shown on the buttons
  // themselves, so the figure that used to need a confirmation dialog is
  // simply on screen.
  // Only the titles that match what is being typed, and never one already
  // chosen, so the list shortens as the recruiter narrows instead of staying a
  // wall of twenty-two.
  const typedRole = filters.jobTitle.split(',').pop().trim().toLowerCase();
  // A field holding exactly one of the suggestions means a role was picked, not
  // typed, so the whole list comes back: filtering it down to the single title
  // already chosen left no way to browse to a different one.
  const rolePicked = ROLE_SUGGESTIONS.some((role) => role.toLowerCase() === typedRole);
  // Skills suggested for the roles actually chosen, in the order the roles were
  // given, so a search for two roles offers both their skills.
  const roleSkills = [...new Set(splitList(filters.jobTitle)
    .flatMap((role) => SKILLS_BY_ROLE[role.trim().toLowerCase()] || []))];
  const typedSkill = draftValue('keywords').trim().toLowerCase();
  const chosenSkills = committedValues('keywords').map((skill) => skill.toLowerCase());
  const skillMatches = (roleSkills.length ? roleSkills : COMMON_SKILLS)
    .filter((skill) => !chosenSkills.includes(skill.toLowerCase()))
    .filter((skill) => !typedSkill || skill.toLowerCase().includes(typedSkill));
  const roleMatches = ROLE_SUGGESTIONS
    .filter((role) => !typedRole || rolePicked || role.toLowerCase().includes(typedRole));

  const selectedIds = [...selected];
  const phoneIds = phoneWorthAsking(selectedIds).slice(0, PHONE_LIMIT);
  const phoneConfirmed = phoneIds.filter((id) => {
    const known = candidates.find((candidate) => (candidate.requestedId || candidate.id) === id);
    return (enriched.get(id) || known)?.hasPhoneOnFile === true;
  }).length;
  // The pool filters that currently hold a value, named for the copy below so
  // it can say what a name search is being narrowed by instead of guessing.
  const activeFilterLabels = [['jobTitle', 'role'], ['location', 'location'], ['seniority', 'seniority']]
    .filter(([key]) => filters[key].trim() !== '').map(([, label]) => label);
  if (filters.keywords.trim()) activeFilterLabels.push('skills');
  const narrowedBy = activeFilterLabels.join(', ').replace(/, ([^,]*)$/, ' and $1');
  // A name search never applies location, so the copy must not claim it does.
  const nameNarrowedBy = activeFilterLabels.filter((label) => label !== 'location')
    .join(', ').replace(/, ([^,]*)$/, ' and $1');
  const skillTotals = lastSkillTotals;
  // How big the pool is, stated once. Apollo gives no single total for a union
  // of several skill searches, so that case says what it can rather than
  // inventing a number.
  const poolSize = total !== null
    ? `${total.toLocaleString()} profile${total === 1 ? '' : 's'}`
    : skillTotals.length > 1
      ? `${candidates.length} matching any of ${skillTotals.length} skills`
      : `${candidates.length} profile${candidates.length === 1 ? '' : 's'}`;

  return <div className="app">
    <header className="topbar">
      {/* Swap the logo by replacing public/neutara-logo.svg - no code change. */}
      <img className="mark" src="/neutara-mark.svg" alt="neutara" width="32" height="44" />
      {/* The product name leads and the tagline sits under it, so the pair reads
          as one block against the mark rather than two stacked labels. */}
      <div className="brand"><h1>QuickHire</h1><p className="tagline">The fastest way to find who you need.</p></div>
      <p className="secure"><span className="dot" /> Apollo connected</p>
    </header>

    {/* Filters left, results right: the filters are the thing a recruiter keeps
        adjusting, so they stay on screen instead of scrolling away above the
        rows they change. */}
    <div className="workspace">
      <aside className="sidebar" aria-label="Search filters">
        <div className="sidebar-head">
          <h2>Filters</h2>
          <button type="button" className="link-button" onClick={resetFilters} disabled={!anyFilterSet}>Reset all</button>
        </div>

        {/* The form element is here so Enter behaves, not as a step the
            recruiter has to take: there is no submit button to press. */}
        <form className="filter-form" onSubmit={submitSearch}>
          <div className="filter-block" ref={roleFieldRef}>
            <label htmlFor="field-jobTitle">Role / Job Title</label>
            <div className="control">
              <input
                id="field-jobTitle"
                name="jobTitle"
                value={filters.jobTitle}
                onChange={updateFilter}
                onFocus={() => setRolesOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRolesOpen(false);
                  if (event.key === 'Enter') { event.preventDefault(); commitRole(); }
                }}
                placeholder="e.g. Data Scientist"
                autoComplete="off"
                role="combobox"
                aria-expanded={rolesOpen}
                aria-controls="role-suggestions"
              />
              <button
                type="button"
                className="control-toggle"
                aria-label={rolesOpen ? 'Hide suggested roles' : 'Show suggested roles'}
                aria-expanded={rolesOpen}
                onClick={() => setRolesOpen(!rolesOpen)}
              >&#9662;</button>
            </div>
            {rolesOpen && roleMatches.length > 0 && <ul className="picker role-list" id="role-suggestions" role="listbox">
              {roleMatches.map((role) => <li key={role}>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  // Chosen on mousedown: a click would blur the field and close
                  // the list before the selection landed.
                  onMouseDown={(event) => { event.preventDefault(); chooseRole(role); }}
                >{role}</button>
              </li>)}
            </ul>}
          </div>

          {/* Location narrows a search rather than starting one, so the role
              runs first and this list is how the pool gets cut down. The box
              does both jobs a short list needs: it filters the list as you
              type, and Enter adds a city the list does not hold - which is the
              only way in for one, because Apollo cannot tell us which cities a
              pool contains and returns no location on a search row at all. */}
          <div className="filter-block">
            <span className="block-label" id="location-label">Location</span>
            <input
              className="option-search"
              id="field-location"
              name="location"
              value={draftValue('location')}
              onChange={(event) => setDraft('location', event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitDraft(); } }}
              placeholder="Search or add a city"
              aria-label="Search or add a city"
              autoComplete="off"
            />
            <ul className="option-list location-options" role="group" aria-labelledby="location-label">
              {visibleLocations.map(([city, count]) => <li key={city}>
                <label className="option">
                  <input
                    type="checkbox"
                    checked={chosenLocations.includes(city.toLowerCase())}
                    onChange={() => toggleValue('location', city)}
                  />
                  <span className="option-name">{city}</span>
                  {count !== null && <em className="facet-count">{count}</em>}
                </label>
              </li>)}
            </ul>
            {/* A city nobody listed is not a dead end, so the way to add it is
                on screen at the moment it is needed. */}
            {locationQuery && !visibleLocations.some(([city]) => city.toLowerCase() === locationQuery)
              && <p className="filter-note">Press Enter to add &ldquo;{draftValue('location').trim()}&rdquo;.</p>}
            {/* Apollo ORs locations, so the honest description of two cities is
                a wider search rather than a narrower one. */}
            {chosenLocations.length > 1 && <p className="filter-note">Candidates in any of these cities.</p>}
          </div>

          <div className="filter-block" ref={skillFieldRef}>
            <label htmlFor="field-keywords">Skills</label>
            <div className="control">
              <input
                id="field-keywords"
                name="keywords"
                value={draftValue('keywords')}
                onChange={(event) => setDraft('keywords', event.target.value)}
                onFocus={() => setSkillsOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSkillsOpen(false);
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setSkillsOpen(false);
                    commitDraft();
                  }
                }}
                placeholder="One skill, then Enter"
                autoComplete="off"
                role="combobox"
                aria-expanded={skillsOpen}
                aria-controls="skill-suggestions"
              />
              <button
                type="button"
                className="control-toggle"
                aria-label={skillsOpen ? 'Hide suggested skills' : 'Show suggested skills'}
                aria-expanded={skillsOpen}
                onClick={() => setSkillsOpen(!skillsOpen)}
              >&#9662;</button>
            </div>
            {committedValues('keywords').length > 0 && <ul className="chips chips-editable skill-chips">
              {committedValues('keywords').map((value) => <li key={value} className="chip-on">
                <span className="chip-static">{value}</span>
                <button type="button" className="chip-remove" aria-label={`Remove ${value}`} onClick={() => removeValue('keywords', value)}>&times;</button>
              </li>)}
            </ul>}
            {skillsOpen && skillMatches.length > 0 && <ul className="picker" id="skill-suggestions" role="listbox">
              {roleSkills.length > 0 && <li className="picker-note">
                Suggested for {splitList(filters.jobTitle).join(' and ')}
              </li>}
              {skillMatches.map((skill) => <li key={skill}>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  onMouseDown={(event) => { event.preventDefault(); chooseSkill(skill, event); }}
                >{skill}</button>
              </li>)}
            </ul>}
            {/* Apollo can require every keyword at once, which routinely empties
                a pool, so one match is the default and the strict version is a
                deliberate tick rather than where a recruiter lands. */}
            {committedValues('keywords').length > 1 && <label className="filter-toggle skills-mode">
              <input
                type="checkbox"
                checked={matchAllSkills}
                onChange={toggleMatchAllSkills}
              />
              Must have every skill
            </label>}
          </div>

          {/* Levels are an OR at Apollo, and a hire is routinely open to two of
              them, so this is a list of ticks rather than one choice. */}
          <div className="filter-block">
            <span className="block-label" id="seniority-label">Seniority</span>
            <ul className="option-list seniority-options" role="group" aria-labelledby="seniority-label">
              {SENIORITIES.map(([value, label]) => <li key={value}>
                <label className="option">
                  <input
                    type="checkbox"
                    name="seniority"
                    value={value}
                    checked={chosenSeniorities.includes(value)}
                    onChange={() => toggleValue('seniority', value)}
                  />
                  <span className="option-name">{label}</span>
                </label>
              </li>)}
            </ul>
          </div>
        </form>

      </aside>

      <section className="results-pane results">
        <div className="results-head">
          <h3>Candidates</h3>
          <div className="selection-actions">
            <span>Selected: <b>{selected.size}</b></span>
            <button type="button" onClick={clearSelection} disabled={!selected.size}>Clear</button>
            <button type="button" className="reveal" onClick={() => revealPhones()} disabled={!selected.size || Boolean(loading)}>
              {loading === 'phone'
                ? 'Revealing phone...'
                : `Reveal phone${phoneIds.length ? ` - ${phoneIds.length} mobile credit${phoneIds.length === 1 ? '' : 's'}` : ''}`}
            </button>
            <button type="button" className="secondary" onClick={() => enrich()} disabled={!selected.size || Boolean(loading)}>
              {loading === 'enrich' ? 'Enriching selected candidates...' : `Enrich selected${selected.size ? ` (${selected.size})` : ''}`} <span>&#8599;</span>
            </button>
          </div>
        </div>

        {matchedAll && <p className="hint spend-note">
          Every skill was required at once, so each of these candidates has all of{' '}
          <b>{skillTotals[0]?.skill}</b>. Untick the box beside Skills to see candidates who
          have any one of them instead.
        </p>}

        {!matchedAll && skillTotals.length > 1 && <p className="hint spend-note">
          Each skill was searched separately and the answers merged, so a candidate
          needs only one of them. Apollo held{' '}
          {skillTotals.map((entry, index) => <span key={entry.skill}>
            {index > 0 ? ', ' : ''}<b>{(entry.total || 0).toLocaleString()}</b> for {entry.skill}
          </span>)}.
        </p>}

        {/* The one thing a price cannot say: whether Apollo has actually
            committed to holding a number for these people. */}
        {phoneIds.length > 0 && <p className="hint spend-note">
          {phoneConfirmed
            ? `Apollo confirms a direct number for ${phoneConfirmed} of the ${phoneIds.length} selected. Mobile credits cost more than an email.`
            : `Apollo has not confirmed it holds a number for ${phoneIds.length === 1 ? 'the selected candidate' : 'any of the selected candidates'} - revealing may return nothing. Mobile credits cost more than an email.`}
        </p>}

        {(candidates.length > 0 || filters.personName) && <div className="row-search">
          <p className="pool-size">{poolSize}</p>
          <div className="name-search">
            <label className="visually-hidden" htmlFor="row-search">Find a candidate</label>
            <input
              id="row-search"
              type="search"
              value={rowQuery}
              onChange={(event) => setRowQuery(event.target.value)}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              // Enter searches the whole pool by name, because that is what
              // pressing Enter in a search box is expected to do. The button
              // beside it does the same thing for anyone who reaches for one.
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); searchWholePoolByName(); } }}
              placeholder={searching && rowQuery.trim() === filters.personName
                ? 'Searching Apollo...'
                : 'Search by candidate name'}
            />
            {/* Both live inside the box. mousedown is prevented so the field
                does not blur out from under the button being clicked. */}
            {(rowQuery !== '' || filters.personName) && <button
              type="button"
              className="box-button box-clear"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearNameBox}
              disabled={searching}
              aria-label={filters.personName ? 'Clear the name filter' : 'Clear the box'}
            >&times;</button>}
            {(nameFocused || rowQuery !== '') && <button
              type="button"
              className="box-button search-go"
              onMouseDown={(event) => event.preventDefault()}
              onClick={searchWholePoolByName}
              disabled={searching || !rowQuery.trim() || rowQuery.trim() === filters.personName}
              aria-label="Search Apollo for this name"
            >
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
                <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M13.5 13.5 L17.5 17.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>}
          </div>

          {filters.personName && <p className="hint">
            <strong>Named "{filters.personName}"</strong>
            {nameNarrowedBy ? `, matching your ${nameNarrowedBy}` : ' , anywhere in Apollo'}
            {total !== null ? ` - ${total.toLocaleString()} profile${total === 1 ? '' : 's'}.` : '.'}
            {filters.location.trim() ? ' Location is not applied to a name search.' : ''}
          </p>}

          {/* Typing spends nothing, so the box says what pressing Enter will
              actually ask for rather than pretending it has already asked. */}
          {rowQuery.trim() !== '' && rowQuery.trim() !== filters.personName && <p className="hint">
            {nameNarrowedBy
              ? `Press Enter to search every ${nameNarrowedBy} in the pool for "${rowQuery.trim()}".`
              : `Press Enter to search the whole pool for "${rowQuery.trim()}".`}
          </p>}
        </div>}

        {status && <div className={`notice ${status.type}`} role="status" aria-live="polite">{status.text}</div>}

        {searching && !candidates.length && <SkeletonRows />}

        {!searching && !candidates.length && !status && <div className="empty-state">
          <p className="empty-title">No candidates on screen</p>
          <p>Loosen a filter on the left, or drop one, to widen the pool again.</p>
        </div>}

        {candidates.length > 0 && visibleCandidates.length > 0 && <div className="table">
          <div className="table-head"><span /><span>Candidate</span><span>Company</span><span>Contact</span><span /></div>
          {visibleCandidates.map((candidate, index) => {
            const id = candidate.requestedId || candidate.id;
            return <CandidateBlock
              key={id || `row-${index}`}
              candidate={candidate}
              selected={Boolean(id) && selected.has(id)}
              selectable={Boolean(id)}
              state={stateOf(states, id)}
              expanded={expanded.has(id)}
              busy={Boolean(loading)}
              onToggle={() => toggle(id)}
              onExpand={() => toggleExpanded(id)}
              onRetry={() => enrich([id], { refresh: true })}
              onRefresh={() => enrich([id], { refresh: true })}
            />;
          })}
        </div>}

        {candidates.length > 0 && <div className="pagination">
          <button type="button" onClick={() => search(page - 1)} disabled={page <= 1 || searching}>&#8592; Previous</button>
          <span>Page <b>{page}</b>{totalPages ? ` of ${totalPages.toLocaleString()}` : ''}</span>
          <button type="button" onClick={() => search(page + 1)} disabled={searching || (totalPages ? page >= totalPages : candidates.length === 0)}>Next &#8594;</button>
        </div>}
      </section>
    </div>
  </div>;
}

export { NOT_ENRICHED, ENRICHING, ENRICHED, FAILED };
