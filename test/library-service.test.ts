import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { LibraryService } from "../src/library/library-service.js";

function silentWav(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe("LibraryService", () => {
  it("detecta conteúdo duplicado, não adivinha movimentos ambíguos e mantém favoritos/etiquetas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sonora-duplicates-"));
    try {
      const audio = path.join(root, "audio"); const data = path.join(root, "data");
      await mkdir(path.join(audio, "music"), { recursive: true });
      await writeFile(path.join(audio, "music/a.wav"), silentWav());
      await writeFile(path.join(audio, "music/b.wav"), silentWav());
      const library = new LibraryService(audio, data); await library.initialize();
      const [a, b] = library.list(); assert.ok(a); assert.ok(b);
      assert.equal(library.duplicates().length, 1);
      await Promise.all([library.update(a.id, { favorite: true, tags: ["Combate"] }), library.update(b.id, { tags: ["Chuva"] })]);
      await library.safeFolder("music/Campanha", true);
      await library.move(a.id, "music/Campanha"); await library.scan();
      assert.equal(library.get(a.id)?.favorite, true); assert.deepEqual(library.get(a.id)?.tags, ["Combate"]);
      await library.delete(a.id); await library.scan();
      const reloaded = new LibraryService(audio, data); await reloaded.initialize();
      assert.equal(reloaded.listTrash().length, 1); await reloaded.restore(a.id);
      assert.equal(reloaded.get(a.id)?.favorite, true);
      await rename(path.join(audio, "music/Campanha/a.wav"), path.join(audio, "music/c.wav"));
      await rename(path.join(audio, "music/b.wav"), path.join(audio, "music/d.wav"));
      await reloaded.scan();
      assert.equal(reloaded.get(a.id), null); assert.equal(reloaded.get(b.id), null);
      assert.equal(new Set(reloaded.list().map(t => t.id)).size, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("recusa travessia de diretório, links simbólicos e restauração sobre um arquivo existente", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sonora-safe-path-"));
    try {
      const audio = path.join(root, "audio"); const library = new LibraryService(audio, path.join(root, "data")); await library.initialize();
      await assert.rejects(library.safeFolder("music/../../escape", true));
      await symlink(root, path.join(audio, "music/link"));
      await assert.rejects(library.safeFolder("music/link/subdir", true));
      const original = path.join(audio, "music/a.wav"); await writeFile(original, silentWav()); await library.scan();
      const track = library.list()[0]!; await library.delete(track.id); await writeFile(original, silentWav());
      await assert.rejects(library.restore(track.id), /Já existe/);
      assert.equal(library.listTrash().length, 1);
      await library.purgeTrash(); assert.equal(library.listTrash().length, 0); await access(original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("indexa audios validos mesmo com um arquivo corrompido", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sonora-corrupt-"));
    try {
      const audio = path.join(root, "audio");
      await mkdir(path.join(audio, "music"), { recursive: true });
      await writeFile(path.join(audio, "music", "good.wav"), silentWav());
      await writeFile(path.join(audio, "music", "bad.wav"), "invalid audio");
      const library = new LibraryService(audio, path.join(root, "data"));
      await library.initialize(false);
      assert.equal(library.list().length, 0);
      await library.scan();
      assert.equal(library.list().length, 1);
      assert.equal(library.getScanStatus().errors.length, 1);
      assert.equal(library.getScanStatus().processed, 2);
      assert.equal(library.getScanStatus().running, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("edita e remove apenas a copia escolhida, preservando as mudancas apos reindexar", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sonora-library-"));
    const audioDir = path.join(temporaryRoot, "audio");
    const dataDir = path.join(temporaryRoot, "data");
    const firstPath = path.join(audioDir, "music", "duplicado-a.wav");
    const secondPath = path.join(audioDir, "music", "duplicado-b.wav");

    try {
      await mkdir(path.dirname(firstPath), { recursive: true });
      await writeFile(firstPath, silentWav());
      await writeFile(secondPath, silentWav());

      const library = new LibraryService(audioDir, dataDir);
      await library.initialize();
      const [first, second] = library.list();
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.id, second.id);

      await library.update(first.id, {
        title: "Som editado",
        artist: "Mesa de teste",
        category: "effect",
      });
      await library.scan();
      assert.equal(library.get(first.id)?.title, "Som editado");
      assert.equal(library.get(first.id)?.category, "effect");

      const reloaded = new LibraryService(audioDir, dataDir);
      await reloaded.initialize();
      assert.equal(reloaded.get(first.id)?.artist, "Mesa de teste");

      await reloaded.delete(first.id);
      await assert.rejects(access(firstPath));
      await access(secondPath);
      assert.equal(reloaded.list().length, 1);

      const persisted = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
      assert.equal(persisted.version, 3);
      assert.equal(persisted.trash.length, 1);
      await reloaded.scan();
      assert.equal(reloaded.list().length, 1);
      await reloaded.restore(first.id);
      await access(firstPath);
      assert.equal(reloaded.get(first.id)?.title, "Som editado");
      assert.equal(reloaded.listTrash().length, 0);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("preserva a identidade e as edicoes quando um audio e movido para uma pasta", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sonora-library-move-"));
    const audioDir = path.join(temporaryRoot, "audio");
    const dataDir = path.join(temporaryRoot, "data");
    const originalPath = path.join(audioDir, "music", "tema.wav");
    const movedPath = path.join(audioDir, "music", "Campanha", "tema.wav");

    try {
      await mkdir(path.dirname(originalPath), { recursive: true });
      await writeFile(originalPath, silentWav());
      const library = new LibraryService(audioDir, dataDir);
      await library.initialize();
      const original = library.list()[0];
      assert.ok(original);
      await library.update(original.id, { title: "Tema principal" });

      await mkdir(path.dirname(movedPath), { recursive: true });
      await rename(originalPath, movedPath);
      await library.scan();

      const moved = library.list()[0];
      assert.ok(moved);
      assert.equal(moved.id, original.id);
      assert.equal(moved.title, "Tema principal");
      assert.equal(moved.relativePath, path.join("music", "Campanha", "tema.wav"));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
