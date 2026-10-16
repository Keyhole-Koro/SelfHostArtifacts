import { z } from "zod";
import {
  CONTENT_TYPES,
  MAX_ALLOW_CONNECT,
  MAX_FILES_PER_VERSION,
  MAX_PATH_LENGTH,
  extensionOf,
} from "./limits.ts";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

const SEGMENT = /^[A-Za-z0-9._~@+-][A-Za-z0-9._~@+ -]*$/;

/** Why `path` cannot be published, or undefined when it can. */
export function invalidPathReason(path: string): string | undefined {
  if (path.length === 0) return "path is empty";
  if (path.length > MAX_PATH_LENGTH) return `path is longer than ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith("/")) return "path must be relative (no leading /)";
  if (path.includes("\\")) return "path must use / as the separator";
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return "path has an empty, . or .. segment";
    if (!SEGMENT.test(segment)) return `path segment "${segment}" has characters that are not allowed`;
  }
  const ext = extensionOf(path);
  if (!(ext in CONTENT_TYPES)) {
    return `.${ext || "(none)"} files cannot be published. Allowed: ${Object.keys(CONTENT_TYPES).join(", ")}`;
  }
  return undefined;
}

const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const allowConnectSchema = z
  .array(
    z
      .string()
      .transform((h) => h.trim().toLowerCase())
      .refine((h) => HOSTNAME.test(h), {
        message: 'each allow_connect entry must be a hostname such as "api.example.com" or "*.example.com"',
      }),
  )
  .max(MAX_ALLOW_CONNECT);

export const manifestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional(),
    entry: z.string(),
    files: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/, "file hashes look like sha256:<64 hex>")),
    allow_connect: allowConnectSchema.optional(),
    base_version: z.number().int().positive().optional(),
  })
  .superRefine((m, ctx) => {
    const paths = Object.keys(m.files);
    if (paths.length === 0) ctx.addIssue({ code: "custom", message: "files is empty", path: ["files"] });
    if (paths.length > MAX_FILES_PER_VERSION) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_FILES_PER_VERSION} files per version`, path: ["files"] });
    }
    for (const p of paths) {
      const reason = invalidPathReason(p);
      if (reason) ctx.addIssue({ code: "custom", message: `${p}: ${reason}`, path: ["files", p] });
    }
    if (extensionOf(m.entry) !== "html") {
      ctx.addIssue({ code: "custom", message: "entry must be an .html file", path: ["entry"] });
    } else if (!(m.entry in m.files)) {
      ctx.addIssue({ code: "custom", message: `entry ${m.entry} is not in files`, path: ["entry"] });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

export function hashOf(ref: string): string {
  return ref.slice("sha256:".length);
}
