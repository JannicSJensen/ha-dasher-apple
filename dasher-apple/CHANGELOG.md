# Changelog

## 0.2.0

- Remove inherited meal, family, to-do, library-browsing and editing APIs and background jobs that the Apple dashboard does not use. Existing saved data is left untouched.
- Keep supported dashboard faces, basic media controls, read-only calendar, device controls and migrated dashboard YAML.

## 0.1.0

- Initial independent Dasher Apple app, based on Dasher 0.53.0.
- Copy the backend and Apple/legacy dashboard into a self-contained repository with no dependency on the original Dasher installation.
- Use the Apple dashboard as the default entrypoint; remove the standard-dashboard link.
- Give the app its own slug, configuration/data storage, release version and default port 8100 so both apps can coexist.
- Retain ten faces, home controls, clocks, weather, optional photos/camera snapshots and the existing ES5 compatibility checks.
- Include relevant backend tests, development mocks and CI.
