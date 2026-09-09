# Apollo Candidate Sourcing

## Project Goal

Build a candidate-sourcing application for recruiters using the Apollo API.

Recruiters should be able to search for potential candidates using recruitment criteria, review Apollo-provided professional information, select specific candidates, and enrich only those selected candidates.

The application may display a LinkedIn profile URL when Apollo provides one. It must never directly visit, scrape, crawl, or automate LinkedIn profiles.

## Core User Flow

1. The recruiter opens **Candidate Search**.
2. The recruiter enters search criteria.
3. The application sends the criteria to our backend.
4. The backend calls Apollo's People Search API.
5. The backend normalizes the Apollo response.
6. The application displays candidate results.
7. The recruiter selects one or more candidates.
8. The recruiter clicks **Enrich Selected Candidates**.
9. The backend sends only the selected Apollo Person IDs to Apollo enrichment.
10. The application displays the additional information returned by Apollo.
11. The recruiter may manually open an Apollo-provided LinkedIn URL.

## Search Filters

The search interface should provide:

- Role / Job Title
- Location
- Seniority / Experience
- Skills / Keywords
- Company
- Industry

All filters may be optional, but the interface should support meaningful searches when only some filters are provided.

Example search:

```json
{
  "jobTitle": "Java Developer",
  "location": "Hyderabad, India",
  "seniority": "senior",
  "keywords": "Java Spring Boot",
  "company": "",
  "industry": ""
}
```

## Backend Architecture

The Apollo API must never be called directly from frontend or browser-extension code.

```text
Browser Extension / Frontend
            |
            v
       Our Backend API
            |
            v
          Apollo API
            |
            v
       Our Backend API
            |
            v
Browser Extension / Frontend
```

The Apollo API key must:

- Exist only as a backend environment variable.
- Never be hardcoded in source code.
- Never be included in frontend JavaScript.
- Never be stored in browser local storage.
- Never be returned in an API response.
- Never be logged.

Required environment variable:

```env
APOLLO_API_KEY=your_server_side_apollo_key
```

## Backend Endpoints

### Search Candidates

```http
POST /api/candidates/search
```

Request body:

```json
{
  "jobTitle": "Java Developer",
  "location": "Hyderabad",
  "seniority": "senior",
  "keywords": "Java, Spring Boot",
  "company": "",
  "industry": "",
  "page": 1
}
```

The backend maps the request to Apollo's People Search endpoint:

```http
POST /mixed_people/api_search
```

Supported pagination fields:

- `page`
- `per_page`

Approximate Apollo filter mapping:

| Application filter | Apollo parameter |
|---|---|
| Role / Job Title | `person_titles` |
| Location | `person_locations` |
| Seniority | `person_seniorities` |
| Skills / Keywords | `q_keywords` |
| Company | Apollo organization/company filter |
| Industry | Apollo organization industry filter |

Only parameters supported by the current Apollo API schema should be sent.

### Enrich Candidates

```http
POST /api/candidates/enrich
```

Request body:

```json
{
  "ids": ["apollo-person-id-1", "apollo-person-id-2"]
}
```

The backend sends only explicitly selected Apollo Person IDs to the appropriate Apollo People Enrichment or Bulk Match endpoint, such as:

```http
POST /people/bulk_match
```

The application must not automatically enrich every search result.

## Candidate Results

Each result should display only information returned by Apollo:

- Candidate name
- Job title
- Company
- Location
- Apollo Person ID, where appropriate
- LinkedIn profile URL, if available
- Email availability
- Phone availability
- Employment history, if returned
- Other Apollo-provided professional information

Missing fields must display:

```text
Not available
```

The application must not guess, reconstruct, or fabricate missing information.

## Candidate Selection

Each candidate must have a checkbox or selection control.

Required controls:

- Select All
- Clear Selection
- Selected candidate count
- Enrich Selected Candidates

Enrichment must only use candidates explicitly selected by the recruiter.

Duplicate enrichment requests should be prevented where practical, especially for candidates already enriched during the current session.

## LinkedIn Rules

The application may display a LinkedIn URL returned by Apollo:

```text
LinkedIn: https://www.linkedin.com/in/example/
```

The application may provide a normal external link such as:

```text
View LinkedIn Profile
```

The application must not:

- Scrape LinkedIn.
- Crawl LinkedIn.
- Automatically open LinkedIn profiles.
- Send automated requests to LinkedIn.
- Load LinkedIn in hidden iframes.
- Use fake LinkedIn accounts.
- Hide automated activity.
- Bypass LinkedIn restrictions or privacy controls.
- Determine whether a candidate viewed or was notified about activity.
- Claim that a candidate will not know about a recruiter viewing their profile.

The application only displays Apollo-provided information and leaves any profile visit to the recruiter's manual action.

## Response Normalization

Raw Apollo responses must not be exposed directly to the frontend.

The backend should return an application-owned candidate model such as:

```json
{
  "id": "apollo-person-id",
  "name": "Candidate Name",
  "title": "Senior Java Developer",
  "company": "ABC Technologies",
  "location": "Hyderabad, India",
  "linkedinUrl": "https://www.linkedin.com/in/example/",
  "email": "candidate@example.com",
  "phone": null,
  "employmentHistory": [],
  "emailAvailable": true,
  "phoneAvailable": false
}
```

Only fields actually returned by Apollo should be included or marked as unavailable.

## Pagination

The search interface should provide:

- Previous
- Next
- Current page indicator
- Total result count, when Apollo provides it

The application should request only the current page and must not attempt to download the entire Apollo database.

## Loading and Error States

During search:

```text
Searching candidates...
```

During enrichment:

```text
Enriching selected candidates...
```

Buttons must be disabled while the related request is running to prevent duplicate submissions.

Expected user-facing errors include:

| Situation | Message |
|---|---|
| Apollo unavailable | Unable to connect to Apollo. Please try again. |
| Invalid credentials | Apollo API authentication failed. |
| Rate limit | Apollo API rate limit reached. Please try again later. |
| No results | No matching candidates found. |
| Enrichment failure | Unable to enrich this candidate. |
| Network failure | Show a retry option. |

Sensitive backend errors and the Apollo API key must never be exposed to the user.

## Cost and Credit Controls

The intended cost-conscious workflow is:

```text
Search
  -> Review results
  -> Select candidates
  -> Enrich selected candidates only
```

The application should:

- Avoid enriching all search results automatically.
- Avoid sending duplicate enrichment requests.
- Limit the number of candidates enriched in one request where appropriate.
- Avoid retrieving the entire Apollo database.
- Respect Apollo plan limits, rate limits, credits, and permissions.

## Testing Requirements

Use mocked Apollo responses. Do not use real candidate personal data in tests.

Tests should cover:

- Search with only a job title.
- Search with job title and location.
- Search with multiple filters.
- Empty search.
- No results.
- Apollo API failure.
- Invalid Apollo credentials.
- Rate limiting.
- Pagination.
- Candidate selection.
- Select All.
- Clear Selection.
- Enrichment of selected candidates only.
- Partial enrichment.
- Missing LinkedIn URL.
- Missing email.
- Missing phone.
- Duplicate enrichment prevention.
- API key security.
- Response normalization.

## Acceptance Criteria

The feature is complete when:

- A recruiter can search using the supported filters.
- The frontend communicates only with our backend.
- The Apollo API key exists only on the backend.
- Search results are normalized before reaching the frontend.
- Pagination works without fetching the entire database.
- Candidates can be selected individually or in bulk.
- Only selected candidates are enriched.
- Duplicate enrichment is prevented where practical.
- Missing information is shown as unavailable.
- Apollo-provided LinkedIn URLs can be manually opened through normal links.
- The application never visits, scrapes, or automates LinkedIn.
- Loading and error states are clear.
- Tests use mocked Apollo responses.
- Apollo plan, credit, and endpoint limitations are documented.
