import { execFile } from "node:child_process";
import { getCiphers } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let failures = 0;

async function check(name, test, hint, required = true) {
  try {
    await test();
    console.log(`OK: ${name}`);
  } catch {
    if (required) failures++;
    console.log(`${required ? "FALHOU" : "AVISO"}: ${name}. ${hint}`);
  }
}

console.log(`Sonora - diagnóstico local: ${process.platform} ${process.arch}, Node ${process.versions.node}`);

await check("Node.js 22.12 ou superior", () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error("Node incompatível");
}, "Atualize o Node antes de instalar as dependências.");

let config;
await check("Configuração do painel e da pasta de áudio", async () => {
  const { loadConfig } = await import("../dist/src/config.js");
  config = loadConfig();
}, "Confira o .env e se o pacote foi compilado. Execute npm ci --omit=dev no aparelho.");

if (!config?.discordToken || !config?.discordClientId) {
  console.log("AVISO: configure DISCORD_TOKEN e DISCORD_CLIENT_ID no .env para entrar no Discord.");
}

const command = (file, args) => execFileAsync(file, args, { timeout: 8_000, maxBuffer: 256 * 1024 });
await check("Saída PCM local com FFmpeg", async () => {
  const { stdout } = await command("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.1", "-f", "s16le", "pipe:1",
  ]);
  if (!stdout.length) throw new Error("FFmpeg sem saída PCM");
}, "Instale o FFmpeg pelo gerenciador de pacotes do aparelho.");
await check("FFprobe para indexar a biblioteca", () => command("ffprobe", ["-version"]),
  "Instale o FFprobe, normalmente incluído no pacote ffmpeg.");

await check("Codificador Opus para o Discord", async () => {
  const { createAudioResource, StreamType } = await import("@discordjs/voice");
  const pcm20ms = Buffer.alloc(48_000 * 2 * 2 * 0.02);
  const resource = createAudioResource(Readable.from([pcm20ms]), { inputType: StreamType.Raw });
  for await (const packet of resource.playStream) if (packet.length) return;
  throw new Error("Nenhum pacote Opus");
}, "Reinstale as dependências com npm ci --omit=dev diretamente neste aparelho.");

await check("Criptografia DAVE para voz", () => {
  const requireFromVoice = createRequire(import.meta.resolve("@discordjs/voice"));
  const { DAVESession, DAVE_PROTOCOL_VERSION } = requireFromVoice("@snazzah/davey");
  const session = new DAVESession(DAVE_PROTOCOL_VERSION, "100000000000000001", "100000000000000002");
  if (!session.getSerializedKeyPackage().length) throw new Error("DAVE sem pacote de chaves");
}, "Reinstale com npm ci --omit=dev, mantendo as dependências opcionais. Em Android, prefira ARM de 64 bits.");

await check("Suporte ao modo de criptografia AES-GCM do Discord", () => {
  if (!getCiphers().includes("aes-256-gcm")) throw new Error("AES-GCM ausente");
}, "Use uma instalação do Node com suporte a AES-GCM.");

await check("yt-dlp para links externos", () => command(config?.ytDlpPath ?? "yt-dlp", ["--version"]),
  "A biblioteca local funciona. Instale e configure yt-dlp para usar links do YouTube/Spotify.", false);

if (failures) process.exitCode = 1;
else console.log("Diagnóstico local concluído. O teste de voz pela rede é feito com /join e /play no Discord.");
