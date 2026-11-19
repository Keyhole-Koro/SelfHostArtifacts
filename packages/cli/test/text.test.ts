import { describe, expect, it } from "vitest";
import { pageLinks, pageText } from "../src/text.ts";

describe("reading a page's text and links", () => {
  it("keeps the visible text, a line per block, without scripts, styles or comments", () => {
    const html = `<!doctype html><html><head><title>Plan</title><style>p{color:red}</style><script>var x = "<p>no</p>";</script></head>
      <body><h1>要求の列</h1><p>1 通は <b>24 語</b>&nbsp;&amp; 枠は 32</p><!-- hidden --><ul><li>send</li><li>recv</li></ul></body></html>`;
    expect(pageText(html)).toBe("Plan\n要求の列\n1 通は 24 語 & 枠は 32\nsend\nrecv");
  });

  it("finds links to pages on the same host, absolute or from the root, once each", () => {
    const html = `<a href="https://art.example.com/a/0123456789abcdef">x</a> <a href='/a/fedcba9876543210/v/2'>y</a>
      <a href="https://other.example.com/a/1111111111111111">z</a> <a href="/a/0123456789abcdef#top">again</a> <a href="/settings">no</a>`;
    expect(pageLinks(html, "https://art.example.com")).toEqual(["0123456789abcdef", "fedcba9876543210"]);
  });
});
