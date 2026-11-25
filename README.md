# Dasher Apple - Home Assistant app

[![Add repository to my Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FJannicSJensen%2Fha-dasher-apple)

An independent, Apple-inspired wall-tablet dashboard for Home Assistant, targeting Safari on older iPads running iOS 12.5.8. It is a web page, not a native Apple app, and is not affiliated with Apple.

Ten configurable faces: Home Modular, Home Modular Plus, Modular, Weather, Calendar, Clock, Analog, Flow, Photos and Home Camera. Choose faces visually, swipe horizontally, use night mode, and control your configured Home Assistant devices.

## Install

1. Add `https://github.com/JannicSJensen/ha-dasher-apple` under **Settings -> Apps -> App store -> Repositories**.
2. Install **Dasher Apple**, start it and open its sidebar entry.
3. On your iPad, open `http://<home-assistant>:8100/`. The app opens its Apple dashboard automatically.
4. Edit `dashboard.yaml` in this app's configuration folder, replacing the example entities with your own.

Dasher Apple has its own app ID, configuration folder, data and release versions. It can run alongside the original Dasher, which keeps its existing port 8099 and `/legacy/` interface. The new app does not automatically import the original app's configuration: copy your `dashboard.yaml` and any wanted `assets/` files yourself.

**Network privacy:** the direct port has no separate login. Anyone who can reach it can see dashboard data and operate permitted controls unless read-only mode is enabled. Photos and camera snapshots have additional exposure considerations; read [the documentation](dasher-apple/DOCS.md#privacy) before using them.

The interface targets iOS 12.5.8 and has an ES5 syntax check. Physical-device compatibility has not yet been verified.

## Development

Node.js 18 or newer; no frontend build step.

```sh
cd dasher-apple/app
npm ci
npm test
npm run dev
```

Open `http://localhost:8100/`. The development command starts a fake Home Assistant service and stops its children when interrupted. If the ports are already in use, override them, for example:

```sh
MOCK_PORT=18123 PORT=18100 npm run dev
```

For a real Home Assistant connection, set `HA_URL`, `HA_TOKEN`, `CONFIG_DIR` and `DATA_DIR`, then run `npm start`. Keep tokens out of source control.

## Independent fork

This project starts from [ha-dasher-addon](https://github.com/JannicSJensen/ha-dasher-addon), version 0.53.0, commit `a97c102004604b5cf88eb977e3adddb1b7b9869b`. It copies the backend, Apple/legacy frontend, required helper modules, room assets, mocks and relevant tests. The original standard dashboard entrypoint and unrelated frontend pages are not included.

The backend is local, not a package dependency, submodule or connection to another Dasher installation. Inherited unsupported pages and APIs have been removed; old dashboard YAML can still contain unsupported sections, which are ignored. Backend helpers and test support under `web/js/` are not a second dashboard.

The repositories evolve independently. Future fixes can be ported deliberately, but updates are not synchronized automatically. The original repository is unchanged by this extraction.

Documentation: [dasher-apple/DOCS.md](dasher-apple/DOCS.md). Release notes: [dasher-apple/CHANGELOG.md](dasher-apple/CHANGELOG.md).

## License

[MIT](LICENSE), retaining the original copyright notice. The dashboard is independently implemented, with visual inspiration from Apple's design guidance, HomeView, Rehome and [the iPad picture-frame/music-player project](https://github.com/caydin21/iPad-1st-gen-picture-frame-and-music-player-over-Home-Assistant). Third-party wallpapers and Apple UI assets are not bundled.
