import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Smoke-test the extracted release with no Discord login or user audio.
const target = process.argv[2];
assert(target, "Uso: node scripts/smoke-host.mjs CAMINHO_DO_PACOTE_EXTRAIDO");
const temp = await mkdtemp(path.join(tmpdir(), "sonora-smoke-"));
const host = "127.0.0.1";
let child;
let closed;
let stopped;
let output = "";

try {
  const listener = createServer();
  const port = await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, host, () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
  const overrides = {
    DOTENV_CONFIG_PATH: path.join(temp, "no.env"), DISCORD_TOKEN: "", DISCORD_CLIENT_ID: "", DISCORD_GUILD_ID: "",
    HOST: host, PORT: String(port), ADMIN_TOKEN: "", REMOTE_ACCESS_ENABLED: "false", PUBLIC_URL: "",
    AUDIO_DIR: path.join(temp, "audio"), DATA_DIR: path.join(temp, "data"), YTDLP_COOKIES_FILE: "", LOG_LEVEL: "info",
  };
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !Object.hasOwn(overrides, key.toUpperCase())));
  child = spawn(process.execPath, ["dist/src/index.js"], {
    cwd: path.resolve(target), env: { ...inherited, ...overrides }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const append = (chunk) => { output = (output + chunk).slice(-8_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => { stopped = error; });
  closed = new Promise((resolve) => child.once("close", (code, signal) => {
    stopped ??= new Error(`O processo encerrou (código ${code}, sinal ${signal})`);
    resolve();
  }));
  const base = `http://${host}:${port}`;
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (stopped) throw stopped;
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      healthy = response.ok && (await response.json()).status === "ok";
      if (healthy) break;
    } catch { /* The server may still be starting. */ }
    await delay(200);
  }
  assert(healthy, "O pacote não respondeu em /api/health");
  const panel = await fetch(`${base}/`, { signal: AbortSignal.timeout(2_000) });
  assert(panel.ok, "O painel não respondeu");
  assert.match(await panel.text(), /<title>Sonora/);
  assert(!stopped, "O processo saiu após iniciar");
  console.log(`Pacote extraído: painel e API funcionando em ${process.platform}/${process.arch}.`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child && !stopped) child.kill("SIGTERM");
  if (closed) await Promise.race([closed, delay(4_000, undefined, { ref: false })]);
  if (child && !stopped) { child.kill("SIGKILL"); await closed; }
  await rm(temp, { recursive: true, force: true });
}
