import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writePrivateFile } from "../src/profile.ts";

/** The permission bits a file had each time node:fs wrote into it (undefined: it did not exist yet). */
const modesWhenWritten = vi.hoisted(() => [] as (number | undefined)[]);

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const record = (target: import("node:fs").PathOrFileDescriptor) => {
    let mode: number | undefined;
    try {
      mode = (typeof target === "number" ? fs.fstatSync(target) : fs.statSync(target)).mode & 0o777;
    } catch {
      mode = undefined;
    }
    modesWhenWritten.push(mode);
  };
  const writeFileSync: typeof fs.writeFileSync = (file, ...rest) => {
    record(file);
    fs.writeFileSync(file, ...rest);
  };
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    record(fd);
    return (fs.writeSync as (fd: number, ...rest: unknown[]) => number)(fd, ...rest);
  }) as typeof fs.writeSync;
  return { ...fs, writeFileSync, writeSync };
});

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "artifact-profile-test-"));
});

describe.skipIf(process.platform === "win32")("private files", () => {
  it("creates a new file 0600 in new 0700 directories", () => {
    const path = join(work, "a", "b", "key.pem");
    writePrivateFile(path, "secret\n");
    expect(readFileSync(path, "utf8")).toBe("secret\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(work, "a")).mode & 0o777).toBe(0o700);
    expect(statSync(join(work, "a", "b")).mode & 0o777).toBe(0o700);
  });

  it("replaces a longer existing 0644 file exactly, and leaves it 0600", () => {
    const path = join(work, ".env");
    writeFileSync(path, "OLD_TOKEN=a-much-longer-value-that-must-not-survive\nOTHER=1\n");
    chmodSync(path, 0o644);
    writePrivateFile(path, "TOKEN=new\n");
    expect(readFileSync(path, "utf8")).toBe("TOKEN=new\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("makes an existing 0644 file 0600 before the secret goes in", () => {
    const path = join(work, ".env");
    writeFileSync(path, "OLD=1\n");
    chmodSync(path, 0o644);
    modesWhenWritten.length = 0;
    writePrivateFile(path, "TOKEN=new\n");
    expect(modesWhenWritten.length).toBeGreaterThan(0);
    expect(modesWhenWritten.map((mode) => mode?.toString(8))).toEqual(modesWhenWritten.map(() => "600"));
  });

  it("writes into a FIFO, which cannot be truncated (like --out /dev/stdout or >(cmd))", () => {
    const fifo = join(work, "out.fifo");
    execFileSync("mkfifo", [fifo]);
    // A non-blocking reader is open first, so opening the writing end does not wait for one.
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      writePrivateFile(fifo, "TOKEN=x\n");
      const buffer = Buffer.alloc(64);
      const read = readSync(reader, buffer, 0, buffer.length, null);
      expect(buffer.subarray(0, read).toString("utf8")).toBe("TOKEN=x\n");
    } finally {
      closeSync(reader);
    }
  });
});
