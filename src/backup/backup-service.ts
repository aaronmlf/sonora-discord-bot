import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, lstat, copyFile, rm, open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { saveJson } from "../core/json-store.js";
import type { LibraryService } from "../library/library-service.js";
import type { PlaylistService } from "../playlists/playlist-service.js";
import type { PlayerManager } from "../player/player-manager.js";
import { sceneSchema, type SceneService } from "../scenes/scene-service.js";

const relativePath = z.string().max(1024).refine(value => /^(music|effects)\//.test(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part && !part.startsWith(".")));
const text = z.string().max(2048);
const track = z.object({ id: text.min(1), source: z.literal("local"), title: text, artist: text.optional(), album: text.optional(), category: z.enum(["music", "effect"]), relativePath, sizeBytes: z.number().int().nonnegative(), modifiedAt: z.string().datetime(), addedAt: z.string().datetime().optional(), durationMs: z.number().nonnegative().optional(), format: text.optional(), favorite: z.boolean().optional(), tags: z.array(z.string().max(40)).max(30).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const youtubeUrl = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && ["www.youtube.com", "youtube.com", "youtu.be", "music.youtube.com"].includes(url.hostname) && !url.username && !url.password; });
const external = z.object({ id: text, source: z.literal("youtube"), title: text, artist: text.optional(), category: z.literal("music"), durationMs: z.number().nonnegative().optional(), webpageUrl: youtubeUrl, originalUrl: z.string().url(), resolvedFrom: z.enum(["youtube", "spotify"]) });
const queued = z.union([track, external]).and(z.object({ entryId: text.optional(), requestedBy: text, requestedAt: z.string().datetime() }));
const session = z.object({ guildId: text.min(1), guildName: text, current: queued.nullable(), upcoming: z.array(queued).max(10000), repeatMode: z.enum(["off", "track", "queue"]), volume: z.number().min(0).max(100), effectVolume: z.number().min(0).max(150), environmentVolume: z.number().min(0).max(100).optional(), ducking: z.boolean().optional() }).transform(value => ({ ...value, status: "idle" as const, activeEffects: [], startedAt: null, pausedAt: null, error: null }));
const metadataSchema = z.object({
  library: z.object({ tracks: z.array(track).max(100000), trash: z.array(z.object({ track, deletedAt: z.string().datetime(), filename: z.string().regex(/^[a-f0-9-]+\.[a-z0-9]+$/) })).max(100000) }),
  playlists: z.array(z.object({ id: text, name: text, description: text.optional(), items: z.array(z.object({ id: text, trackId: text, addedAt: z.string().datetime() })).max(100000), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })).max(10000),
  scenes: z.array(sceneSchema.extend({ id: text })).max(10000),
  sessions: z.array(session).max(1000),
});
type Metadata = z.output<typeof metadataSchema>;
const line = (value: unknown) => JSON.stringify(value) + "\n";

export class BackupService {
  constructor(private readonly options: { dataDir: string; audioDir: string; maxBytes: number; library: LibraryService; playlists: PlaylistService; scenes: SceneService; players: PlayerManager }) {}
  private async metadata(): Promise<Metadata> {
    const { library, playlists, scenes, players } = this.options;
    return metadataSchema.parse({ library: await library.exportCatalog(), playlists: playlists.list(), scenes: scenes.list(), sessions: players.exportSessions() });
  }
  private files(metadata: Metadata): Map<string, number> {
    const files = new Map(metadata.library.tracks.map(track => [track.relativePath, track.sizeBytes]));
    for (const entry of metadata.library.trash) files.set(`.trash/${entry.filename}`, entry.track.sizeBytes);
    return files;
  }
  private async destination(relative: string): Promise<string> {
    const folder = path.dirname(relative);
    await this.options.library.safeFolder(folder, true, folder === ".trash");
    const file = path.join(this.options.audioDir, relative);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Destino de áudio inválido."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return file;
  }
  async export(includeAudio = false): Promise<Readable> {
    const metadata = await this.metadata();
    const files = this.files(metadata); const root = this.options.audioDir;
    const library = this.options.library;
    async function* records() {
      yield line({ type: "header", format: "sonora", version: 1, includeAudio });
      yield line({ type: "metadata", value: metadata });
      if (includeAudio) for (const [relative, size] of files) {
        const folder = path.dirname(relative); await library.safeFolder(folder, false, folder === ".trash");
        const file = path.join(root, relative); const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== size) throw new Error("Arquivo ausente ou alterado. Reindexe antes de exportar áudios.");
        yield line({ type: "file", path: relative, size });
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of createReadStream(file, { highWaterMark: 48 * 1024 })) {
          const buffer = chunk as Buffer; hash.update(buffer); bytes += buffer.length;
          yield line({ type: "chunk", data: buffer.toString("base64") });
        }
        if (bytes !== size) throw new Error("Áudio alterado durante backup.");
        yield line({ type: "end", hash: hash.digest("hex") });
      }
      yield line({ type: "complete" });
    }
    const output = createGzip();
    void pipeline(Readable.from(records()), output).catch(error => output.destroy(error));
    return output;
  }
  private async apply(metadata: Metadata): Promise<void> {
    // JSON cannot contain explicit undefined; normalize Zod's optional output fields.
    const clean = JSON.parse(JSON.stringify(metadata)) as { library: Parameters<LibraryService["importCatalog"]>[0]; playlists: Parameters<PlaylistService["importPlaylists"]>[0]; scenes: Parameters<SceneService["importScenes"]>[0]; sessions: Parameters<PlayerManager["importSessions"]>[0] };
    await this.options.library.importCatalog(clean.library);
    await this.options.playlists.importPlaylists(clean.playlists);
    await this.options.scenes.importScenes(clean.scenes);
    await this.options.players.importSessions(clean.sessions);
  }
  async restore(input: Readable): Promise<{ safetyBackup: string; audioFiles: number }> {
    await mkdir(this.options.dataDir, { recursive: true });
    const stage = await mkdtemp(path.join(this.options.dataDir, ".restore-"));
    const gzip = createGunzip();
    input.on("error", error => gzip.destroy(error)); input.pipe(gzip);
    let metadata: Metadata | null = null; let header = false; let audio = false; let complete = false;
    let current: { name: string; expected: number; bytes: number; hash: ReturnType<typeof createHash>; handle: Awaited<ReturnType<typeof open>> } | null = null;
    const staged = new Map<string, string>(); const completed = new Set<string>();
    let total = 0; let pending = "";
    const decoder = new StringDecoder("utf8");
    try {
      const consume = async (raw: string) => {
        const record = JSON.parse(raw);
        if (complete) throw new Error("Dados após o fim do backup.");
        if (!header) { if (record.type !== "header" || record.format !== "sonora" || record.version !== 1 || typeof record.includeAudio !== "boolean") throw new Error("Backup incompatível."); header = true; audio = record.includeAudio; return; }
        if (!metadata) {
          if (record.type !== "metadata") throw new Error("Metadados ausentes.");
          metadata = metadataSchema.parse(record.value);
          const ids = metadata.library.tracks.map(t => t.id).concat(metadata.library.trash.map(e => e.track.id));
          if (new Set(ids).size !== ids.length) throw new Error("Identificadores duplicados no catálogo.");
          const paths = metadata.library.tracks.map(t => t.relativePath).concat(metadata.library.trash.map(e => `.trash/${e.filename}`));
          if (new Set(paths).size !== paths.length) throw new Error("Arquivos duplicados no catálogo do backup.");
          return;
        }
        if (record.type === "file" && !current && audio) {
          const expected = this.files(metadata).get(record.path);
          if (expected === undefined || expected !== record.size || completed.has(record.path)) throw new Error("Arquivo não autorizado no backup.");
          const temporary = path.join(stage, randomUUID()); staged.set(record.path, temporary);
          current = { name: record.path, expected, bytes: 0, hash: createHash("sha256"), handle: await open(temporary, "wx", 0o600) }; return;
        }
        if (record.type === "chunk" && current) {
          if (typeof record.data !== "string" || record.data.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)) throw new Error("Bloco de áudio inválido.");
          const buffer = Buffer.from(record.data, "base64"); current.bytes += buffer.length;
          if (current.bytes > current.expected) throw new Error("Tamanho de áudio inválido.");
          current.hash.update(buffer); await current.handle.writeFile(buffer); return;
        }
        if (record.type === "end" && current) {
          if (current.bytes !== current.expected || current.hash.digest("hex") !== record.hash) throw new Error("Áudio incompleto ou corrompido.");
          await current.handle.close(); completed.add(current.name); current = null; return;
        }
        if (record.type === "complete" && !current) { if (audio && completed.size !== this.files(metadata).size) throw new Error("Faltam arquivos de áudio."); complete = true; return; }
        throw new Error("Estrutura de backup inválida.");
      };
      for await (const chunk of gzip) {
        total += (chunk as Buffer).length;
        if (total > this.options.maxBytes) throw new Error("Backup excede o limite de restauração (MAX_UPLOAD_MB), incluindo conteúdo descompactado.");
        pending += decoder.write(chunk as Buffer);
        let index: number;
        while ((index = pending.indexOf("\n")) !== -1) { const raw = pending.slice(0, index); pending = pending.slice(index + 1); await consume(raw); }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error("Registro muito grande.");
      }
      pending += decoder.end();
      if (!complete || !metadata || current || pending.trim()) throw new Error("Backup truncado.");
      const before = await this.metadata();
      const backupDir = path.join(this.options.dataDir, "backups"); await mkdir(backupDir, { recursive: true });
      const safetyBackup = `antes-restauracao-${Date.now()}-${randomUUID().slice(0, 8)}.sonora.gz`;
      await pipeline(await this.export(false), createWriteStream(path.join(backupDir, safetyBackup), { flags: "wx", mode: 0o600 }));
    const undo: { destination: string; original: string | null }[] = [];
      this.options.players.shutdown(); await this.options.players.flush();
      try {
        for (const [relative, source] of staged) {
          const destination = await this.destination(relative); let original: string | null = path.join(backupDir, `${randomUUID()}.audio`);
          try { await copyFile(destination, original); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; original = null; }
          undo.push({ destination, original });
          await saveJson(path.join(backupDir, `${safetyBackup}.files.json`), undo.map(item => ({ relativePath: path.relative(this.options.audioDir, item.destination), original: item.original ? path.basename(item.original) : null })));
          await copyFile(source, destination);
        }
        await this.apply(metadata);
      } catch (error) {
        for (const item of undo.reverse()) { if (item.original) await copyFile(item.original, item.destination); else await rm(item.destination, { force: true }); }
        await this.apply(before); throw error;
      }
      return { safetyBackup, audioFiles: staged.size };
    } finally { await (current as { handle: Awaited<ReturnType<typeof open>> } | null)?.handle.close(); gzip.destroy(); input.unpipe(gzip); input.resume(); await rm(stage, { recursive: true, force: true }); }
  }
}
