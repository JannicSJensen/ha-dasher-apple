import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAreaModel, imageSignature, scanImages } from "./areas.js";
import { HiddenDevices } from "./hidden.js";
import { ConfigStore } from "./config.js";
import { MenuOptionsSync } from "./menu-options.js";
import { discoverEv, resolveEv } from "./ev.js";
import { resolveClimate } from "./climate.js";
import { EnergyService } from "./energy.js";
import { isEnergyPriceState } from "./energy-prices.js";
import { resolveWeatherBackgrounds } from "./weather.js";
import { plexConfigured, plexPlayers, radioPlayers } from "./players.js";
import { describeUnresolved, unresolvedEntities } from "./mapping.js";
import { CalendarService, calendarScope, parseWindow } from "./calendar.js";
import { HAClient } from "./ha-client.js";
import { iconSvg } from "./icons.js";
import { AreaPictures } from "./area-pictures.js";
import { validateProxyPath, validateServiceCall } from "./policy.js";
import { cameraList, legacyOptions, listPhotoAlbums, openPhoto } from "./legacy-faces.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const webRoot = path.join(appRoot, "web");
const version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version;

// ---- options & environment ------------------------------------------------

function readOptions() {
  const file = process.env.OPTIONS_FILE ?? "/data/options.json";
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

const options = readOptions();
const LEVELS = { debug: 0, info: 1, warning: 2, error: 3 };
const minLevel = LEVELS[options.log_level ?? process.env.LOG_LEVEL ?? "info"] ?? 1;
const logger = Object.fromEntries(
  ["debug", "info", "warn", "error"].map((name) => {
    const level = LEVELS[name === "warn" ? "warning" : name];
    const out = name === "error" ? console.error : console.log;
    return [name, (msg) => level >= minLevel && out(`[${new Date().toISOString()}] ${name.toUpperCase()} ${msg}`)];
  }),
);
const legacySettings = legacyOptions(options);
for (const error of legacySettings.errors) logger.warn(error);

const PORT = Number(process.env.PORT ?? 8100);
const READ_ONLY = options.read_only === true;
const AREA_PICTURES = !READ_ONLY && options.allow_area_picture_upload !== false && process.env.ALLOW_AREA_PICTURE_UPLOAD !== "0";
const configDir = process.env.CONFIG_DIR ?? "/config";

const supervisorToken = process.env.SUPERVISOR_TOKEN || undefined;
const haHttpBase = supervisorToken ? "http://supervisor/core" : (process.env.HA_URL ?? "").replace(/\/$/, "");
const haToken = supervisorToken ?? process.env.HA_TOKEN;
if (!haHttpBase || !haToken) {
  logger.error("No Home Assistant connection: set SUPERVISOR_TOKEN (add-on) or HA_URL and HA_TOKEN (development).");
  process.exit(1);
}
const haWsUrl = supervisorToken
  ? "ws://supervisor/core/websocket"
  : `${haHttpBase.replace(/^http/, "ws")}/api/websocket`;

// ---- state ------------------------------------------------------------------

const clients = new Set();

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => clients.forEach((res) => send(res, event, data));

const ha = new HAClient({
  wsUrl: haWsUrl, token: haToken, logger,
  cacheReadOnlyState: (state) => isEnergyPriceState(state) || Object.hasOwn(state.attributes ?? {}, "charging_number_of_hours"),
});
const menuOptionsSync = supervisorToken ? new MenuOptionsSync({ token: supervisorToken, logger }) : null;
const configStore = new ConfigStore({
  dir: configDir,
  logger,
  entityMapOption: options.entity_map ?? process.env.ENTITY_MAP ?? [],
  menuItemsOption: options.menu_items ?? [],
  weatherBackgroundOption: options.weather_background !== false,
  calendarPageOption: options.enable_calendar === true || process.env.ENABLE_CALENDAR === "1",
  onChange: () => {
    menuOptionsSync?.update(configStore.current.config);
    rebuild({ refresh: true });
    broadcast("config", configPayload());
  },
});
const energy = new EnergyService({
  ha, logger,
  getEvInfoEntity: () => configStore.current.config?.ev?.roles.smart_info_entity
    ?? discoverEv({ registries: ha.registries, index: ha.entityIndex }).smart_info_entity,
});
energy.on("change", () => broadcast("energy", energy.payload()));
const dataDir = process.env.DATA_DIR ?? (fs.existsSync("/data") ? "/data" : null);
const calendars = new CalendarService({ ha, logger });

/** Read Home Assistant calendar events. */
async function haRest(method, apiPath, body) {
  const response = await fetch(haHttpBase + apiPath, {
    method,
    headers: { Authorization: `Bearer ${haToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!response.ok) throw new Error(data?.message ?? `HTTP ${response.status}`);
  return data;
}
/** Upload a file through Home Assistant's image integration; resolves to the new image's id. */
async function haUpload(name, buffer, type) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  const response = await fetch(`${haHttpBase}/api/image/upload`, { method: "POST", headers: { Authorization: `Bearer ${haToken}` }, body: form, signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? `HTTP ${response.status}`);
  return data?.id ?? null;
}
const hiddenDevices = new HiddenDevices({ dir: dataDir, logger });
const areaPictures = new AreaPictures({
  ha,
  upload: haUpload,
  exists: async (picture) => {
    try {
      return (await fetch(haHttpBase + picture, { method: "HEAD", headers: { Authorization: `Bearer ${haToken}` }, signal: AbortSignal.timeout(8000) })).ok;
    } catch {
      return false;
    }
  },
  dir: dataDir,
  imageDir: path.join(webRoot, "img", "rooms"),
  logger,
});

// ---- areas ------------------------------------------------------------------

let images = { areas: new Map(), entities: new Map() };
let imageSig = "";
let areaModel = { areas: [], entities: new Set() };
// Everything tablets may see or control: the dashboard's own entities plus the area pages' entities.
let allowed = new Set();

const areasPayload = () => {
  const settings = configStore.current.config?.areas;
  if (!settings?.enabled) return { enabled: false, areas: [] };
  return { enabled: true, title: settings.title, icon: settings.icon, areas: areaModel.areas };
};

let radioPlayerIds = [];
let evState = { enabled: false, roles: {} };
let plexState = { enabled: false, players: [] };
const plexPayload = () => (plexState.enabled ? plexState : { enabled: false, players: [] });
let climateState = { enabled: false, entities: [] };
let weatherModel = { config: null, entities: new Set() };
const climatePayload = () => (climateState.enabled ? climateState : { enabled: false, entities: [] });
const evPayload = () => (evState.enabled ? evState : { enabled: false, roles: {} });

/** Player controls use Home Assistant state and services directly. */
const musicPayload = () => {
  const settings = configStore.current.config?.music;
  if (!settings?.enabled || radioPlayerIds.length === 0) return { enabled: false, players: [] };
  return { enabled: true, title: settings.title, icon: settings.icon, players: radioPlayerIds };
};

/** Recompute everything derived from the config and the registries, and tell the tablets. */
function rebuild({ refresh }) {
  const current = configStore.current;
  const nextWeather = resolveWeatherBackgrounds(current.config, ha.entityIndex);
  const weatherChanged = JSON.stringify(nextWeather.config) !== JSON.stringify(weatherModel.config);
  weatherModel = nextWeather;
  energy.configure(current.config?.energy);
  areaModel = buildAreaModel({
    registries: ha.registries,
    deviceClasses: ha.deviceClasses,
    settings: current.config?.areas,
    images,
    hidden: hiddenDevices.ids,
    builtinPictures: areaPictures.appliedAreas,
  });
  radioPlayerIds = radioPlayers(current.config?.music, ha.registries);
  evState = resolveEv({
    settings: current.config?.ev,
    discovered: discoverEv({ registries: ha.registries, index: ha.entityIndex }),
  });
  climateState = resolveClimate({ settings: current.config?.climate, registries: ha.registries, index: ha.entityIndex });
  {
    const settings = current.config?.plex;
    const players = plexPlayers({ settings, registries: ha.registries });
    const enabled = Boolean(settings) && settings.enabled !== false && players.length > 0 && (settings.enabled === true || plexConfigured(ha.registries));
    plexState = {
      enabled,
      title: settings?.title ?? null,
      icon: settings?.icon,
      players: enabled ? players.map((p) => p.id) : [],
      platforms: enabled ? Object.fromEntries(players.map((p) => [p.id, p.platform])) : {},
    };
  }
  allowed = new Set([
    ...current.entities,
    ...(calendarPageEnabled() ? calendarPageList().map((c) => c.id) : []),
    ...areaModel.entities,
    ...radioPlayerIds,
    ...(evState.enabled ? Object.values(evState.roles) : []),
    ...(climateState.enabled ? climateState.entities : []),
    ...plexState.players,
  ]);
  ha.setWatched(new Set([...allowed, ...weatherModel.entities]), { refresh, required: current.entities });
  if (weatherChanged) broadcast("config", configPayload());
  broadcast("areas", areasPayload());
  broadcast("music", musicPayload());
  broadcast("ev", evPayload());
  broadcast("climate", climatePayload());
  broadcast("plex", plexPayload());
}

function rescanImages() {
  const next = scanImages(configStore.assetsDir);
  const sig = imageSignature(next);
  if (sig === imageSig) return;
  const first = imageSig === "";
  imageSig = sig;
  images = next;
  if (!first) rebuild({ refresh: false });
}

const configPayload = () => ({ config: weatherModel.config ?? configStore.current.config, errors: configStore.current.errors, legacy: legacySettings });
const statusPayload = () => ({
  ha: ha.connected,
  readOnly: READ_ONLY,
  missing: missingEntities().map((m) => m.id),
});

/** Entities of dashboard.yaml that Home Assistant does not know once the app option "Entity mapping" is applied. */
function missingEntities() {
  return unresolvedEntities({ rawEntities: configStore.current.rawEntities, map: configStore.entityMap, index: ha.entityIndex });
}

let missingSignature = "";
/** Tell the log what is missing, with guesses to use in the option; once per distinct set. */
function reportMissing() {
  const unresolved = missingEntities();
  const signature = JSON.stringify(unresolved);
  if (signature === missingSignature) return;
  missingSignature = signature;
  for (const line of describeUnresolved({ unresolved, usage: configStore.current.usage, index: ha.entityIndex, registries: ha.registries })) logger.warn(line);
}

/** Give areas without a picture a built-in room picture in Home Assistant itself (once, after the registries load). */
let pictureTimer = null;
function scheduleAreaPictures() {
  if (!AREA_PICTURES) return;
  clearTimeout(pictureTimer);
  pictureTimer = setTimeout(async () => {
    const settings = configStore.current.config?.areas;
    if (!settings || settings.enabled === false || settings.default_images === false || !ha.registries?.areas?.length) return;
    const rooms = {};
    for (const [key, o] of Object.entries(settings.overrides ?? {})) if (o.room) rooms[key.toLowerCase()] = o.room;
    if ((await areaPictures.sync(ha.registries.areas, { rooms })) > 0) rebuild({ refresh: false });
  }, 3000);
  pictureTimer.unref?.();
}

ha.on("registries", () => {
  rebuild({ refresh: false });
  scheduleAreaPictures();
  logger.info(`Area pages: ${areaModel.areas.length} areas, ${areaModel.entities.size} entities`);
});
ha.on("status", (connected) => {
  broadcast("status", statusPayload());
  if (connected) {
    energy.clear();
    energy.configure(configStore.current.config?.energy);
    energy.refresh();
  }
});
ha.on("state", (state) => {
  broadcast("state", state);
});
ha.on("snapshot", (states) => {
  reportMissing();
  broadcast("status", statusPayload());
  broadcast("snapshot", Object.fromEntries(states));
});

// ---- http helpers -----------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(text);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Body too large."), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveFile(res, root, relPath, cacheControl) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return json(res, 400, { error: "Bad path." });
  }
  const file = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: "Forbidden." });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: "Not found." });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cacheControl,
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function proxyImage(res, requestedPath, cacheControl = "private, max-age=300") {
  if (!validateProxyPath(requestedPath)) return json(res, 400, { error: "Path not allowed." });
  try {
    const upstream = await fetch(haHttpBase + requestedPath, {
      headers: { Authorization: `Bearer ${haToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) return json(res, 404, { error: "No image." });
    const limit = 10 * 1024 * 1024;
    if (Number(upstream.headers.get("content-length")) > limit) {
      await upstream.body?.cancel();
      return json(res, 413, { error: "Image too large." });
    }
    const chunks = [];
    let size = 0;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return json(res, 413, { error: "Image too large." });
        }
        chunks.push(Buffer.from(value));
      }
    }
    const buf = Buffer.concat(chunks, size);
    res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length, "Cache-Control": cacheControl });
    res.end(buf);
  } catch (err) {
    logger.debug(`Image proxy failed: ${err.message}`);
    json(res, 502, { error: "Upstream failed." });
  }
}

async function handleLegacyPhotos(res) {
  if (!legacySettings.photos) return json(res, 403, { error: "Legacy photos are disabled in app configuration." });
  try {
    return json(res, 200, await listPhotoAlbums(configStore.assetsDir, legacySettings.albums));
  } catch (err) {
    logger.warn(`Legacy photos failed: ${err.message}`);
    return json(res, err.status ?? 500, { error: err.status ? err.message : "Could not read photo albums." });
  }
}

async function handleLegacyPhoto(req, res, params) {
  if (!legacySettings.photos) return json(res, 403, { error: "Legacy photos are disabled in app configuration." });
  try {
    const photo = await openPhoto(configStore.assetsDir, params.get("album") ?? "", params.get("name"), legacySettings.albums);
    res.writeHead(200, { "Content-Type": MIME[photo.extension], "Content-Length": photo.size, "Cache-Control": "private, max-age=60" });
    if (req.method === "HEAD") { await photo.handle.close(); return res.end(); }
    const stream = photo.handle.createReadStream();
    stream.on("error", (err) => { logger.warn(`Legacy photo stream failed: ${err.message}`); res.destroy(); });
    return stream.pipe(res);
  } catch (err) {
    logger.warn(`Legacy photo failed: ${err.message}`);
    return json(res, err.status ?? 500, { error: err.status ? err.message : "Could not read photo." });
  }
}

function handleLegacyCameras(res) {
  if (!legacySettings.cameras) return json(res, 403, { error: "Legacy cameras are disabled in app configuration." });
  if (!ha.connected) return json(res, 503, { error: "Home Assistant is disconnected." });
  return json(res, 200, { cameras: cameraList(ha.entityIndex, true) });
}

async function handleLegacyCamera(res, id) {
  if (!legacySettings.cameras) return json(res, 403, { error: "Legacy cameras are disabled in app configuration." });
  if (!ha.connected) return json(res, 503, { error: "Home Assistant is disconnected." });
  if (!cameraList(ha.entityIndex, true).some((camera) => camera.id === id)) return json(res, 404, { error: "Unknown camera." });
  return proxyImage(res, `/api/camera_proxy/${encodeURIComponent(id)}`, "private, max-age=10");
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  send(res, "hello", { version });
  send(res, "status", statusPayload());
  send(res, "config", configPayload());
  send(res, "areas", areasPayload());
  send(res, "music", musicPayload());
  send(res, "ev", evPayload());
  send(res, "climate", climatePayload());
  send(res, "energy", energy.payload());
  send(res, "plex", plexPayload());
  send(res, "snapshot", Object.fromEntries(ha.states));
  clients.add(res);
  req.on("close", () => clients.delete(res));
}

async function handleService(req, res) {
  if (READ_ONLY) return json(res, 403, { error: "The add-on is in read-only mode." });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, err.status ?? 400, { error: err.message || "Invalid JSON." });
  }
  const check = validateServiceCall(body, allowed);
  if (!check.ok) return json(res, 400, { error: check.error });
  try {
    await ha.callService(check.domain, check.service, check.data, check.entityIds);
    logger.debug(`${check.domain}.${check.service} ${check.entityIds.join(",")}`);
    json(res, 200, { ok: true });
  } catch (err) {
    logger.warn(`Service call failed: ${err.message}`);
    json(res, 502, { error: err.message });
  }
}

// ---- read-only calendar page --------------------------------------------------------------

const CALENDAR_COLORS = ["#38bdf8", "#fb923c", "#a78bfa", "#f472b6", "#4ade80", "#facc15", "#f87171", "#2dd4bf"];
const calendarPageEnabled = () => Boolean(configStore.current.config?.calendar?.enabled);

/** The calendars of the page with their name, colour and what each may do (create, change, delete). */
function calendarPageList() {
  const cfg = configStore.current.config?.calendar;
  if (!cfg?.enabled) return [];
  const known = [...ha.entityIndex.keys()].filter((id) => id.startsWith("calendar."));
  const ids = cfg.entities.length ? cfg.entities : known.sort();
  return ids.map((id, i) => {
    return {
      id,
      name: cfg.names[id] ?? ha.entityIndex.get(id)?.name ?? ha.states.get(id)?.attributes?.friendly_name ?? id,
      color: cfg.colors[id] ?? CALENDAR_COLORS[i % CALENDAR_COLORS.length],
    };
  });
}

async function handleCalendarView(res, params) {
  if (!calendarPageEnabled()) return json(res, 404, { error: "The calendar page is not available." });
  const window = parseWindow(params.get("start"), params.get("end"));
  if (!window) return json(res, 400, { error: "Invalid time window." });
  const list = calendarPageList();
  try {
    const { events, failed } = await calendars.detailed(list.map((c) => c.id), window, haRest);
    return json(res, 200, { calendars: list, events, failed, editable: false });
  } catch (err) {
    logger.warn(`Calendar page failed: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

async function handleEnergy(res, params) {
  if (!configStore.current.config?.energy || configStore.current.config.energy.enabled === false) return json(res, 404, { error: "The Energy page is not available." });
  try {
    const data = await energy.overview({ date: params.get("date"), period: params.get("period") ?? "day" });
    return json(res, 200, data);
  } catch (err) {
    logger.warn(`Energy page failed: ${err.message}`);
    return json(res, err.status ?? 502, { error: err.message });
  }
}

async function handleCalendar(res, params) {
  const scope = calendarScope(configStore.current.config, [...ha.entityIndex.keys()]);
  const window = parseWindow(params.get("start"), params.get("end"));
  if (!window) return json(res, 400, { error: "Invalid time window." });
  const asked = params.get("entities");
  const ids = !asked || asked === "all" ? [...scope.calendars] : asked.split(",").filter((id) => scope.calendars.has(id));
  const weatherId = params.get("weather");
  try {
    const [events, forecast] = await Promise.all([
      calendars.events(ids, window),
      weatherId && scope.weather.has(weatherId) ? calendars.forecast(weatherId) : {},
    ]);
    const names = Object.fromEntries(ids.map((id) => [id, ha.entityIndex.get(id)?.name ?? ha.states.get(id)?.attributes?.friendly_name ?? id]));
    return json(res, 200, { calendars: names, events, forecast });
  } catch (err) {
    logger.warn(`Calendar request failed: ${err.message}`);
    return json(res, 502, { error: err.message });
  }
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" || req.method === "HEAD") {
      if (p === "/api/events") return handleEvents(req, res);
      if (p === "/api/config") return json(res, 200, configPayload());
      if (p === "/api/calendar") return await handleCalendar(res, url.searchParams);
      if (p === "/api/calendar/view") return await handleCalendarView(res, url.searchParams);
      if (p === "/api/energy") return await handleEnergy(res, url.searchParams);
      if (p === "/api/legacy/photos") return await handleLegacyPhotos(res);
      if (p === "/api/legacy/photo") return await handleLegacyPhoto(req, res, url.searchParams);
      if (p === "/api/legacy/cameras") return handleLegacyCameras(res);
      if (p === "/api/legacy/camera") return await handleLegacyCamera(res, url.searchParams.get("entity"));
      if (p === "/api/proxy") return await proxyImage(res, url.searchParams.get("path"));
      if (p === "/healthz") return json(res, 200, { ok: true, ha: ha.connected });
      if (p.startsWith("/icons/") && p.endsWith(".svg")) {
        const svg = iconSvg(p.slice("/icons/".length, -".svg".length));
        if (!svg) return json(res, 404, { error: "Unknown icon." });
        res.writeHead(200, { "Content-Type": MIME[".svg"], "Cache-Control": "public, max-age=604800" });
        return res.end(svg);
      }
      if (p.startsWith("/assets/")) {
        return serveFile(res, path.resolve(configStore.assetsDir), p.slice("/assets/".length), "no-cache");
      }
      if (p.startsWith("/api/")) return json(res, 404, { error: "Not found." });
      if (p === "/" || p === "/legacy") {
        res.writeHead(302, { Location: "legacy/" });
        return res.end();
      }
      const rel = p === "/legacy/" ? "legacy/index.html" : p.slice(1);
      const longCache = rel.startsWith("fonts/");
      return serveFile(res, webRoot, rel, longCache ? "public, max-age=31536000, immutable" : "no-cache");
    }
    if (req.method === "POST" && p === "/api/service") return await handleService(req, res);
    json(res, 405, { error: "Method not allowed." });
  } catch (err) {
    logger.error(`Unhandled error for ${req.method} ${p}: ${err.stack}`);
    if (!res.headersSent) json(res, 500, { error: "Internal error." });
    else res.end();
  }
});

const heartbeat = setInterval(() => clients.forEach((res) => res.write(": ping\n\n")), 20_000);
heartbeat.unref();

configStore.seedIfMissing(path.join(appRoot, "examples", "dashboard.yaml"));
configStore.watch();
menuOptionsSync?.update(configStore.current.config);
rescanImages();
allowed = new Set(configStore.current.entities);
ha.setWatched(allowed, { refresh: false });
ha.start();
setInterval(() => ha.connected && energy.refresh(), 60_000).unref();
setInterval(rescanImages, 3000).unref();

server.listen(PORT, () => logger.info(`Dasher Apple ${version} listening on :${server.address().port} (config: ${configStore.file})`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    ha.stop();
    clients.forEach((res) => res.end());
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
