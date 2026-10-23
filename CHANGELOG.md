# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.2.2] - 2026-10-23

### Fixed

- Charging, charging power and cable plugged followed an old dataset: the
  charge state is now read from the newest dataset holding one, a car
  charging counts as plugged in, and the other names the portal gives these
  fields are read too.

### Added

- One log line per new dataset with the charge fields the car sent, to check
  them against the Volkswagen app.

## [1.2.1] - 2026-10-22

### Fixed

- The "%" of the battery level now really shows in the widgets: Gladys ignores
  the unit of a gauge bound to a device feature, so the gauge carries the
  value read by the integration.

## [1.2.0] - 2026-10-19

### Added

- "Picture of the car" configuration field: the https address of a picture
  of your car (PNG, JPEG or WebP, 300 KB max) for the picture widget, since
  Volkswagen serves none to Gladys. See the documentation.

## [1.1.1] - 2026-10-19

### Fixed

- The widgets show the battery level with its "%" unit.
- The picture widget looks for the car's picture in more places of the
  portal answers (the vehicle list, then the car's relation to the account).
  When none is found, the logs list the fields the portal sent — their names
  only, never their values.

## [1.1.0] - 2026-10-19

### Added

- "Volkswagen ID. picture" dashboard widget: the car around the picture
  Volkswagen holds for it (its own model and colour), with its battery, range
  and charge. No generic image when Volkswagen has none.

### Changed

- The widgets show the name given to the car in Gladys, instead of the
  nickname of the Volkswagen app.

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

[Unreleased]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/PhilippeMA/Gladys-volkswagen/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/PhilippeMA/Gladys-volkswagen/releases/tag/v1.0.1
