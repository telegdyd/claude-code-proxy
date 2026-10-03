# Usage Statistics Page Plan

## Decisions

- Add a small dependency-free dashboard at `/stats`, following the existing static HTML approach.
- Start metadata collection enabled for new installs. Persist the on/off switch across restarts. Disabling pauses both request records and usage aggregates; it does not delete existing data.
- Record metadata only: timestamp, model, final status, streaming mode, and upstream-reported token usage. Never persist request/response bodies, prompts, headers, or client IPs. Existing DEBUG body logging remains unchanged as requested.
- Retain request history indefinitely. The page shows the latest 50 records and offers separate destructive actions: clear per-request history but preserve rolled-up stats, or reset all history and stats.
- Do not add dashboard authentication. The page and its read/control endpoints are accessible wherever the existing server is reachable; with `host=0.0.0.0`, this includes the LAN.

## Implementation

1. Add a server-side usage statistics store using built-in Node APIs under `~/.claude-code-proxy/`, alongside the existing OAuth data (and within the existing Docker volume). Persist the logging switch, per-request metadata, and hourly/model rollups. Serialize writes, tolerate absent or malformed data safely, and use restrictive file permissions on Unix where practical. Keep per-request history and rollups separate so history can be cleared without losing totals/trends.
2. Instrument `ClaudeRequest` without changing upstream or client-visible response bytes. For non-streaming JSON, record response `usage` after parsing. For SSE, use a pass-through parser that handles events split across arbitrary chunks; collect input/cache usage from `message_start` and output usage from the final `message_delta`, then record once when the upstream response completes. Track each client request once even when an internal 401 retry occurs. Record failed requests with status and unavailable usage when no authoritative usage is returned; do not represent unknown token counts as zero.
3. Keep token categories distinct: regular `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` (including provider subcategories if present). Show total input context as the sum of regular, cache-read, and cache-creation input, and label cached read/write separately to avoid double-counting ambiguity.
4. Add read/control routes for dashboard data, persisted collection state, state updates, clearing request history only, and resetting all statistics. Validate methods and payloads; ensure an off-state prevents both event and rollup writes. Match the user's decision to leave these routes unauthenticated.
5. Add `server/static/stats.html` with responsive summary cards, dependency-free charts, time-range controls (24 hours, 7 days, 30 days, all time), model breakdown, latest 50 requests, a persistent collection toggle, and explicit confirmation for both deletion actions. Include empty/loading/error states and links to authentication as appropriate.
6. Add tests for store persistence/toggle behavior, rollup-vs-history deletion, non-streaming usage, chunk-split streaming usage, failed/unknown usage, request counting across retries, and dashboard/control endpoints. Run the Jest suite.

## Validation And Risks

- Verify stats collection does not alter streamed or non-streamed responses and counts a request once through 401 retry handling.
- Verify cache tokens are separated from ordinary input/output and missing usage remains unknown.
- Verify disabled collection writes nothing while retained history remains visible; clearing history preserves rollups, while reset clears both.
- Indefinite per-request storage can grow without bound; the dashboard's clear-history action is the selected management mechanism.
- Dashboard data and destructive controls have no extra authentication by user choice and can be exposed to LAN clients when the server binds to all interfaces.
