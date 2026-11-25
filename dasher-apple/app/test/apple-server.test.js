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
    MA_URL: "", MA_TOKEN: "",
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
