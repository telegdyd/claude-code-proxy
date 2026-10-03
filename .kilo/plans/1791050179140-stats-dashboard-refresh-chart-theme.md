# Stats Dashboard Refresh, Chart, and Theme

## Scope and Decisions

- Update the standalone dashboard in `server/static/stats.html`; keep the current `/api/stats` contract and hourly persisted rollups unchanged.
- Refresh the selected-range stats and collection state every 30 seconds. Pause polling while the document is hidden and refresh promptly when it becomes visible. Prevent overlapping refreshes; retain the last rendered data and report refresh errors without interrupting the dashboard.
- Keep the existing time-range selector and add an independent chart-bucket selector for hourly, daily, and weekly views. Aggregate the returned hourly rollups in the browser; use UTC-aligned buckets (ISO weeks beginning Monday) so boundaries remain consistent with stored UTC hours. The selected range can produce partial first and last day/week buckets.
- Replace the line chart with a responsive stacked bar chart. Plot `input_tokens`, `output_tokens`, and cached tokens (`cache_read_input_tokens + cache_creation_input_tokens`) as separate colored series. Do not include cached values in the input series. Preserve readable time and value axes, legend, and empty state.
- Initialize theme from `prefers-color-scheme` when no choice is saved. Add a light/dark toggle and persist explicit user choices in local storage; update page surfaces, text, controls, notices, table, chart grid/labels, and series colors for contrast.
- No data migration or server/API change is needed.

## Implementation Tasks

1. In `server/static/stats.html`, add the bucket selector and accessible theme control, replace hard-coded light-only colors with theme variables, and update the chart legend/caption for the three token categories.
2. Replace `drawChart` line plotting with bucket aggregation and stacked SVG columns. Re-render on bucket, range, and theme changes; retain responsive sizing, axis labels, and the empty-state behavior.
3. Refactor data loading so manual filter changes load immediately and 30-second polling refreshes both stats and collection state without overlapping requests. Pause/resume polling on visibility changes, preserve last-good dashboard content on errors, and avoid routine refreshes clearing action notices.
4. Extend `server/UsageStats.test.js` only as needed to check the new page controls and keep the embedded dashboard script syntax-valid. Do not add a frontend framework or runtime dependency.

## Validation

- Run `npm test` to verify existing stats API/storage behavior and the dashboard-serving test.
- Verify page-script syntax through the existing test and manually exercise the dashboard with populated data at hourly, daily, and weekly buckets, checking that bar heights represent each distinct series correctly and cache is not double-counted.
- Verify 30-second refresh, no polling while hidden, refresh on return, selected-range preservation, and error recovery without loss of last-good data.
- Verify OS-driven initial theme, persisted manual override, contrast/readability in both themes, and layout at narrow/mobile and desktop widths.

## Risks and Edge Cases

- A selected rolling range may cut across calendar-aligned daily or weekly buckets; label these as bucket totals for the included portion of the selected range.
- Historical rollups may lack one or more usage fields. Treat missing series as zero for stacking while showing the empty state when no token category has reported data.
- Keep theme-specific SVG colors tokenized so the bars, grid, and labels remain legible in both themes.
