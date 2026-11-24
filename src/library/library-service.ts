import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, unlink, lstat, copyFile } from "node:fs/promises";
import { saveJson } from "../core/json-store.js";
import path from "node:path";
import { promisify } from "node:util";

import type { AudioCategory, LibraryTrack } from "../types.js";
import { portableLibraryPath } from "./library-path.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".wav",
  ".ogg",
  ".opus",
  ".m4a",
  ".aac",
  ".webm",
]);

interface ProbeOutput {
  format?: {
    duration?: string;
    format_name?: string;
    tags?: {
      title?: string;
      artist?: string;
      album?: string;
    };
  };
}

interface TrackOverride {
  favorite?: boolean;
  tags?: string[];
  title?: string;
  artist?: string | null;
  album?: string | null;
  category?: AudioCategory;
}

interface PersistedLibraryV1 {
  version: 1;
  scannedAt: string;
  tracks: LibraryTrack[];
}

interface PersistedLibraryV2 {
  version: 2 | 3;
  trash?: TrashEntry[];
  scannedAt: string;
  tracks: LibraryTrack[];
  overrides: Record<string, TrackOverride>;
}

type PersistedLibrary = PersistedLibraryV1 | PersistedLibraryV2;

export interface LibraryTrackUpdate {
  favorite?: boolean | undefined;
  tags?: string[] | undefined;
  title?: string | undefined;
  artist?: string | null | undefined;
  album?: string | null | undefined;
  category?: AudioCategory | undefined;
}

export interface TrashEntry { track: LibraryTrack; deletedAt: string; filename: string }

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function categoryFor(relativePath: string): AudioCategory {
  return relativePath.split("/")[0]?.toLowerCase() === "effects"
    ? "effect"
    : "music";
}

function fileFingerprint(
  relativePath: string,
  sizeBytes: number,
  modifiedAt: string,
): string {
  return `${path.basename(relativePath).toLocaleLowerCase("pt-BR")}\u0000${sizeBytes}\u0000${modifiedAt}`;
}

async function walk(directory: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

export class LibraryService {
  private trash: TrashEntry[] = [];
  private mutation: Promise<unknown> = Promise.resolve();
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutation.catch(() => {}).then(operation);
    this.mutation = task;
    return task;
  }
  listTrash(): TrashEntry[] { return structuredClone(this.trash); }
  async exportCatalog(): Promise<{ tracks: LibraryTrack[]; trash: TrashEntry[] }> {
    return this.exclusive(async () => ({ tracks: this.list(), trash: this.listTrash() }));
  }
  async importCatalog(catalog: { tracks: LibraryTrack[]; trash: TrashEntry[] }): Promise<void> {
    return this.exclusive(async () => {
      this.tracks = structuredClone(catalog.tracks); this.trash = structuredClone(catalog.trash);
      this.normalizeCatalogPaths();
      this.overrides = Object.fromEntries([...this.tracks, ...this.trash.map(entry => entry.track)].map(track => [track.id, { title: track.title, artist: track.artist ?? null, album: track.album ?? null, category: track.category, tags: track.tags ?? [], favorite: track.favorite ?? false }]));
      this.sortTracks(); await this.persist();
    });
  }
  knownIds(): Set<string> { return new Set([...this.tracks.map(t => t.id), ...this.trash.map(t => t.track.id)]); }
  duplicates(): LibraryTrack[][] {
    const groups = new Map<string, LibraryTrack[]>();
    for (const track of this.tracks) if (track.contentHash) groups.set(track.contentHash, [...(groups.get(track.contentHash) ?? []), { ...track }]);
    return [...groups.values()].filter(group => group.length > 1);
  }
  private tracks: LibraryTrack[] = [];
  private overrides: Record<string, TrackOverride> = {};
  private readonly metadataPath: string;
  private scanTask: Promise<LibraryTrack[]> | null = null;
  private scanStatus = { running: false, processed: 0, total: 0, errors: [] as Array<{ file: string; message: string }> };

  getScanStatus() { return structuredClone(this.scanStatus); }

  constructor(
    private readonly audioDir: string,
    dataDir: string,
  ) {
    this.metadataPath = path.join(dataDir, "library.json");
  }

  async initialize(scan = true): Promise<void> {
    await mkdir(path.join(this.audioDir, "music"), { recursive: true });
    await mkdir(path.join(this.audioDir, "effects"), { recursive: true });
    await mkdir(path.dirname(this.metadataPath), { recursive: true });

    try {
      const persisted = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as PersistedLibrary;
      if (![1, 2, 3].includes(persisted.version) || !Array.isArray(persisted.tracks)) throw new Error("Catálogo de biblioteca inválido ou de uma versão não suportada. O arquivo foi preservado.");
      if (persisted.version === 1 && Array.isArray(persisted.tracks)) {
        this.tracks = persisted.tracks;
      } else if ((persisted.version === 2 || persisted.version === 3) && Array.isArray(persisted.tracks)) {
        this.tracks = persisted.tracks;
        this.overrides = persisted.overrides ?? {};
        this.trash = persisted.trash ?? [];
      }
      if (persisted.version !== 3) await copyFile(this.metadataPath, `${this.metadataPath}.pre-v3-${Date.now()}.bak`);
      this.normalizeCatalogPaths();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    if (scan) await this.scan();
  }

  list(category?: AudioCategory): LibraryTrack[] {
    return this.tracks
      .filter((track) => !category || track.category === category)
      .map((track) => ({ ...track }));
  }

  get(trackId: string): LibraryTrack | null {
    const track = this.tracks.find(({ id }) => id === trackId);
    return track ? { ...track } : null;
  }

  async update(trackId: string, update: LibraryTrackUpdate): Promise<LibraryTrack> {
    return this.exclusive(() => this.updateInternal(trackId, update));
  }
  private async updateInternal(trackId: string, update: LibraryTrackUpdate): Promise<LibraryTrack> {
    const index = this.tracks.findIndex(({ id }) => id === trackId);
    const current = this.tracks[index];
    if (index < 0 || !current) throw new Error("Audio nao encontrado.");

    const existing = this.overrides[trackId] ?? {};
    const nextOverride: TrackOverride = {
      ...existing,
      ...(update.favorite !== undefined ? { favorite: update.favorite } : {}),
      ...(update.tags !== undefined ? { tags: [...new Set(update.tags.map(tag => tag.trim()).filter(Boolean))] } : {}),
      ...(update.title !== undefined ? { title: update.title.trim() } : {}),
      ...(update.artist !== undefined
        ? { artist: cleanOptional(update.artist ?? "") ?? null }
        : {}),
      ...(update.album !== undefined
        ? { album: cleanOptional(update.album ?? "") ?? null }
        : {}),
      ...(update.category !== undefined ? { category: update.category } : {}),
    };
    if (nextOverride.title !== undefined && !nextOverride.title) {
      throw new Error("O titulo do audio nao pode ficar vazio.");
    }

    this.overrides[trackId] = nextOverride;
    const updated = this.applyOverride(current, nextOverride);
    this.tracks[index] = updated;
    this.sortTracks();
    await this.persist();
    return { ...updated };
  }

  async delete(trackId: string): Promise<LibraryTrack> {
    return this.exclusive(() => this.trashInternal(trackId));
  }
  private async trashInternal(trackId: string): Promise<LibraryTrack> {
    const index = this.tracks.findIndex(({ id }) => id === trackId);
    const track = this.tracks[index];
    if (index < 0 || !track) throw new Error("Audio nao encontrado.");

    const folder = await this.safeFolder(".trash", true, true);
    const filename = randomUUID() + path.extname(track.relativePath);
    await this.assertSafeFile(track);
    await rename(this.resolvePath(track), path.join(folder, filename));
    this.trash.push({ track: { ...track }, deletedAt: new Date().toISOString(), filename });
    this.tracks.splice(index, 1);
    try { await this.persist(); }
    catch (error) {
      await rename(path.join(folder, filename), this.resolvePath(track));
      this.trash = this.trash.filter(entry => entry.filename !== filename);
      this.tracks.splice(index, 0, track); throw error;
    }
    return { ...track };
  }

  async restore(trackId: string): Promise<LibraryTrack> {
    return this.exclusive(async () => {
      const entry = this.trash.find(item => item.track.id === trackId);
      if (!entry) throw new Error("Áudio não encontrado na lixeira.");
      await this.safeFolder(path.dirname(entry.track.relativePath), true);
      const destination = this.resolvePath(entry.track);
      try { await lstat(destination); throw new Error("Já existe um arquivo nesse caminho. Mova-o antes de restaurar."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const trashDir = await this.safeFolder(".trash", false, true);
      if (path.basename(entry.filename) !== entry.filename) throw new Error("Entrada de lixeira inválida.");
      await rename(path.join(trashDir, entry.filename), destination);
      this.tracks.push(entry.track);
      this.trash = this.trash.filter(item => item !== entry);
      this.sortTracks();
      try { await this.persist(); }
      catch (error) {
        await rename(destination, path.join(trashDir, entry.filename));
        this.tracks = this.tracks.filter(track => track.id !== trackId); this.trash.push(entry); throw error;
      }
      return { ...entry.track };
    });
  }

  async purgeTrash(): Promise<void> {
    return this.exclusive(async () => {
      const folder = await this.safeFolder(".trash", true, true);
      for (const entry of [...this.trash]) {
        if (path.basename(entry.filename) !== entry.filename) throw new Error("Entrada de lixeira inválida.");
        await unlink(path.join(folder, entry.filename)).catch(error => { if (error.code !== "ENOENT") throw error; });
        delete this.overrides[entry.track.id];
        this.trash = this.trash.filter(item => item !== entry);
        await this.persist();
      }
    });
  }

  async safeFolder(relative: string, create = false, internal = false): Promise<string> {
    const parts = portableLibraryPath(relative).split("/");
    if (!relative || parts.some(part => !part || part === "." || part === ".." || (!internal && part.startsWith("."))) || (!internal && !["music", "effects"].includes(parts[0]!))) throw new Error("Pasta inválida.");
    let folder = path.resolve(this.audioDir);
    for (const part of parts) {
      folder = path.join(folder, part);
      if (create) await mkdir(folder).catch(error => { if (error.code !== "EEXIST") throw error; });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Links simbólicos não são permitidos.");
    }
    return folder;
  }

  async assertSafeFile(track: Pick<LibraryTrack, "relativePath">): Promise<string> {
    await this.safeFolder(path.dirname(track.relativePath));
    const file = this.resolvePath(track);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Arquivo inválido.");
    return file;
  }

  async folders(): Promise<string[]> {
    const result: string[] = [];
    const visit = async (folder: string): Promise<void> => {
      result.push(folder);
      for (const entry of await readdir(await this.safeFolder(folder), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(`${folder}/${entry.name}`);
      }
    };
    await visit("music"); await visit("effects"); return result;
  }

  async move(trackId: string, folder: string): Promise<LibraryTrack> {
    return this.exclusive(async () => {
      const track = this.tracks.find(item => item.id === trackId);
      if (!track) throw new Error("Áudio não encontrado.");
      const source = await this.assertSafeFile(track);
      const destination = path.join(await this.safeFolder(folder), path.basename(source));
      if (source === destination) return { ...track };
      try { await lstat(destination); throw new Error("Já existe um arquivo com esse nome."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(source, destination);
      const oldPath = track.relativePath; const oldCategory = track.category; const oldOverride = this.overrides[trackId]?.category;
      track.relativePath = portableLibraryPath(path.relative(this.audioDir, destination));
      track.category = categoryFor(track.relativePath);
      if (this.overrides[trackId]) this.overrides[trackId]!.category = track.category;
      try { await this.persist(); }
      catch (error) {
        await rename(destination, source); track.relativePath = oldPath; track.category = oldCategory;
        if (this.overrides[trackId]) { if (oldOverride) this.overrides[trackId]!.category = oldOverride; else delete this.overrides[trackId]!.category; }
        throw error;
      }
      return { ...track };
    });
  }

  search(query: string, category?: AudioCategory): LibraryTrack[] {
    const needle = normalized(query.trim());
    if (!needle) return this.list(category);

    return this.tracks
      .filter((track) => !category || track.category === category)
      .filter((track) =>
        normalized(
          [track.title, track.artist, track.album, track.relativePath]
            .filter(Boolean)
            .join(" "),
        ).includes(needle),
      )
      .map((track) => ({ ...track }));
  }

  resolvePath(track: Pick<LibraryTrack, "relativePath">): string {
    const fullPath = path.resolve(this.audioDir, track.relativePath);
    const audioRoot = `${path.resolve(this.audioDir)}${path.sep}`;
    if (!fullPath.startsWith(audioRoot)) {
      throw new Error("Caminho de audio fora da biblioteca.");
    }
    return fullPath;
  }

  scan(): Promise<LibraryTrack[]> {
    if (this.scanTask) return this.scanTask;
    this.scanStatus = { running: true, processed: 0, total: 0, errors: [] };
    this.scanTask = this.exclusive(() => this.performScan()).catch((error: unknown) => {
      this.scanStatus.errors.push({ file: "Biblioteca", message: "Não foi possível concluir a indexação. Verifique o acesso às pastas." });
      throw error;
    }).finally(() => {
      this.scanStatus.running = false;
      this.scanTask = null;
    });
    return this.scanTask;
  }

  async scanAfterUpload(): Promise<LibraryTrack[]> {
    if (this.scanTask) await this.scanTask;
    return this.scan();
  }

  private async performScan(): Promise<LibraryTrack[]> {
    const files = (await walk(this.audioDir))
      .filter((fullPath) => SUPPORTED_EXTENSIONS.has(path.extname(fullPath).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    const currentRelativePaths = new Set(
      files.map((fullPath) => portableLibraryPath(path.relative(this.audioDir, fullPath))),
    );
    const previousByPath = new Map(
      this.tracks.map((track) => [track.relativePath, track]),
    );
    const movedCandidates = new Map<string, LibraryTrack[]>();
    for (const track of this.tracks) {
      if (currentRelativePaths.has(track.relativePath)) continue;
      const fingerprint = fileFingerprint(
        track.relativePath,
        track.sizeBytes,
        track.modifiedAt,
      );
      const candidates = movedCandidates.get(fingerprint) ?? [];
      candidates.push(track);
      movedCandidates.set(fingerprint, candidates);
    }
    const scanned: LibraryTrack[] = [];
    const newHashes = new Map<string, number>();
    const hashes = new Map<string, string>();
    for (const file of files) {
      const relative = portableLibraryPath(path.relative(this.audioDir, file));
      if (!previousByPath.has(relative)) {
        try { const hash = await hashFile(file); hashes.set(file, hash); newHashes.set(hash, (newHashes.get(hash) ?? 0) + 1); } catch { /* Report in scan below. */ }
      }
    }
    this.scanStatus.total = files.length;

    for (const fullPath of files) {
      try {
      const extension = path.extname(fullPath).toLowerCase();
      const relativePath = portableLibraryPath(path.relative(this.audioDir, fullPath));
      const fileStat = await stat(fullPath);
      const modifiedAt = fileStat.mtime.toISOString();
      let previous = previousByPath.get(relativePath);
      const contentHash = hashes.get(fullPath) ?? (previous?.modifiedAt === modifiedAt && previous.sizeBytes === fileStat.size ? previous.contentHash : undefined) ?? await hashFile(fullPath);
      if (!previous) {
        const fingerprint = fileFingerprint(relativePath, fileStat.size, modifiedAt);
        const candidates = this.tracks.filter(track => !currentRelativePaths.has(track.relativePath) && track.contentHash === contentHash);
        if (candidates.length === 1 && newHashes.get(contentHash) === 1) previous = candidates[0];
        else if (!candidates.length && movedCandidates.get(fingerprint)?.length === 1 && !movedCandidates.get(fingerprint)![0]!.contentHash && newHashes.get(contentHash) === 1) previous = movedCandidates.get(fingerprint)![0];
      }

      if (
        previous &&
        previous.source === "local" &&
        previous.modifiedAt === modifiedAt &&
        previous.sizeBytes === fileStat.size
      ) {
        const relocated: LibraryTrack = {
          ...previous,
          contentHash,
          category: categoryFor(relativePath),
          relativePath,
        };
        scanned.push(this.applyOverride(relocated, this.overrides[previous.id]));
        continue;
      }

      const probe = await this.probe(fullPath);
      const tags = probe.format?.tags;
      const duration = Number(probe.format?.duration);
      const artist = cleanOptional(tags?.artist);
      const album = cleanOptional(tags?.album);
      const id = previous?.id ?? randomUUID();

      const track: LibraryTrack = {
        id,
        contentHash,
        addedAt: previous?.addedAt ?? new Date().toISOString(),
        source: "local",
        title: cleanOptional(tags?.title) ?? path.basename(fullPath, extension),
        ...(artist ? { artist } : {}),
        ...(album ? { album } : {}),
        category: categoryFor(relativePath),
        relativePath,
        ...(Number.isFinite(duration) && duration > 0
          ? { durationMs: Math.round(duration * 1_000) }
          : {}),
        sizeBytes: fileStat.size,
        ...(probe.format?.format_name ? { format: probe.format.format_name } : {}),
        modifiedAt,
      };
      scanned.push(this.applyOverride(track, this.overrides[id]));
      } catch {
        const relativePath = portableLibraryPath(path.relative(this.audioDir, fullPath));
        this.scanStatus.errors.push({ file: relativePath, message: "Não foi possível ler este áudio. Verifique o formato e o FFprobe." });
        const previous = previousByPath.get(relativePath);
        if (previous) scanned.push(previous);
      } finally { this.scanStatus.processed += 1; }
    }

    this.tracks = scanned;
    const currentIds = this.knownIds();
    this.overrides = Object.fromEntries(
      Object.entries(this.overrides).filter(([id]) => currentIds.has(id)),
    );
    this.sortTracks();
    await this.persist();
    return this.list();
  }

  async validateFile(fullPath: string): Promise<void> {
    const extension = path.extname(fullPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error("Formato de audio nao suportado.");
    }
    await this.probe(fullPath);
  }

  makeUploadDestination(originalName: string, category: AudioCategory, subfolder = ""): string {
    const extension = path.extname(originalName).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error("Formato de audio nao suportado.");
    }

    const baseName = path
      .basename(originalName, extension)
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._ -]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "audio";
    const folder = category === "effect" ? "effects" : "music";
    const relativePath = path.join(folder, subfolder, `${baseName}-${randomUUID().slice(0, 8)}${extension}`);
    return this.resolvePath({ relativePath });
  }

  private async probe(fullPath: string): Promise<ProbeOutput> {
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration,format_name:format_tags=title,artist,album",
          "-of",
          "json",
          fullPath,
        ],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as ProbeOutput;
      if (!parsed.format) throw new Error("Arquivo sem formato reconhecido.");
      return parsed;
    } catch (error) {
      throw new Error(
        `Nao foi possivel ler o arquivo de audio: ${(error as Error).message}`,
      );
    }
  }

  private applyOverride(
    track: LibraryTrack,
    override: TrackOverride | undefined,
  ): LibraryTrack {
    if (!override) return { ...track };
    const updated: LibraryTrack = {
      ...track,
      ...(override.favorite !== undefined ? { favorite: override.favorite } : {}),
      ...(override.tags !== undefined ? { tags: [...override.tags] } : {}),
      ...(override.title !== undefined ? { title: override.title } : {}),
      ...(override.category !== undefined ? { category: override.category } : {}),
    };
    if (override.artist === null) delete updated.artist;
    else if (override.artist !== undefined) updated.artist = override.artist;
    if (override.album === null) delete updated.album;
    else if (override.album !== undefined) updated.album = override.album;
    return updated;
  }

  private sortTracks(): void {
    this.tracks.sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
  }

  private normalizeCatalogPaths(): void {
    for (const track of [...this.tracks, ...this.trash.map(entry => entry.track)]) {
      track.relativePath = portableLibraryPath(track.relativePath);
    }
  }

  private async persist(): Promise<void> {
    const payload: PersistedLibraryV2 = {
      version: 3,
      trash: this.trash,
      scannedAt: new Date().toISOString(),
      tracks: this.tracks,
      overrides: this.overrides,
    };
    await saveJson(this.metadataPath, payload);
  }
}
