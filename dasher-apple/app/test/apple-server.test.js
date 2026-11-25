import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import YAML from "yaml";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

function start(t, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: appRoot,
    env: { ...process.env, SUPERVISOR_TOKEN: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10_000);
    const finish = (error, port) => {
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("exit", exited);
      if (error) reject(error);
      else resolve(`http://127.0.0.1:${port}`);
    };
    const failed = (error) => finish(error);
    const exited = (code) => finish(new Error(`${script} exited (${code}): ${output}`));
    const collect = (chunk) => {
      output += chunk;
      const match = output.match(/listening on :(\d+)/);
      if (match) finish(null, match[1]);
    };
    child.on("error", failed);
    child.on("exit", exited);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
  });
}

test("Apple entrypoint, assets and standalone backend work without another Dasher installation", { timeout: 20_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dasher-apple-server-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const haUrl = await start(t, "dev/mock-ha.js", { MOCK_PORT: "0" });
  const optionsFile = path.join(dir, "options.json");
  await fs.writeFile(optionsFile, JSON.stringify({ read_only: true }));
  const url = await start(t, "src/index.js", {
    HA_URL: haUrl, HA_TOKEN: "dev", PORT: "0", LOG_LEVEL: "info",
    OPTIONS_FILE: optionsFile, CONFIG_DIR: path.join(dir, "config"), DATA_DIR: path.join(dir, "data"),
  });

  for (const route of ["/", "/legacy"]) {
    const response = await fetch(url + route, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "legacy/");
  }
  const html = await (await fetch(url + "/")).text();
  assert.match(html, /<title>Dasher Apple<\/title>/);
  assert.doesNotMatch(html, /standard-dashboard/);
  assert.equal((await fetch(url + "/index.html")).status, 404);
  for (const route of ["/legacy/legacy.js", "/legacy/legacy.css", "/icons/lightbulb.svg"]) {
    assert.equal((await fetch(url + route)).status, 200, route);
  }
  const config = await (await fetch(url + "/api/config")).json();
  assert.ok(config.config.pages.length);
  assert.ok(config.legacy.faces.includes("analog"));
  assert.equal((await fetch(url + "/api/legacy/photos")).status, 403);
  assert.equal((await fetch(url + "/api/legacy/cameras")).status, 403);

  let connected = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    connected = (await (await fetch(url + "/healthz")).json()).ha;
    if (connected) break;
    await delay(50);
  }
  assert.equal(connected, true, "standalone backend connects directly to mock HA");
  const command = await fetch(url + "/api/service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "light", service: "toggle", entity_id: "light.living_room_lamp", data: {} }),
  });
  assert.equal(command.status, 403);

  const addon = YAML.parse(await fs.readFile(new URL("../../config.yaml", import.meta.url), "utf8"));
  assert.equal(addon.slug, "dasher_apple");
  assert.equal(addon.ingress_port, 8100);
  assert.equal(addon.ports["8100/tcp"], 8100);
});

test("inherited features cannot be accessed even when old configuration enables them", { timeout: 20_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dasher-apple-inherited-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "dashboard.yaml"), `
pages:
  - id: home
    tiles:
      - { type: toggle, entity: light.living_room_lamp }
calendar: { entities: [calendar.family] }
family: { people: [{ entity: person.old, pin: "1234" }] }
meals: { enabled: true, auto: { weekday: wed, time: "00:00" }, shopping_list_entity: todo.old }
todo: { lists: [todo.old] }
devices: { vacuums: [vacuum.old] }
`);
  const options = path.join(dir, "options.json");
  await fs.writeFile(options, JSON.stringify({ allow_area_picture_upload: false }));
  const haUrl = await start(t, "dev/mock-ha.js", { MOCK_PORT: "0" });
  const url = await start(t, "src/index.js", {
    HA_URL: haUrl, HA_TOKEN: "dev", PORT: "0", OPTIONS_FILE: options,
    CONFIG_DIR: configDir, DATA_DIR: path.join(dir, "data"),
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await (await fetch(url + "/healthz")).json()).ha) break;
    await delay(50);
  }
  assert.equal((await (await fetch(url + "/healthz")).json()).ha, true);
  const config = (await (await fetch(url + "/api/config")).json()).config;
  for (const section of ["family", "meals", "todo", "devices"]) assert.equal(config[section], undefined);
  const service = (entity, domain, action) => fetch(url + "/api/service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, service: action, entity_id: entity, data: {} }),
  });
  assert.equal((await service("light.living_room_lamp", "light", "toggle")).status, 200);
  assert.equal((await service("todo.old", "todo", "add_item")).status, 400);
  for (const route of ["/api/family", "/api/meals", "/api/todo/items", "/api/music/library", "/api/plex/home"]) {
    assert.equal((await fetch(url + route)).status, 404, route);
  }
  for (const route of ["/api/family/chore-save", "/api/meals/generate", "/api/todo/create", "/api/calendar/event", "/api/areas/device", "/api/music/play", "/api/plex/play"]) {
    assert.equal((await fetch(url + route, { method: "POST" })).status, 405, route);
  }
  const calendar = await fetch(url + "/api/calendar/view?start=2026-01-01T00:00:00Z&end=2026-01-08T00:00:00Z");
  assert.equal(calendar.status, 200);
  assert.equal((await calendar.json()).editable, false);
  assert.equal((await fs.readdir(path.join(dir, "data")).catch((err) => {
    if (err.code === "ENOENT") return [];
    throw err;
  })).includes("meals.json"), false);
});
