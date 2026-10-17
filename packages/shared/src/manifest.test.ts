import { describe, expect, it } from "vitest";
import { invalidPathReason, manifestSchema } from "./manifest.ts";
import { canonicalRequest, formatSignatureHeader, parseSignatureHeader } from "./signature.ts";

const ref = `sha256:${"a".repeat(64)}`;

describe("invalidPathReason", () => {
  it.each(["index.html", "css/site.css", "data/2026 Q3.csv", "img/logo@2x.png"])("accepts %s", (p) => {
    expect(invalidPathReason(p)).toBeUndefined();
  });

  it.each(["", "/index.html", "a/../b.html", "./a.html", "a//b.html", "a\\b.html", "x.exe", "noext"])("refuses %s", (p) => {
    expect(invalidPathReason(p)).toBeDefined();
  });
});

describe("manifestSchema", () => {
  it("accepts a minimal manifest", () => {
    expect(manifestSchema.safeParse({ title: "T", entry: "index.html", files: { "index.html": ref } }).success).toBe(true);
  });

  it("needs the entry among the files", () => {
    const r = manifestSchema.safeParse({ title: "T", entry: "index.html", files: { "other.html": ref } });
    expect(r.success).toBe(false);
  });

  it("normalises allow_connect hosts and refuses wildcards other than *.domain", () => {
    const ok = manifestSchema.parse({ title: "T", entry: "i.html", files: { "i.html": ref }, allow_connect: [" API.Example.com ", "*.example.org"] });
    expect(ok.allow_connect).toEqual(["api.example.com", "*.example.org"]);
    for (const bad of ["*", "https://api.example.com", "api.example.com/path", "*.com"]) {
      expect(manifestSchema.safeParse({ title: "T", entry: "i.html", files: { "i.html": ref }, allow_connect: [bad] }).success).toBe(false);
    }
  });
});

describe("signature header", () => {
  it("round-trips", () => {
    const p = { key: "dev1", ts: 1700000000, nonce: "abc_-1", sig: "c2ln" };
    expect(parseSignatureHeader(formatSignatureHeader(p))).toEqual(p);
  });

  it("refuses other schemes and malformed fields", () => {
    expect(parseSignatureHeader("Bearer x")).toBeUndefined();
    expect(parseSignatureHeader("Artifact-Sig key=a,ts=x,nonce=b,sig=c")).toBeUndefined();
    expect(parseSignatureHeader("Artifact-Sig key=a b,ts=1,nonce=b,sig=c")).toBeUndefined();
  });

  it("puts each part on its own line", () => {
    expect(canonicalRequest("post", "/api/v1/x?y=1", 5, "n", "h")).toBe("POST\n/api/v1/x?y=1\n5\nn\nh");
  });
});
