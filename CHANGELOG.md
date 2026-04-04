# Changelog

## 1.0.1

- Removed the global refresh interval and percent decimal settings from the contributed Settings UI.
- Fixed refresh scheduling so Copilot and workday counters update every 60 seconds and all other counters update every hour.
- Fixed Copilot Average calibration so the baseline excludes today's usage instead of averaging against a partial current day.
- Added a warm-up state for Copilot Average when there is not yet a completed prior day in the billing cycle.
- Adjusted oQuota status bar priorities so its counters appear at the far right edge of the VS Code status bar.

## 1.0.0

- Initial release of oQuota.
- Added a flexible number of configurable status bar counters with a default day-of-year counter.
- Added monthly billing-cycle, current-year, workday, and custom date-range progress modes.
- Added a deadline countdown mode.
- Added GitHub Copilot quota mode using the built-in GitHub authentication provider and the Copilot internal quota endpoint.
- Added Copilot counter display options for `raw-remaining`, `raw-consumption`, `consumption`, `remaining-pool`, and `average-calibration`.
- Enhanced Copilot pacing with mini bars, colored state circles, local snapshot anchoring, pool tracking, average calibration, and warnings when the quota may last only about three more days.
- Added guided counter configuration that asks only for the inputs relevant to the chosen mode.
- Added add/remove counter commands.
- Moved status bar items to the right side of the VS Code status bar.
- Added adaptive refresh defaults: Copilot every 60 seconds, workday counters every 5 minutes, and the other counters hourly.
- Added Settings UI configuration for the dynamic counter array, labels, emoji, modes, billing day, time windows, date ranges, and deadlines.
- Added Marketplace-ready project metadata, packaging ignores, and documentation.