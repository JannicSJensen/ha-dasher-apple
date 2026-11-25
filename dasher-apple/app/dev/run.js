import { spawn } from "node:child_process";

const haPort = process.env.MOCK_PORT ?? "8123";
const maPort = process.env.MA_PORT ?? "8095";
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}

function start(script, env) {
  const child = spawn(process.execPath, [script], { stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  child.on("error", (error) => {
    console.error(`Could not start ${script}: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${script} stopped (${signal ?? code}).`);
      stop(code || 1);
    }
  });
}

start("dev/mock-ha.js", { MOCK_PORT: haPort });
start("dev/mock-ma.js", { MA_PORT: maPort });
start("src/index.js", {
  SUPERVISOR_TOKEN: "",
  HA_URL: `http://127.0.0.1:${haPort}`,
  HA_TOKEN: "dev",
  MA_URL: `http://127.0.0.1:${maPort}`,
  MA_TOKEN: "dev-token",
  CONFIG_DIR: "./dev/config",
  DATA_DIR: "./dev/data",
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
