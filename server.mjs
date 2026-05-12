// SARIF Viewer — minimal HTTP server that ingests SARIF reports from GitHub
// Actions (or any other CI) and renders them in a browser.
//
// All persistent state lives in $DATA_DIR (default: ./data). Each report is
// stored as two files: <id>.sarif (raw SARIF JSON) and <id>.meta.json (upload
// metadata + summary). The id is a base32 of a SHA-256 of the file body so
// re-uploads of the same SARIF are idempotent.

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(__dirname, 'data'));
const REPORTS_DIR = join(DATA_DIR, 'reports');
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN ?? '';
const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_BODY_BYTES ?? `${50 * 1024 * 1024}`, 10);

if (!UPLOAD_TOKEN) {
  console.warn('[sarif-viewer] WARNING: UPLOAD_TOKEN is empty; /api/reports POST/DELETE will reject all requests.');
}

await mkdir(REPORTS_DIR, { recursive: true });

const app = new Hono();

// --- helpers ---------------------------------------------------------------

function reportId(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 24);
}

function requireAuth(c) {
  if (!UPLOAD_TOKEN) return c.json({ error: 'UPLOAD_TOKEN not configured on server' }, 503);
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || match[1] !== UPLOAD_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

function summarize(sarif) {
  const summary = { runs: 0, results: 0, error: 0, warning: 0, note: 0, none: 0, tools: [] };
  const runs = Array.isArray(sarif?.runs) ? sarif.runs : [];
  summary.runs = runs.length;
  for (const run of runs) {
    const toolName = run?.tool?.driver?.name ?? 'unknown';
    const toolVersion = run?.tool?.driver?.version ?? null;
    summary.tools.push({ name: toolName, version: toolVersion });
    const results = Array.isArray(run?.results) ? run.results : [];
    summary.results += results.length;
    for (const r of results) {
      const level = (r?.level ?? 'warning').toLowerCase();
      if (level in summary) summary[level] += 1;
      else summary.warning += 1;
    }
  }
  return summary;
}

async function loadMeta(id) {
  const metaPath = join(REPORTS_DIR, `${id}.meta.json`);
  try {
    return JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

async function listReports() {
  const entries = await readdir(REPORTS_DIR);
  const reports = [];
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    const id = entry.slice(0, -'.meta.json'.length);
    const meta = await loadMeta(id);
    if (meta) reports.push(meta);
  }
  reports.sort((a, b) => (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''));
  return reports;
}

async function readRawBody(c) {
  const lenHeader = c.req.header('content-length');
  if (lenHeader && Number.parseInt(lenHeader, 10) > MAX_BODY_BYTES) {
    throw new HttpError(413, `payload too large (>${MAX_BODY_BYTES} bytes)`);
  }
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, `payload too large (>${MAX_BODY_BYTES} bytes)`);
  }
  return Buffer.from(ab);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function pickQueryMetadata(url) {
  const u = new URL(url);
  const get = (k) => u.searchParams.get(k) || null;
  return {
    repo: get('repo'),
    commit: get('commit'),
    ref: get('ref'),
    branch: get('branch'),
    workflow: get('workflow'),
    job: get('job'),
    runId: get('run_id'),
    runUrl: get('run_url'),
    pr: get('pr'),
    actor: get('actor'),
    label: get('label'),
  };
}

// --- routes ----------------------------------------------------------------

app.get('/healthz', (c) => c.text('ok'));

app.get('/api/reports', async (c) => {
  const reports = await listReports();
  return c.json({ reports });
});

app.get('/api/reports/:id', async (c) => {
  const id = c.req.param('id');
  const meta = await loadMeta(id);
  if (!meta) return c.json({ error: 'not found' }, 404);
  return c.json(meta);
});

app.get('/api/reports/:id/sarif', async (c) => {
  const id = c.req.param('id');
  const sarifPath = join(REPORTS_DIR, `${id}.sarif`);
  if (!existsSync(sarifPath)) return c.json({ error: 'not found' }, 404);
  const body = await readFile(sarifPath, 'utf8');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/sarif+json; charset=utf-8' },
  });
});

app.post('/api/reports', async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;

  let body;
  try {
    body = await readRawBody(c);
  } catch (err) {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  let sarif;
  try {
    sarif = JSON.parse(body.toString('utf8'));
  } catch {
    return c.json({ error: 'body is not valid JSON' }, 400);
  }
  if (!sarif || typeof sarif !== 'object' || !Array.isArray(sarif.runs)) {
    return c.json({ error: 'not a SARIF document (missing runs[])' }, 400);
  }

  const id = reportId(body);
  const sarifPath = join(REPORTS_DIR, `${id}.sarif`);
  const metaPath = join(REPORTS_DIR, `${id}.meta.json`);

  const meta = {
    id,
    uploadedAt: new Date().toISOString(),
    bytes: body.length,
    summary: summarize(sarif),
    source: pickQueryMetadata(c.req.url),
  };

  await writeFile(sarifPath, body);
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  return c.json({ ok: true, id, url: `/r/${id}`, meta }, 201);
});

app.delete('/api/reports/:id', async (c) => {
  const authErr = requireAuth(c);
  if (authErr) return authErr;
  const id = c.req.param('id');
  const sarifPath = join(REPORTS_DIR, `${id}.sarif`);
  const metaPath = join(REPORTS_DIR, `${id}.meta.json`);
  let removed = 0;
  for (const p of [sarifPath, metaPath]) {
    try {
      await unlink(p);
      removed += 1;
    } catch {
      /* ignore missing */
    }
  }
  if (removed === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, id });
});

app.use('/public/*', serveStatic({ root: './' }));
app.get('/', serveStatic({ path: './public/index.html' }));
app.get('/r/:id', serveStatic({ path: './public/viewer.html' }));

// --- start -----------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[sarif-viewer] listening on http://${info.address}:${info.port}`);
  console.log(`[sarif-viewer] data dir: ${DATA_DIR}`);
});
