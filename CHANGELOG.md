# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-19

### Added

- Sign-in to Volkswagen's EU Data Act portal with the account of the
  Volkswagen app. Volkswagen retired the ID. app API on 2026-06-01, and the
  portal is the only data source left open: read-only, a dataset every
  15 minutes, enabled once in a browser (see the documentation).
- One read-only device per Volkswagen ID. car: battery level, range,
  charging, charging power, cable plugged, charge limit, remaining charging
  time, outside temperature, odometer, doors and windows open, locks.
- "Charge completed" scene trigger, with the battery level and the range.
- "Volkswagen ID." dashboard widget.
- "Test the connection" action: signs in, lists the cars and checks that the
  portal delivers data.
- A failed sign-in, a missing portal setup or an unreachable Volkswagen shows
  in the Configuration screen; saving the configuration again retries.

[Unreleased]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/PhilippeMA/Gladys-volkswagen/releases/tag/v1.0.1
