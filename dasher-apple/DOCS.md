# Dasher Apple

## Setup

Install Dasher Apple from `https://github.com/JannicSJensen/ha-dasher-apple`. Start it and open its sidebar entry, or visit `http://<home-assistant>:8100/` on your tablet. The root address redirects to `legacy/` using a relative URL so Home Assistant ingress continues to work.

The first start creates `dashboard.yaml`, `dashboard.example.yaml` and `assets/` in the app's configuration folder. Edit `dashboard.yaml` to replace example entities with your own. Saved changes reload on connected tablets. An edited dashboard is never replaced by app updates; an untouched stock example may be updated with a `.bak` backup.

This is a separate installation from Dasher. Configuration and data are not shared. To migrate, copy the desired `dashboard.yaml` and assets into this app's configuration folder, then configure the app options separately. Both apps can run simultaneously using their different default ports.

## Faces and pages

Choose and order faces in **Settings -> Apps -> Dasher Apple -> Configuration -> Dashboard faces**. The configuration key remains `legacy_faces` for compatibility.

The faces are Home Modular, Home Modular Plus, Modular, Weather, Calendar, Clock, Analog, Flow, Photos and Home Camera. The first configured face opens initially. Tap **Faces** for a visual chooser, or swipe left/right to cycle through them. The selected face is part of the URL and survives a reload.

The Home faces use the first visible dashboard page and its configured quick actions. Home Modular Plus also includes additional thermostats. Weather uses the home hero's configured weather entity. Analog shows a round clock alongside digital time and date. Night mode is a manual dim, red-tinted treatment; Safari on old iPads does not reliably expose ambient-light changes.

Supported dashboard pages provide basic home actions, climate controls, area devices, music/media playback controls, car controls, read-only calendar agendas and Energy totals. Hidden menu items and device visibility are respected. Calendar editing, music-library browsing, Plex browsing, meal planning, family boards, to-do lists, device editing, standard-dashboard animations and advanced tile layouts are not part of this frontend. Unsupported tile types are marked as unavailable.

The backend was copied from Dasher to preserve existing configuration, entity discovery, state streaming and service permissions. Inherited options for unsupported features do not enable their missing frontend pages.

## App options

Restart the app after changing its options.

| Option | Purpose |
| --- | --- |
| `log_level` | `debug`, `info`, `warning` or `error`. |
| `read_only` | Show data but refuse tablet commands. |
| `entity_map` | Map example entities to your own without editing YAML; each row has `from` and `to`. |
| `menu_items` | Visibility, labels, icons and ordering for configured pages. Unsupported pages are omitted from this frontend. |
| `legacy_faces` | Ordered face IDs: `home`, `home_plus`, `modular`, `weather`, `calendar`, `clock`, `analog`, `flow`, `photos`, `cameras`. |
| `legacy_wallpaper` | JPEG, PNG or GIF filename directly in `assets/`; empty uses the built-in gradient. |
| `legacy_photos` | Enable the photo face and album endpoints; off by default. |
| `legacy_photo_albums` | Folder names directly under `assets/photos/`; empty includes all albums and images directly in that folder. |
| `legacy_photo_interval` | Seconds between photos, 10-3600; default 120. |
| `legacy_cameras` | Enable snapshots from discovered HA cameras; off by default. |
| `legacy_camera_interval` | Seconds between snapshots, 10-3600; default 30. |
| `enable_calendar` | Enable the read-only calendar agenda without adding a `calendar:` section. |
| `allow_area_picture_upload` | Let the backend add built-in room pictures to HA areas that have none. Pictures you choose are preserved. |

Other inherited backend options are retained for configuration compatibility, not as a promise of standard-dashboard features.

## Wallpaper, photos and cameras

For wallpaper, put a JPEG, PNG or GIF directly in `assets/` and enter the filename in the wallpaper option. A failed image shows an error and leaves the built-in background.

For photos, enable photo albums and put JPEG, PNG or GIF files in `assets/photos/`. Direct subfolders are albums. The album list can limit the photo face's selection. Images over 10 MB are rejected. Resize images yourself for older tablets; there is no transcoding.

For cameras, enable camera snapshots. The app discovers all Home Assistant cameras, including ones added later, and refreshes snapshots at the configured interval. This is not video streaming or camera control. Errors are shown on the face.

## Privacy

The direct port has no separate login. Anyone who can reach it can see dashboard data and operate permitted controls, unless `read_only` is enabled. The backend still uses its server-side entity/service allow-list. Restrict network access; do not expose the port directly to the internet.

Enabling camera snapshots exposes all discovered camera snapshots to users who can reach the direct port. The inherited general image proxy supports HA camera paths independently of the camera-face switch.

Files in `assets/` are accessible through static URLs regardless of the photo setting or album selection. These options control the photo/camera faces and their dedicated endpoints, not all inherited image routes. Do not put private images in assets unless this exposure is acceptable.

## Compatibility

The frontend uses ES5 JavaScript grammar and targets Safari on iOS/iPadOS 12.5.8. Physical-device compatibility has not yet been verified. Modern-browser and mock-server checks do not establish compatibility on an actual older iPad.

This is an unofficial Apple-inspired web dashboard, not a native Apple widget. Third-party wallpapers and Apple assets are not bundled.

## Development and releases

From `dasher-apple/app`, run `npm ci`, `npm test`, then `npm run dev`. The development command starts fake Home Assistant and Music Assistant services. The dashboard opens on port 8100. Override `MOCK_PORT`, `MA_PORT` and `PORT` if needed.

Against a real HA installation, set `HA_URL` and `HA_TOKEN`, plus `CONFIG_DIR` and `DATA_DIR`, and run `npm start`. Inside the Home Assistant app, the Supervisor token is used automatically.

For releases, keep the version in `config.yaml`, `app/package.json`, both root lockfile version fields and the latest `CHANGELOG.md` release heading in sync. Run `npm version <version> --no-git-tag-version` from `app` to update the package and lockfile together.

The backend is a local fork. There is no shared package, submodule, runtime dependency or automatic synchronization with `ha-dasher-addon`.
