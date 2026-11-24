import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "release");
const tarFilename = "sonora-host.tar.gz";
const zipFilename = "sonora-host.zip";

// Dependencies are installed on the target. Never copy the whole working tree:
// it also contains credentials, personal media and machine-specific files.
const entries = [
  ".env.example", ".gitignore", ".github/workflows/ci.yml", "README.md", "CONTRIBUTING.md",
  "package.json", "package-lock.json", "tsconfig.json", "docs/host.md", "docs/github.md", "docs/windows.md",
  "public", "dist/src", "src", "test",
  "scripts/check-host.mjs", "scripts/pack-host.mjs", "scripts/pack-public.mjs", "scripts/remote-access.mjs",
  "scripts/sonora.service.example", "scripts/termux",
];

const excludedDirectories = new Set([
  "data", "audio", "audios", "music", "effects", "backups", "node_modules",
  "release", "coverage", "logs", "tmp", "temp", "private", "secrets",
]);
const sensitiveName = /(?:^|[._-])(?:cookies?|credentials?|secrets?|tokens?|passwords?)(?:$|[._-])/i;
const privateExtension = /\.(?:pem|key|p12|pfx|keystore|log|sqlite3?|db|bak|backup|mp3|wav|ogg|opus|flac|m4a|mp4|zip|gz|tar)$/i;
const maximumTotalBytes = 256 * 1024 * 1024;
const files = new Map();
const directories = new Set(["sonora/"]);
let totalBytes = 0;

function excluded(relative, directory) {
  const name = path.posix.basename(relative);
  const lower = name.toLowerCase();
  if ([".env.example", ".gitignore"].includes(relative)) return false;
  if (directory && ["src/audio", "dist/src/audio"].includes(relative)) return false;
  return name.startsWith(".") || lower.startsWith("plugin-vesktop") ||
    sensitiveName.test(name) || privateExtension.test(name) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)(?:[._-]|$)/i.test(name) ||
    (directory && excludedDirectories.has(lower));
}

async function collect(relative, required = false) {
  const source = path.join(root, relative);
  const stat = await lstat(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) {
    if (required) throw new Error("Entrada obrigatória não é um arquivo/pasta seguro: " + relative);
    return;
  }
  if (excluded(relative, stat.isDirectory())) {
    if (required) throw new Error("Entrada obrigatória não permitida no pacote: " + relative);
    return;
  }
  if (relative.split("/").some((part) => /[\\<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Caminho não portável para Windows: " + relative);
  }
  if (stat.isDirectory()) {
    directories.add("sonora/" + relative + "/");
    for (const name of await readdir(source)) await collect(relative + "/" + name);
    return;
  }
  totalBytes += stat.size;
  if (totalBytes > maximumTotalBytes) throw new Error("O pacote de código excede 256 MiB; remova arquivos não destinados à distribuição.");
  const data = await readFile(source);
  files.set("sonora/" + relative, {
    data,
    // Stable permissions across Windows/Linux, preserving executable boot scripts.
    mode: ["scripts/termux/run", "scripts/termux/boot"].includes(relative) ? 0o755 : 0o644,
  });
}

// Guard ancestors too: .github/workflows or dist could themselves be symlinks.
async function checkParents(relative) {
  const parts = relative.split("/");
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/");
    const stat = await lstat(path.join(root, parent));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Pasta obrigatória insegura: " + parent);
  }
}

function normalizedEntries() {
  const result = new Map(files);
  for (const name of directories) result.set(name, { data: Buffer.alloc(0), mode: 0o755, directory: true });
  for (const name of files.keys()) {
    let directory = path.posix.dirname(name);
    while (directory !== ".") {
      result.set(directory + "/", { data: Buffer.alloc(0), mode: 0o755, directory: true });
      directory = path.posix.dirname(directory);
    }
  }
  return [...result].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function octal(header, value, offset, length) {
  const encoded = value.toString(8);
  if (encoded.length >= length) throw new Error("Metadado excede os limites USTAR.");
  header.write(encoded.padStart(length - 1, "0") + "\0", offset, length, "ascii");
}

function tarPath(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let split = name.lastIndexOf("/", name.length - 2); split > 0; split = name.lastIndexOf("/", split - 1)) {
    const prefix = name.slice(0, split);
    const suffix = name.slice(split + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) return { name: suffix, prefix };
  }
  throw new Error("Caminho longo demais para o pacote USTAR: " + name);
}

function createTar(archiveEntries, epoch) {
  const chunks = [];
  for (const [name, entry] of archiveEntries) {
    const header = Buffer.alloc(512);
    const storedPath = tarPath(name);
    header.write(storedPath.name, 0, 100, "utf8");
    octal(header, entry.mode, 100, 8);
    octal(header, 0, 108, 8);
    octal(header, 0, 116, 8);
    octal(header, entry.data.length, 124, 12);
    octal(header, epoch, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.directory ? "5" : "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(storedPath.prefix, 345, 155, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, entry.data);
    if (entry.data.length % 512) chunks.push(Buffer.alloc(512 - entry.data.length % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  // GZIP's OS marker must not make identical builds differ by host platform.
  archive[9] = 255;
  return archive;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let result = 0xffffffff;
  for (const byte of data) result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

// ZIP APPNOTE: method 8, UTF-8 names, local records + central directory.
// No ZIP64 is needed for this bounded code-only distribution.
function createZip(archiveEntries, epoch) {
  if (archiveEntries.length >= 0xffff) throw new Error("O pacote excede o limite de entradas ZIP.");
  const date = new Date(Math.max(epoch, 315532800) * 1000);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const [name, entry] of archiveEntries) {
    const encodedName = Buffer.from(name);
    if (encodedName.length > 0xffff) throw new Error("Caminho longo demais para o pacote ZIP.");
    const data = entry.directory ? entry.data : deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.directory ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    localRecords.push(local, encodedName, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix creator; stable permissions on extraction.
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE((((entry.directory ? 0o040000 : 0o100000) | entry.mode) << 16 | (entry.directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, encodedName);
    offset += local.length + encodedName.length + data.length;
  }
  const central = Buffer.concat(centralRecords);
  if (offset + central.length >= 0xffffffff) throw new Error("O pacote excede os limites ZIP sem ZIP64.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(archiveEntries.length, 8);
  end.writeUInt16LE(archiveEntries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

const epochText = process.env.SOURCE_DATE_EPOCH ?? "315532800";
if (!/^\d+$/.test(epochText) || Number(epochText) > 0xffffffff) {
  throw new Error("SOURCE_DATE_EPOCH deve ser um inteiro entre 0 e 4294967295.");
}
const epoch = Number(epochText);
await mkdir(release, { recursive: true });
const releaseStat = await lstat(release);
if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) throw new Error("release deve ser uma pasta real dentro do projeto.");
const staging = await mkdtemp(path.join(release, ".pack-"));
try {
  for (const entry of entries) {
    await checkParents(entry);
    await collect(entry, true);
  }
  const archiveEntries = normalizedEntries();
  const archives = [
    [tarFilename, createTar(archiveEntries, epoch)],
    [zipFilename, createZip(archiveEntries, epoch)],
  ];
  let checksums = "";
  for (const [filename, content] of archives) {
    await writeFile(path.join(staging, filename), content);
    checksums += createHash("sha256").update(content).digest("hex") + "  " + filename + "\n";
  }
  await writeFile(path.join(staging, "SHA256SUMS"), checksums);
  // Build all outputs first. A packing failure leaves previous releases intact.
  for (const filename of [tarFilename, zipFilename, "SHA256SUMS"]) {
    await rename(path.join(staging, filename), path.join(release, filename));
    console.log("Pacote do Sonora: " + path.join(release, filename));
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
