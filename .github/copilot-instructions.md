# Repository guidance

Dasher Apple is a standalone Home Assistant app with an Apple-inspired web dashboard targeting Safari on iOS 12.5.8. It is an independent local fork of Dasher, not a shared package or submodule. Consult `README.md` for development, `dasher-apple/DOCS.md` for supported features, configuration and privacy, and `dasher-apple/CHANGELOG.md` for releases.

## Build, run and test

Run Node commands from `dasher-apple/app`. Node.js >=18 is required; CI uses Node 20. The app uses native JavaScript modules and serves frontend files directly, with no frontend build step.

```sh
cd dasher-apple/app
npm ci
npm test
node --test test/legacy.test.js
node --test --test-name-pattern="legacy script uses ES5 grammar" test/legacy.test.js
npm run dev
```

Tests use `node:test` and `node:assert/strict`. Useful focused suites:
- `test/legacy.test.js`: ES5 grammar check through Acorn and frontend behavior in a VM with fake DOM, XHR, EventSource and timers.
- `test/apple-server.test.js`: starts mock HA and the actual server on ephemeral ports; covers standalone routing, assets, disabled photo/camera endpoints and read-only commands.
- `test/legacy-faces.test.js`: face settings and photo/camera helpers.
- `test/config.test.js` and `test/seed.test.js`: YAML normalization and stock-dashboard migration.

`npm run dev` starts mock HA on 8123 and the app on 8100, using `dev/config` and `dev/data`; interruption stops its child processes. Override occupied ports with:

```sh
MOCK_PORT=18123 PORT=18100 npm run dev
```

For real HA, set `HA_URL`, `HA_TOKEN`, `CONFIG_DIR` and `DATA_DIR`, then use `npm start`. In the installed app, `SUPERVISOR_TOKEN` selects the Supervisor HTTP/WebSocket connection instead.

Build the container from the repository root using the CI command:

```sh
docker build --build-arg BUILD_VERSION=ci --build-arg BUILD_ARCH=amd64 ./dasher-apple
```

`.github/workflows/ci.yaml` also runs the Home Assistant app linter via `frenck/action-addon-linter@v2` against `./dasher-apple`.

`.github/mcp.json` configures Playwright MCP for headless WebKit with an isolated in-memory profile. It requires Node.js >=20 and a WebKit browser installation. Use it against the mock development dashboard; modern WebKit checks do not establish iOS 12.5.8 compatibility.

## Architecture

- `dasher-apple/config.yaml` defines the Home Assistant app identity, options/schema, ingress and direct port (8100), and writable app configuration mount. `Dockerfile` installs production dependencies and copies the server, web files and example YAML; `run.sh` launches `src/index.js`.
- `app/src/index.js` is the composition root and native Node HTTP router. It reads app options, instantiates configuration and domain services, rebuilds discovered models, serves static files/API routes and broadcasts server-sent events (SSE).
- `src/ha-client.js` authenticates to HA over WebSocket, reconnects, reads registries and maintains the entity index and watched-state cache. `index.js` combines explicitly configured and discovered entities during `rebuild()`, updates the service allow-list and watched set, then broadcasts models. Some read-only states are cached server-side without appearing in tablet snapshots.
- `src/config.js` normalizes `dashboard.yaml`, applies entity mapping and app-option overrides, collects entity dependencies, seeds examples and polls configuration files. Domain modules resolve HA entities and provide feature payloads. Unsupported inherited sections and menu entries are ignored.
- `web/legacy/index.html`, `legacy.js` and `legacy.css` are the actual dashboard, despite the inherited name. The frontend keeps model/state caches from `../api/events`, renders faces and supported pages, and uses XHR for API requests and controls. Files under `web/js/` include helpers shared with the backend/tests, not a second dashboard entrypoint.

## Cross-file conventions

- Keep the active frontend script ES5-compatible: use `var`, ordinary functions and the existing XHR/EventSource approach, not module imports, arrow functions, `let`/`const`, optional chaining or async functions. Modern syntax is used in backend/shared modules but must not be copied into `legacy.js`. The syntax test does not establish compatibility on a physical older iPad.
- Preserve ingress-relative URLs. `/` and `/legacy` redirect to `legacy/`; frontend API and icon/asset paths must work beneath Home Assistant's ingress prefix as well as on the direct port. Face/page selection uses URL hashes.
- Retain `legacy_*` option keys for compatibility. Face definitions/settings in `src/legacy-faces.js`, app `config.yaml` options/schema and frontend rendering must agree; supported UI scope is documented in `DOCS.md`.
- Keep frontend labels in both the English and Danish dictionaries in `legacy.js`. App-option labels/descriptions live separately in `translations/en.yaml` and `translations/da.yaml`; update both when changing options.
- Dashboard YAML changes reload through polling (bind mounts and atomic saves make inotify unreliable). App options are read at startup and require restart. Entity mappings must stay within the same HA domain; the `entity_map` app option overrides legacy `entity-map.yaml` entries.
- Never overwrite an edited user dashboard. When changing `app/examples/dashboard.yaml`, add its normalized SHA-256 to `STOCK_EXAMPLE_HASHES` in `src/stock-examples.js` and retain older hashes. `test/seed.test.js` prints a missing hash. Only recognized untouched stock dashboards are upgraded, with a `.bak` backup; `dashboard.example.yaml` is refreshed separately.
- The direct port has no separate login. Keep HA credentials server-side and preserve `READ_ONLY` checks and `src/policy.js` validation: service calls use the fixed service allow-list and rebuilt entity allow-list, and service data cannot override entity/device/area targets. Keep image proxy paths restricted to approved HA image endpoints.
- Photos and camera faces/endpoints are opt-in, but `/assets/` static serving and the general image proxy have separate exposure rules. Do not treat photo album selection or the camera-face switch as an authorization boundary; keep `DOCS.md` privacy guidance consistent with route changes.
- For releases, synchronize `dasher-apple/config.yaml`, `app/package.json`, both root version fields in `app/package-lock.json`, and the latest `CHANGELOG.md` heading. From `app`, use `npm version <version> --no-git-tag-version` to update package/lockfile versions together.
