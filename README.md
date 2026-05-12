# sarif-viewer

A small, self-hosted SARIF report viewer. Runs as a single Docker container,
accepts SARIF uploads from GitHub Actions (or any HTTP client), and renders
them in a browser. Comes with a companion composite GitHub Action so any
SARIF-producing workflow (CodeQL, Trivy, Semgrep, Bandit, ESLint, etc.) can
ship its output to the viewer in one step.

- **No build step** — vanilla HTML/JS frontend, ESM Node backend.
- **Filesystem-backed** — reports live under a single mounted volume; no
  database to operate.
- **One token to upload** — bearer-token-gated `POST /api/reports`.
- **Action included** — composite action ships alongside the server.

## Quick start (Docker)

```bash
docker run -d --name sarif-viewer \
  -p 8080:8080 \
  -e UPLOAD_TOKEN="$(openssl rand -hex 32)" \
  -v sarif-data:/data \
  ghcr.io/perpetualquestllc/sarif-viewer:latest
```

Or with compose:

```bash
echo "UPLOAD_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Then open <http://localhost:8080>.

### Configuration

| Env var          | Default          | Notes                                                         |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| `PORT`           | `8080`           | Listen port.                                                  |
| `HOST`           | `0.0.0.0`        | Listen host.                                                  |
| `DATA_DIR`       | `/data` (image)  | Where SARIF + metadata files are stored.                      |
| `UPLOAD_TOKEN`   | _(unset)_        | Bearer token required by `POST /api/reports`. If empty, ingest is fully disabled. |
| `MAX_BODY_BYTES` | `52428800` (50M) | Max body size accepted by the ingest endpoint.                |

The viewer has no built-in auth on the read side. If you don't want SARIF
findings to be world-readable, run it behind a reverse proxy with basic auth /
SSO / network ACLs.

## Uploading SARIF — from GitHub Actions

Reference the bundled action by repo + path. Pin to a tag (recommended) or
SHA in production workflows.

```yaml
name: trivy

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Trivy filesystem scan
        uses: aquasecurity/trivy-action@0.24.0
        with:
          scan-type: fs
          format: sarif
          output: trivy.sarif

      - name: Upload SARIF to viewer
        uses: perpetualquestllc/sarif-viewer/action@v0
        with:
          viewer-url: ${{ vars.SARIF_VIEWER_URL }}
          token: ${{ secrets.SARIF_VIEWER_TOKEN }}
          sarif-file: trivy.sarif
          label: trivy-fs
          # optional: fail the step if any error-level result was reported
          fail-on: error
```

Multiple files / globs:

```yaml
      - uses: perpetualquestllc/sarif-viewer/action@v0
        with:
          viewer-url: ${{ vars.SARIF_VIEWER_URL }}
          token: ${{ secrets.SARIF_VIEWER_TOKEN }}
          sarif-files: |
            results/*.sarif
            extras/codeql.sarif
```

### Action inputs

| Input               | Required | Notes                                                                                 |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `viewer-url`        | yes      | Base URL of the viewer (no trailing slash).                                           |
| `token`             | yes      | Matches the viewer's `UPLOAD_TOKEN`. Use a repo/org secret.                            |
| `sarif-file`        | no       | Single file path / glob.                                                              |
| `sarif-files`       | no       | Multiple paths/globs, newline- or comma-separated. Overrides `sarif-file`.            |
| `label`             | no       | Human-friendly tag attached to the report metadata.                                   |
| `fail-on`           | no       | `error`, `warning`, or `note` — fails the step if any result reaches that level.       |
| `continue-on-error` | no       | When `true`, network/auth failures during ingest do not fail the step.                |

The action auto-fills repo, commit, branch, workflow, job, run id, run URL,
actor, and PR number from `$GITHUB_*` context. They are sent as query-string
parameters and stored as the report's `source` metadata.

## Uploading SARIF — from anywhere else

```bash
curl -X POST \
  -H "Authorization: Bearer $UPLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @results.sarif \
  "$VIEWER_URL/api/reports?repo=owner/name&commit=abc123&workflow=ci.yml"
```

The body must be a valid SARIF v2.1.0 document (i.e. an object with a `runs`
array). The response is a JSON envelope:

```json
{
  "ok": true,
  "id": "f7c2…",
  "url": "/r/f7c2…",
  "meta": { "id": "f7c2…", "uploadedAt": "…", "summary": { "error": 2, "warning": 11, "note": 0 } }
}
```

Re-uploads of the same SARIF body are idempotent — the report id is a hash
of the body.

## API

| Method | Path                       | Auth   | Description                            |
| ------ | -------------------------- | ------ | -------------------------------------- |
| GET    | `/`                        | none   | Reports list (HTML).                   |
| GET    | `/r/:id`                   | none   | Viewer for a report (HTML).            |
| GET    | `/api/reports`             | none   | List reports (JSON).                   |
| GET    | `/api/reports/:id`         | none   | Report metadata (JSON).                |
| GET    | `/api/reports/:id/sarif`   | none   | Raw SARIF (application/sarif+json).    |
| POST   | `/api/reports?...`         | bearer | Ingest a SARIF body.                   |
| DELETE | `/api/reports/:id`         | bearer | Remove a report and its metadata.      |
| GET    | `/healthz`                 | none   | Liveness probe.                        |

Ingest query parameters (all optional): `repo`, `commit`, `ref`, `branch`,
`workflow`, `job`, `run_id`, `run_url`, `pr`, `actor`, `label`.

## Local development

```bash
npm install
UPLOAD_TOKEN=devtoken npm run dev
# in another shell
curl -X POST -H "Authorization: Bearer devtoken" \
  -H "Content-Type: application/json" \
  --data-binary @sample.sarif \
  "http://localhost:8080/api/reports?repo=demo/demo&commit=$(git rev-parse HEAD)&workflow=local"
```

Reports persist to `./data/reports/` when run outside Docker.

## License

MIT — see [`LICENSE`](LICENSE).
