import path from "node:path";

// Catalog/API paths use '/', independently of the host filesystem. Only the
// native Windows separator is converted: '\\' can be a real POSIX filename.
export function portableLibraryPath(relative: string, separator = path.sep): string {
  return separator === "\\" ? relative.replaceAll("\\", "/") : relative;
}
