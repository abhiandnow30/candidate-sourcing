import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { enrichPeople, searchPeople } from './apolloService.js';

// Credit guard: the most people one /enrich call will forward to Apollo.
// Anything beyond this is reported back as skipped, never silently dropped.
const MAX_ENRICH_PER_REQUEST = 25;

// Mirrors the client. Kept here so the API cannot be driven past the rule.
const REQUIRED_FILTERS = ['jobTitle', 'location', 'keywords'];

const app = express();

// These endpoints spend Apollo credits, so they are same-origin only by
// default. The dev client reaches them through the Vite proxy and needs no
// CORS headers at all. Set ALLOWED_ORIGIN (comma separated) only when the
// frontend is genuinely deployed on a different origin.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
if (allowedOrigins.length) app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: '32kb' }));

function clean(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function publicError(error) {
  const messages = {
    MISSING_APOLLO_API_KEY: ['Apollo API is not configured on the server.', 503],
    APOLLO_AUTH: ['Apollo API authentication failed.', 502],
    APOLLO_RATE_LIMIT: ['Apollo API rate limit reached. Please try again later.', 429],
    APOLLO_UNAVAILABLE: ['Unable to connect to Apollo. Please try again.', 502]
  };
  return messages[error.message] || ['Unable to complete the Apollo request.', 502];
}

app.post('/api/candidates/search', async (request, response) => {
  const filters = Object.fromEntries(['jobTitle', 'location', 'seniority', 'keywords', 'company', 'industry']
    .map((key) => [key, clean(request.body?.[key])]));
  const page = Math.max(1, Math.min(1000, Number.parseInt(request.body?.page, 10) || 1));
  // Credit guard: Apollo bills for every search, so refuse one that cannot be
  // meaningful. Role, skills and location are required; company, industry and
  // seniority only narrow an already valid query.
  const missing = REQUIRED_FILTERS.filter((key) => filters[key] === '');
  if (missing.length) {
    return response.status(400).json({
      error: 'Role / job title, skills / keywords and location are required.',
      missing
    });
  }
  try {
    const result = await searchPeople(filters, page);
    response.json(result);
  } catch (error) {
    const [message, status] = publicError(error);
    response.status(status).json({ error: message });
  }
});

app.post('/api/candidates/enrich', async (request, response) => {
  const requested = Array.isArray(request.body?.ids)
    ? [...new Set(request.body.ids.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.slice(0, 120)))]
    : [];
  const ids = requested.slice(0, MAX_ENRICH_PER_REQUEST);
  const skippedIds = requested.slice(MAX_ENRICH_PER_REQUEST);
  if (!ids.length) return response.status(400).json({ error: 'Select at least one candidate to enrich.' });
  try {
    const { candidates, failedIds } = await enrichPeople(ids);
    // requestedIds lets the client resolve every selected ID to an outcome:
    // enriched, failed, or skipped by the per-request cap.
    response.json({ requestedIds: ids, candidates, failedIds, skippedIds });
  } catch (error) {
    const [message, status] = publicError(error);
    response.status(status).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 3000;
if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`Candidate API listening on ${port}`));
export default app;
