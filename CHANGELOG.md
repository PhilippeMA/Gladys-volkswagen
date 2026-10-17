# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Sign-in with the account of the Volkswagen app (legacy and new login pages),
  session kept across restarts.
- One device per Volkswagen ID. car: battery level, range, battery
  temperature, charging, charging power, cable plugged, charge limit,
  remaining charging time, climatisation and its temperature, outside
  temperature, odometer, doors and windows open, locks.
- Commands: start/stop charging, charge limit, start/stop climatisation,
  climatisation temperature, lock/unlock (with the S-PIN).
- "Charge completed" scene trigger, with the battery level and the range.
- "Volkswagen ID." dashboard widget.
- "Test the connection" and "Wake up a car" actions.

[Unreleased]: https://github.com/PhilippeMA/Gladys-volkswagen/commits/main
