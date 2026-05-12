# Changelog

## [Unreleased]

## [0.1.0] - 2026-05-12
### Added
- Initial release.
- HTTP server with `POST /api/reports` ingest endpoint (bearer-token auth) and
  read-only listing/viewer endpoints.
- Vanilla JS frontend: reports list at `/`, per-report viewer at `/r/:id`
  with severity filtering and search.
- Docker image (`ghcr.io/perpetualquestllc/sarif-viewer`) and `docker-compose.yml`.
- Composite GitHub Action at `action/` that posts SARIF files and threads
  GitHub workflow metadata as report sources.
- `docker-publish.yml` workflow that publishes multi-arch images on tag push,
  `smoke.yml` workflow that boots the server and ingests a sample SARIF in CI.
