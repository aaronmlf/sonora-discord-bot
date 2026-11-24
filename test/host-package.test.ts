import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { gunzipSync, inflateRawSync } from "node:zlib";

const execFileAsync = promisify(execFile);
const script = path.resolve(import.meta.dirname, "../scripts/pack-host.mjs");
const names = ["sonora-host.tar.gz", "sonora-host.zip", "SHA256SUMS"];

async function put(root: string, relative: string, content = "public fixture\n"): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-host-package-"));
  for (const file of [
    ".env.example", ".gitignore", ".github/workflows/ci.yml", "README.md", "CONTRIBUTING.md",
    "package.json", "package-lock.json", "tsconfig.json", "docs/host.md", "docs/github.md", "docs/windows.md",
    "public/index.html", "src/index.ts", "src/audio/session-mixer.ts", "dist/src/index.js", "dist/src/index.js.map",
    "dist/src/audio/session-mixer.js", "test/test.test.ts", "scripts/check-host.mjs", "scripts/pack-public.mjs",
    "scripts/remote-access.mjs", "scripts/sonora.service.example", "scripts/termux/run", "scripts/termux/boot",
  ]) await put(root, file);
  await copyFile(script, path.join(root, "scripts/pack-host.mjs"));
  return root;
}

async function pack(root: string, epoch?: string): Promise<Buffer[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
  delete env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined) env.SOURCE_DATE_EPOCH = epoch;
  // An empty PATH proves the generator does not need tar, gzip, zip or PowerShell.
  await execFileAsync(process.execPath, [path.join(root, "scripts/pack-host.mjs")], { env });
  return Promise.all(names.map((name) => readFile(path.join(root, "release", name))));
}

type ArchivedEntry = { data: Buffer; mode: number; epoch?: number };

function tarEntries(archive: Buffer): Map<string, ArchivedEntry> {
  const raw = gunzipSync(archive);
  const result = new Map<string, ArchivedEntry>();
  let offset = 0;
  while (raw[offset] !== 0) {
    const header = raw.subarray(offset, offset + 512);
    const string = (start: number, length: number) => header.toString("utf8", start, start + length).split("\0")[0]!;
    const octal = (start: number, length: number) => Number.parseInt(string(start, length).trim(), 8);
    const checksum = octal(148, 8);
    const expectedChecksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(checksum, expectedChecksum);
    assert.equal(string(257, 6), "ustar");
    assert.equal(octal(108, 8), 0);
    assert.equal(octal(116, 8), 0);
    const prefix = string(345, 155);
    const name = (prefix ? prefix + "/" : "") + string(0, 100);
    const size = octal(124, 12);
    result.set(name, {
      data: raw.subarray(offset + 512, offset + 512 + size),
      mode: octal(100, 8),
      epoch: octal(136, 12),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(raw.subarray(offset).equals(Buffer.alloc(raw.length - offset)));
  assert.ok(raw.length - offset >= 1024);
  return result;
}

function slowCrc32(data: Buffer): number {
  let result = 0xffffffff;
  for (const byte of data) {
    result ^= byte;
    for (let index = 0; index < 8; index++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function zipEntries(archive: Buffer): Map<string, ArchivedEntry> {
  const end = archive.subarray(archive.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  const count = end.readUInt16LE(10);
  assert.equal(end.readUInt16LE(8), count);
  let centralOffset = end.readUInt32LE(16);
  const centralStart = centralOffset;
  let expectedLocalOffset = 0;
  const result = new Map<string, ArchivedEntry>();
  for (let index = 0; index < count; index++) {
    const central = archive.subarray(centralOffset);
    assert.equal(central.readUInt32LE(0), 0x02014b50);
    assert.equal(central.readUInt16LE(8), 0x0800);
    const method = central.readUInt16LE(10);
    const compressedSize = central.readUInt32LE(20);
    const size = central.readUInt32LE(24);
    const nameLength = central.readUInt16LE(28);
    const name = central.toString("utf8", 46, 46 + nameLength);
    const localOffset = central.readUInt32LE(42);
    assert.equal(localOffset, expectedLocalOffset);
    const local = archive.subarray(localOffset);
    assert.equal(local.readUInt32LE(0), 0x04034b50);
    assert.ok(local.subarray(4, 30).equals(central.subarray(6, 32)));
    assert.equal(local.toString("utf8", 30, 30 + nameLength), name);
    const compressed = local.subarray(30 + nameLength, 30 + nameLength + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.equal(data.length, size);
    assert.equal(slowCrc32(data), central.readUInt32LE(16));
    result.set(name, { data, mode: (central.readUInt32LE(38) >>> 16) & 0o777 });
    expectedLocalOffset += 30 + nameLength + compressedSize;
    centralOffset += 46 + nameLength;
  }
  assert.equal(expectedLocalOffset, centralStart);
  assert.equal(centralOffset - centralStart, end.readUInt32LE(12));
  assert.equal(centralOffset, archive.length - 22);
  return result;
}

describe("pacotes de hospedagem", () => {
  it("gera TAR/ZIP com o mesmo conteúdo, nomes UTF-8 e SHA-256 sem arquivadores externos", async () => {
    const root = await fixture();
    const nested = "public/" + "long-directory-".repeat(6) + "/ação.js";
    try {
      await put(root, nested, "conteúdo UTF-8\n");
      await put(root, "public/empty.js", "");
      await mkdir(path.join(root, "public/empty-directory"));
      const [tar, zip, sums] = await pack(root);
      assert.ok(tar && zip && sums);
      const fromTar = tarEntries(tar);
      const fromZip = zipEntries(zip);
      assert.deepEqual([...fromTar.keys()], [...fromZip.keys()]);
      for (const [name, entry] of fromTar) {
        assert.ok(name.startsWith("sonora/"));
        assert.deepEqual(entry.data, fromZip.get(name)?.data, name);
        assert.equal(entry.mode, fromZip.get(name)?.mode, name);
        assert.equal(entry.epoch, 315532800);
      }
      assert.ok(fromTar.has("sonora/dist/src/index.js"));
      assert.ok(fromTar.has("sonora/dist/src/audio/session-mixer.js"));
      assert.ok(fromTar.has("sonora/docs/windows.md"));
      assert.ok(fromTar.has("sonora/public/empty-directory/"));
      assert.equal(fromZip.get("sonora/" + nested)?.data.toString(), "conteúdo UTF-8\n");
      assert.equal(fromTar.get("sonora/scripts/termux/run")?.mode, 0o755);
      assert.equal(fromZip.get("sonora/scripts/termux/boot")?.mode, 0o755);
      assert.equal(sums.toString(), [tar, zip].map((content, index) =>
        createHash("sha256").update(content).digest("hex") + "  " + names[index] + "\n").join(""));
      assert.deepEqual((await readdir(path.join(root, "release"))).sort(), [...names].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("é repetível mesmo com mtimes/permissões locais diferentes e aceita SOURCE_DATE_EPOCH", async () => {
    const root = await fixture();
    try {
      const first = await pack(root);
      await utimes(path.join(root, "src/index.ts"), new Date(), new Date());
      await chmod(path.join(root, "src/index.ts"), 0o755);
      assert.deepEqual(await pack(root), first);
      const [tar] = await pack(root, "0");
      assert.ok(tar);
      assert.equal(tarEntries(tar).get("sonora/src/index.ts")?.epoch, 0);
      await assert.rejects(() => pack(root, "-1"), /SOURCE_DATE_EPOCH/);
      await assert.rejects(() => pack(root, "4294967296"), /SOURCE_DATE_EPOCH/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exclui credenciais, áudios e artefatos privados inclusive dentro da allowlist", async () => {
    const root = await fixture();
    const forbidden = [
      ".env", "data/access.json", "node_modules/private/index.js", "plugin-vesktop-nivelador/index.ts",
      "src/.env", "src/data/access.json", "src/credentials.json", "test/cookies.txt",
      "test/.codex/config.json", "test/.aws/config.json", "test/.git/config", "test/private/note.md",
      "public/personal.mp3", "public/backups/data.json", "dist/src/private-key.pem",
    ];
    try {
      for (const file of forbidden) await put(root, file, "PRIVATE_FIXTURE_ONLY");
      const [tar, zip] = await pack(root);
      assert.ok(tar && zip);
      for (const entries of [tarEntries(tar), zipEntries(zip)]) {
        for (const file of forbidden) assert.equal(entries.has("sonora/" + file), false, file);
        for (const [name, entry] of entries) assert.equal(entry.data.toString().includes("PRIVATE_FIXTURE_ONLY"), false, name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserva artefatos anteriores se faltar arquivo obrigatório", async () => {
    const root = await fixture();
    try {
      const previous = await pack(root);
      await rm(path.join(root, "docs/windows.md"));
      await assert.rejects(() => pack(root), /ENOENT/);
      const current = await Promise.all(names.map((name) => readFile(path.join(root, "release", name))));
      assert.deepEqual(current, previous);
      assert.deepEqual((await readdir(path.join(root, "release"))).sort(), [...names].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recusa links em diretórios obrigatórios e não segue links aninhados", { skip: process.platform === "win32" }, async () => {
    const root = await fixture();
    try {
      await put(root, "private-fixture/other.js", "PRIVATE_FIXTURE_ONLY");
      await symlink(path.join(root, "private-fixture"), path.join(root, "src/linked"));
      const [, zip] = await pack(root);
      assert.ok(zip);
      assert.equal(zipEntries(zip).has("sonora/src/linked/other.js"), false);
      await rm(path.join(root, "dist"), { recursive: true });
      await symlink(path.join(root, "private-fixture"), path.join(root, "dist"));
      await assert.rejects(() => pack(root), /Pasta obrigatória insegura: dist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
