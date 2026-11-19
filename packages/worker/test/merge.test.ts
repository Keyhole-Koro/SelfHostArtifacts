import { describe, expect, it } from "vitest";
import { commonLines, merge3 } from "../src/merge.ts";

const L = { mine: "your text", theirs: "v3 by Sam" };
const lines = (...l: string[]) => l.join("\n");

describe("merge3", () => {
  it("lines up equal lines", () => {
    expect(commonLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([[0, 0], [2, 2]]);
    expect(commonLines([], ["a"])).toEqual([]);
    expect(commonLines(["a", "b", "c", "d"], ["b", "d"])).toEqual([[1, 0], [3, 1]]);
  });

  it("takes each side's change when they touch different lines", () => {
    const base = lines("# Plan", "", "one", "two", "three", "", "end");
    const mine = lines("# Plan", "", "ONE", "two", "three", "", "end");
    const theirs = lines("# Plan", "", "one", "two", "THREE", "", "end", "added");
    expect(merge3(base, mine, theirs, L)).toEqual({ text: lines("# Plan", "", "ONE", "two", "THREE", "", "end", "added"), conflicts: 0 });
  });

  it("keeps a change both made the same way once", () => {
    const base = lines("a", "b", "c");
    expect(merge3(base, lines("a", "B", "c"), lines("a", "B", "c"), L)).toEqual({ text: lines("a", "B", "c"), conflicts: 0 });
  });

  it("marks the lines both changed differently", () => {
    const base = lines("a", "b", "c");
    const merged = merge3(base, lines("a", "mine", "c"), lines("a", "theirs", "c"), L)!;
    expect(merged.conflicts).toBe(1);
    expect(merged.text).toBe(lines("a", "<<<<<<< your text", "mine", "=======", "theirs", ">>>>>>> v3 by Sam", "c"));
  });

  it("handles deletions and additions on both sides", () => {
    const base = lines("1", "2", "3", "4", "5");
    const mine = lines("1", "3", "4", "5", "6");
    const theirs = lines("0", "1", "2", "3", "5");
    expect(merge3(base, mine, theirs, L)).toEqual({ text: lines("0", "1", "3", "5", "6"), conflicts: 0 });
  });
});
