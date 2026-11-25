import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { AREA_DOMAINS, DEFAULT_AREA_DOMAINS } from "./areas.js";
import { ROOM_TYPES } from "./room-images.js";
import { collectEntities, describeUsage, mapEntities } from "../web/js/lib/entities.js";
import { STOCK_EXAMPLE_HASHES, hashDashboard } from "./stock-examples.js";
import { MAP_FILE, parseEntityMap, parseEntityMapOption } from "./mapping.js";
import { BUILTIN_MENU_ITEMS, RETIRED_MENU_ITEMS } from "../web/js/lib/menu.js";

export { collectEntities };

export const TILE_TYPES = new Set([
  "hero",
  "toggle",
  "price",
  "vehicle",
  "media",
  "climate",
  "buttons",
  "calendar",
  "dinner",
  "offers",
  "family",
]);

const ENTITY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const APPLE_TILE_TYPES = new Set(["hero", "toggle", "buttons", "vehicle", "calendar", "media"]);

function applePageEntities(pages) {
  return collectEntities(pages.map((page) => ({
    ...page,
    tiles: (Array.isArray(page?.tiles) ? page.tiles : []).filter((tile) => APPLE_TILE_TYPES.has(tile?.type)),
  })));
}

const slugify = (s) =>
  String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const posInt = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};


const toList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);

function parseMenuItems(raw, pages, errors) {
  if (!Array.isArray(raw)) {
    errors.push("menu_items: must be a list of menu-item overrides in the app configuration.");
    return [];
  }
  const builtins = new Set(BUILTIN_MENU_ITEMS.map((item) => item.id));
  const custom = new Set(pages.map((page) => `page:${page.id}`));
  const seen = new Set();
  const items = [];
  for (const [i, value] of raw.entries()) {
    const where = `menu_items[${i}]`;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string") {
      errors.push(`${where}: needs a menu item id.`);
      continue;
    }
    const input = value.id.trim();
    if (RETIRED_MENU_ITEMS.has(input)) continue;
    const id = builtins.has(input) || custom.has(input) ? input : `page:${input}`;
    if (!builtins.has(id) && !custom.has(id)) {
      errors.push(`${where}.id: "${input}" is not a built-in menu item or dashboard page id.`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${where}.id: duplicate menu item "${input}".`);
      continue;
    }
    seen.add(id);
    const item = { id };
    if (value.visibility != null && !["default", "show", "hide"].includes(value.visibility)) {
      errors.push(`${where}.visibility: use default, show or hide.`);
    }
    if (value.visibility === "show" || value.visibility === "hide") {
      item.visible = value.visibility === "show";
    } else if (value.visibility !== "default" && value.visible != null) {
      if (typeof value.visible === "boolean") item.visible = value.visible;
      else errors.push(`${where}.visible: must be true or false.`);
    }
    for (const key of ["title", "icon"]) {
      if (value[key] == null || value[key] === "") continue;
      if (typeof value[key] === "string" && value[key].trim()) item[key] = value[key].trim();
      else errors.push(`${where}.${key}: must be a non-empty string.`);
    }
    if (value.order != null) {
      if (Number.isSafeInteger(value.order) && value.order >= 0) item.order = value.order;
      else errors.push(`${where}.order: must be a non-negative integer.`);
    }
    items.push(item);
  }
  return items;
}

function menuSection(raw, item) {
  if (!item || item.visible == null) return raw;
  const section = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { ...section, enabled: item.visible };
}

/** Normalise the optional `areas:` section; problems are pushed to `errors`. */
function parseAreas(raw, errors) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const domains = toList(a.domains).filter((d) => {
    const ok = AREA_DOMAINS.has(d);
    if (!ok) errors.push(`areas.domains: "${d}" is not supported. Use: ${[...AREA_DOMAINS].join(", ")}.`);
    return ok;
  });

  const overrides = {};
  const source = a.overrides && typeof a.overrides === "object" ? a.overrides : {};
  for (const [areaId, value] of Object.entries(source)) {
    const o = value && typeof value === "object" ? value : {};
    const clean = {};
    if (o.name != null) clean.name = String(o.name);
    if (o.icon != null) clean.icon = String(o.icon);
    if (o.image != null) clean.image = String(o.image);
    if (o.room != null) {
      if (ROOM_TYPES.includes(String(o.room))) clean.room = String(o.room);
      else errors.push(`areas.overrides.${areaId}.room: "${o.room}" is not a room type. Use: ${ROOM_TYPES.join(", ")}.`);
    }
    if (o.hide === true) clean.hide = true;
    for (const key of ["temperature_entity", "humidity_entity"]) {
      if (o[key] == null) continue;
      if (ENTITY_RE.test(String(o[key]))) clean[key] = String(o[key]);
      else errors.push(`areas.overrides.${areaId}.${key}: invalid entity id "${o[key]}"`);
    }
    if (o.window_entities != null) {
      const ids = toList(o.window_entities);
      const bad = ids.filter((e) => !ENTITY_RE.test(e));
      if (bad.length) errors.push(`areas.overrides.${areaId}.window_entities: invalid entity id(s): ${bad.join(", ")}`);
      clean.window_entities = ids.filter((e) => ENTITY_RE.test(e));
    }
    overrides[areaId] = clean;
  }

  return {
    enabled: a.enabled !== false,
    title: a.title != null ? String(a.title) : null,
    icon: String(a.icon ?? "floor-plan"),
    hide: toList(a.hide),
    default_images: a.default_images !== false,
    domains: domains.length ? domains : DEFAULT_AREA_DOMAINS,
    overrides,
  };
}

/** Normalise the optional `music:` section (alias: `radio:`) for the Music Assistant page. */
function parseMusic(raw, errors) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = (key) => {
    const list = toList(r[key]);
    const bad = list.filter((e) => !ENTITY_RE.test(e) || !e.startsWith("media_player."));
    if (bad.length) errors.push(`music.${key}: not a media_player entity id: ${bad.join(", ")}`);
    return list.filter((e) => !bad.includes(e));
  };
  const players = ids("players");
  const exclude = ids("exclude");
  return {
    enabled: r.enabled !== false,
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "music"),
    players,
    exclude,
  };
}

export const EV_ROLES = [
  "battery_entity",
  "range_entity",
  "plug_entity",
  "charging_entity",
  "charge_switch_entity",
  "start_entity",
  "stop_entity",
  "smart_switch_entity",
  "smart_status_entity",
  "smart_info_entity",
  "start_time_entity",
  "ready_time_entity",
  "restart_entity",
  "remote_start_entity",
  "remote_temp_entity",
  "defrost_front_entity",
  "defrost_rear_entity",
];

/** Normalise the optional `ev:` section (the car page). Entities not listed are found automatically. */
function parseEv(raw, errors) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const roles = {};
  for (const key of EV_ROLES) {
    if (r[key] == null) continue;
    const id = String(r[key]);
    if (ENTITY_RE.test(id)) roles[key] = id;
    else errors.push(`ev.${key}: invalid entity id "${id}"`);
  }
  const enabled = r.enabled === false ? false : r.enabled === true ? true : "auto";
  return {
    enabled,
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "car-electric"),
    name: r.name != null ? String(r.name) : null,
    image: r.image != null ? String(r.image) : null,
    roles,
  };
}

/**
 * Normalise the optional `calendar:` section (the calendar page with month and planner views). Off without the
 * section; `calendar: true` (or the app option) shows every calendar of Home Assistant.
 */
function parseCalendarPage(raw, errors) {
  if (raw == null || raw === false) return { enabled: false };
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const entities = [];
  for (const id of toList(r.entities)) {
    if (ENTITY_RE.test(id) && id.startsWith("calendar.")) entities.push(id);
    else errors.push(`calendar.entities: "${id}" is not a calendar entity id`);
  }
  const names = {};
  const colors = {};
  for (const [id, name] of Object.entries(r.names && typeof r.names === "object" ? r.names : {})) if (ENTITY_RE.test(id) && name != null) names[id] = String(name).slice(0, 30);
  for (const [id, color] of Object.entries(r.colors && typeof r.colors === "object" ? r.colors : {})) {
    if (ENTITY_RE.test(id) && /^#[0-9a-fA-F]{6}$/.test(String(color))) colors[id] = String(color);
    else errors.push(`calendar.colors.${id}: use a colour like #38bdf8`);
  }
  return {
    enabled: r.enabled !== false,
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "calendar-month"),
    entities,
    names,
    colors,
    week_start: r.week_start === "sun" ? "sun" : "mon",
    view: r.view === "planner" ? "planner" : "month",
  };
}

/** Normalise the optional `plex:` section (the Media page). */
function parsePlex(raw, errors) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = (key) => {
    const out = [];
    for (const id of toList(r[key])) {
      if (ENTITY_RE.test(id) && id.startsWith("media_player.")) out.push(id);
      else errors.push(`plex.${key}: "${id}" is not a media player entity id`);
    }
    return out;
  };
  return {
    enabled: r.enabled === false ? false : r.enabled === true ? true : "auto",
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "movie-open-outline"),
    players: ids("players"),
    exclude: ids("exclude"),
  };
}

/** Normalise the optional `climate:` section (the climate overview page). */
function parseClimate(raw, errors) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = (key) => {
    const out = [];
    for (const id of toList(r[key])) {
      if (ENTITY_RE.test(id) && id.startsWith("climate.")) out.push(id);
      else errors.push(`climate.${key}: "${id}" is not a climate entity id`);
    }
    return out;
  };
  const source = r.source === "all" ? "all" : "helpers";
  if (r.source != null && !["all", "helpers"].includes(r.source)) errors.push(`climate.source must be "helpers" or "all"`);
  return {
    enabled: r.enabled === false ? false : r.enabled === true ? true : "auto",
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "home-thermometer-outline"),
    source,
    entities: ids("entities"),
    exclude: ids("exclude"),
    platforms: toList(r.platforms).filter((p) => /^[a-z0-9_]+$/.test(p)),
  };
}

function parseEnergy(raw, errors) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw != null && typeof raw !== "boolean" && (typeof raw !== "object" || Array.isArray(raw))) errors.push("energy: use true, false or a mapping.");
  if (r.enabled != null && ![true, false, "auto"].includes(r.enabled)) errors.push('energy.enabled: use true, false or "auto".');
  return {
    enabled: raw === false || r.enabled === false ? false : raw === true || r.enabled === true ? true : "auto",
    title: r.title != null ? String(r.title) : null,
    icon: String(r.icon ?? "lightning-bolt-outline"),
  };
}

/**
 * Parse and normalise a dashboard.yaml document.
 * Never throws: problems end up in `errors` and offending tiles are dropped.
 */
/** App menu overrides take precedence; the calendar switch fills in a missing section. */
export function parseConfig(text, { entityMap = {}, calendarPage: calendarPageOption = false, menuItems: menuItemsOption = [], weatherBackground: weatherBackgroundOption = true } = {}) {
  const errors = [];
  const failed = (message) => ({ config: null, errors: [message], entities: new Set(), rawEntities: new Set(), usage: new Map() });
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    return failed(`YAML syntax error: ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failed("The file must contain a YAML mapping.");
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return failed("`pages` must be a non-empty list.");

  // The entities as written in the file, before the user's mapping replaces some of them.
  const rawEntities = applePageEntities(raw.pages);
  collectEntities(raw.areas?.overrides ?? {}, rawEntities);
  collectEntities(raw.ev ?? {}, rawEntities);
  collectEntities(raw.climate ?? {}, rawEntities);
  for (const id of toList(raw.plex?.players)) rawEntities.add(id);
  collectEntities(raw.calendar ?? {}, rawEntities);
  for (const id of [...rawEntities]) if (!ENTITY_RE.test(id)) rawEntities.delete(id);
  const usage = describeUsage(raw);
  if (Object.keys(entityMap).length) raw = mapEntities(raw, entityMap);

  const defaults = {
    columns: posInt(raw.columns, 4),
    rows: posInt(raw.rows, 2),
    gap: Number.isFinite(Number(raw.gap)) ? Number(raw.gap) : 8,
  };

  const usedIds = new Set();
  const pages = raw.pages.map((page, i) => {
    const p = page && typeof page === "object" ? page : {};
    let id = slugify(p.id ?? p.title ?? "") || `page-${i + 1}`;
    while (usedIds.has(id)) id += "-x";
    usedIds.add(id);
    const label = `pages[${i}] (${id})`;

    const tiles = [];
    for (const [j, tile] of (Array.isArray(p.tiles) ? p.tiles : []).entries()) {
      const where = `${label}.tiles[${j}]`;
      if (!tile || typeof tile !== "object" || !TILE_TYPES.has(tile.type)) {
        errors.push(`${where}: unknown tile type "${tile?.type}". Use one of: ${[...TILE_TYPES].join(", ")}.`);
        continue;
      }
      const bad = [...collectEntities(tile)].filter((e) => !ENTITY_RE.test(e));
      if (bad.length) {
        errors.push(`${where}: invalid entity id(s): ${bad.join(", ")}`);
        continue;
      }
      if (tile.type === "hero") {
        if (tile.weather_background != null && typeof tile.weather_background !== "boolean") errors.push(`${where}.weather_background: use true or false.`);
        for (const [key, domain] of [["weather_entity", "weather"], ["sun_entity", "sun"]]) {
          if (tile[key] != null && (typeof tile[key] !== "string" || !tile[key].startsWith(`${domain}.`))) {
            errors.push(`${where}.${key}: use a ${domain} entity id.`);
            delete tile[key];
          }
        }
      }
      tiles.push({
        ...tile,
        ...(tile.type === "hero" ? { weather_background: weatherBackgroundOption !== false && (typeof tile.weather_background === "boolean" ? tile.weather_background : i === 0) } : {}),
        col: tile.col == null ? null : posInt(tile.col, null),
        row: tile.row == null ? null : posInt(tile.row, null),
        w: posInt(tile.w, 1),
        h: posInt(tile.h, 1),
      });
    }

    return {
      id,
      title: String(p.title ?? id),
      icon: String(p.icon ?? "view-dashboard"),
      columns: posInt(p.columns, defaults.columns),
      rows: posInt(p.rows, defaults.rows),
      gap: Number.isFinite(Number(p.gap)) ? Number(p.gap) : defaults.gap,
      tiles,
    };
  });

  const menuItems = parseMenuItems(menuItemsOption, pages, errors);
  const menuOverrides = new Map(menuItems.map((item) => [item.id, item]));
  const section = (id, value) => menuSection(value, menuOverrides.get(id));
  for (const page of pages) {
    const item = menuOverrides.get(`page:${page.id}`);
    if (item?.title) page.title = item.title;
    if (item?.icon) page.icon = item.icon;
  }
  const areas = parseAreas(section("areas", raw.areas), errors);
  const music = parseMusic(section("music", raw.music ?? raw.radio), errors);
  const ev = parseEv(section("ev", raw.ev), errors);
  const climate = parseClimate(section("climate", raw.climate), errors);
  const energy = parseEnergy(section("energy", raw.energy), errors);
  const plex = parsePlex(section("media", raw.plex), errors);
  const calendarPage = parseCalendarPage(section("calendar", raw.calendar === undefined && calendarPageOption ? true : raw.calendar), errors);

  const config = {
    title: String(raw.title ?? "Dasher Apple"),
    language: String(raw.language ?? "en"),
    locale: raw.locale ? String(raw.locale) : null,
    accent: String(raw.accent ?? "#2dd4bf"),
    idle_return: Number(raw.idle_return) > 0 ? Number(raw.idle_return) : 0,
    areas,
    music,
    ev,
    climate,
    energy,
    plex,
    calendar: calendarPage,
    menu_items: menuItems,
    pages,
  };
  for (const { id, section } of BUILTIN_MENU_ITEMS) {
    const item = menuOverrides.get(id);
    if (item?.title) config[section].title = item.title;
    if (item?.icon) config[section].icon = item.icon;
  }

  const entities = applePageEntities(pages);
  collectEntities(areas.overrides, entities);
  for (const id of Object.values(ev.roles)) entities.add(id);
  for (const id of climate.entities) entities.add(id);
  for (const id of plex.players) entities.add(id);
  for (const id of calendarPage.entities ?? []) entities.add(id);
  for (const id of music.players) entities.add(id);
  return { config, errors, entities, rawEntities, usage };
}

/** Watches dashboard.yaml and keeps the parsed result current. */
export class ConfigStore {
  /** `entityMapOption`: the app option `entity_map` (a list of { from, to }). */
  constructor({ dir, onChange, logger, entityMapOption = [], calendarPageOption = false, menuItemsOption = [], weatherBackgroundOption = true }) {
    this.weatherBackgroundOption = weatherBackgroundOption !== false;
    this.menuItemsOption = menuItemsOption;
    this.calendarPageOption = calendarPageOption === true;
    this.dir = dir;
    this.optionMap = parseEntityMapOption(entityMapOption);
    this._legacyLogged = false;
    this.file = path.join(dir, "dashboard.yaml");
    this.mapFile = path.join(dir, MAP_FILE);
    this.entityMap = {};
    this.assetsDir = path.join(dir, "assets");
    this.onChange = onChange;
    this.log = logger;
    this.current = { config: null, errors: ["Not loaded yet."], entities: new Set(), rawEntities: new Set(), usage: new Map() };
    this._signature = "";
  }

  seedIfMissing(examplePath) {
    fs.mkdirSync(this.assetsDir, { recursive: true });
    for (const sub of ["areas", "entities"]) fs.mkdirSync(path.join(this.assetsDir, sub), { recursive: true });
    const example = fs.readFileSync(examplePath, "utf8");
    // Always keep a current copy of the example next to the dashboard, to compare or copy from.
    try {
      fs.writeFileSync(path.join(this.dir, "dashboard.example.yaml"), example);
    } catch (err) {
      this.log.warn(`Could not write dashboard.example.yaml: ${err.message}`);
    }
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, example);
      this.log.info(`Created example configuration at ${this.file}`);
      return;
    }
    // An untouched dashboard from an older version follows the app's updates; an edited one is never changed.
    const existing = fs.readFileSync(this.file, "utf8");
    const hash = hashDashboard(existing);
    if (hash !== hashDashboard(example) && STOCK_EXAMPLE_HASHES.has(hash)) {
      fs.writeFileSync(`${this.file}.bak`, existing);
      fs.writeFileSync(this.file, example);
      this.log.info(`dashboard.yaml was the unedited example of an older version and has been updated (old copy: dashboard.yaml.bak)`);
    }
  }

  load() {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      this.current = { config: null, errors: [`Cannot read ${this.file}: ${err.message}`], entities: new Set(), rawEntities: new Set(), usage: new Map() };
      return this.current;
    }
    this.entityMap = this._readEntityMap();
    this.current = parseConfig(text, { entityMap: this.entityMap, calendarPage: this.calendarPageOption, menuItems: this.menuItemsOption, weatherBackground: this.weatherBackgroundOption });
    for (const e of this.current.errors) this.log.warn(`${e.startsWith("menu_items") ? "App configuration" : "dashboard.yaml"}: ${e}`);
    return this.current;
  }

  /** The mapping: the app option, over the entity-map.yaml that older versions wrote. */
  _readEntityMap() {
    if (!this._optionLogged) {
      this._optionLogged = true;
      for (const e of this.optionMap.errors) this.log.warn(e);
    }
    let legacy = {};
    try {
      const { map, errors } = parseEntityMap(fs.readFileSync(this.mapFile, "utf8"));
      for (const e of errors) this.log.warn(e);
      legacy = map;
    } catch {
      // no file: nothing to carry over
    }
    const unmoved = Object.keys(legacy).filter((id) => !Object.hasOwn(this.optionMap.map, id));
    if (unmoved.length && !this._legacyLogged) {
      this._legacyLogged = true;
      this.log.warn(
        `${MAP_FILE} is still used for ${unmoved.length} mapping(s). Copy them to the app option "Entity mapping" (Settings, Apps, Dasher, Configuration): ${unmoved.map((id) => `${id} -> ${legacy[id]}`).join(", ")}`,
      );
    }
    return { ...legacy, ...this.optionMap.map };
  }

  _fileSignature() {
    const part = (file) => {
      try {
        const st = fs.statSync(file);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return "missing";
      }
    };
    return `${part(this.file)}|${part(this.mapFile)}`;
  }

  /** Poll for changes (inotify is unreliable on bind mounts and atomic saves). */
  watch(intervalMs = 2000) {
    const check = () => {
      const sig = this._fileSignature();
      if (sig !== this._signature) {
        const first = this._signature === "";
        this._signature = sig;
        this.load();
        if (!first) {
          this.log.info("Configuration changed, reloading");
          this.onChange?.(this.current);
        }
      }
    };
    check();
    this._timer = setInterval(check, intervalMs);
    this._timer.unref?.();
  }
}
