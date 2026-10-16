export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VERSION_BYTES = 100 * 1024 * 1024;
export const MAX_FILES_PER_VERSION = 200;
export const MAX_ALLOW_CONNECT = 20;
export const MAX_PATH_LENGTH = 512;

/** Extensions an artifact may contain, and the Content-Type each one is served with. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  woff2: "font/woff2",
  mp4: "video/mp4",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(path: string): string | undefined {
  return CONTENT_TYPES[extensionOf(path)];
}
