# Changelog

## 0.1.0 (unreleased)

- First functional release: Settings "MCP servers" section, per-workspace
  tool-scope injection gate, stdio + streamable-http transports, write-only
  credential keys, zh/en locales.
- Two full review rounds applied (docs/review/ + round2/) — 133 tests.
- Live R3 tool-capture evidence: docs/milestones/M1-live-capture.log.

Release mechanics: tag `v0.x.y` triggers .github/workflows/release.yml
(gate → `npm publish --provenance`). See docs/RELEASE.md.
