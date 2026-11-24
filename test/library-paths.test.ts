import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { portableLibraryPath } from "../src/library/library-path.js";
import { LibraryService } from "../src/library/library-service.js";
import type { LibraryTrack } from "../src/types.js";

function wav(): Buffer {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}

it("converts Windows separators without reinterpreting literal POSIX backslashes", () => {
  assert.equal(portableLibraryPath("effects\\Ambiência\\Chuva.wav", "\\"), "effects/Ambiência/Chuva.wav");
  assert.equal(portableLibraryPath("music/Áudio com espaço.wav", "\\"), "music/Áudio com espaço.wav");
  assert.equal(portableLibraryPath("music/Campanha\\Capítulo/som.wav", "/"), "music/Campanha\\Capítulo/som.wav");
});

it("loads and imports native legacy catalog/trash paths as portable paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-native-catalog-"));
  const track: LibraryTrack = { id: "native", source: "local", title: "Chuva", category: "effect", relativePath: path.join("effects", "Ambiência", "Chuva.wav"), sizeBytes: 1600, modifiedAt: new Date().toISOString() };
  const trashTrack: LibraryTrack = { ...track, id: "trash", relativePath: path.join("music", "Mesa", "tema.wav") };
  const trash = [{ track: trashTrack, deletedAt: track.modifiedAt, filename: "abc.wav" }];
  try {
    await writeFile(path.join(root, "library.json"), JSON.stringify({ version: 3, tracks: [track], trash, overrides: {}, scannedAt: track.modifiedAt }));
    const library = new LibraryService(path.join(root, "audio"), root);
    await library.initialize(false);
    assert.equal(library.get(track.id)?.relativePath, "effects/Ambiência/Chuva.wav");
    assert.equal(library.listTrash()[0]?.track.relativePath, "music/Mesa/tema.wav");
    await library.importCatalog({ tracks: [track], trash });
    const stored = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
    assert.equal(stored.tracks[0].relativePath, "effects/Ambiência/Chuva.wav");
    assert.equal(stored.trash[0].track.relativePath, "music/Mesa/tema.wav");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps slash-separated catalog paths through scanning, moving and trash restoration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-portable-áudio-"));
  try {
    const audio = path.join(root, "audio");
    const file = path.join(audio, "music", "Áudio local", "tema.wav");
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, wav());
    const library = new LibraryService(audio, root); await library.initialize();
    const original = library.list()[0]; assert.ok(original);
    assert.equal(original.relativePath, "music/Áudio local/tema.wav");
    await library.safeFolder("effects/Ambiência", true);
    const moved = await library.move(original.id, "effects/Ambiência");
    assert.equal(moved.relativePath, "effects/Ambiência/tema.wav"); assert.equal(moved.category, "effect");
    await library.scan(); assert.equal(library.get(original.id)?.id, original.id);
    assert.equal(library.get(original.id)?.category, "effect");
    await library.delete(original.id);
    const reloaded = new LibraryService(audio, root); await reloaded.initialize(false);
    await reloaded.restore(original.id);
    assert.equal(reloaded.get(original.id)?.relativePath, "effects/Ambiência/tema.wav");
    await access(path.join(audio, "effects", "Ambiência", "tema.wav"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves genuine POSIX backslashes during catalog reload, moves and restoration", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-literal-backslash-"));
  try {
    const audio = path.join(root, "audio");
    const original = path.join(audio, "music", "Capítulo\\Um", "som\\um.wav");
    await mkdir(path.dirname(original), { recursive: true }); await writeFile(original, wav());
    const library = new LibraryService(audio, root); await library.initialize();
    const track = library.list()[0]; assert.ok(track);
    assert.equal(track.relativePath, "music/Capítulo\\Um/som\\um.wav");
    assert.equal(await library.assertSafeFile(track), original);
    assert.ok((await library.folders()).includes("music/Capítulo\\Um"));
    await library.safeFolder("effects/Parte\\Dois", true);
    const moved = await library.move(track.id, "effects/Parte\\Dois");
    assert.equal(moved.relativePath, "effects/Parte\\Dois/som\\um.wav");
    await library.delete(track.id);
    const reloaded = new LibraryService(audio, root); await reloaded.initialize(false);
    assert.equal(reloaded.listTrash()[0]?.track.relativePath, moved.relativePath);
    await reloaded.restore(track.id);
    assert.deepEqual(await readFile(reloaded.resolvePath(moved)), wav());
    await assert.rejects(access(path.join(audio, "effects", "Parte", "Dois", "som", "um.wav")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
