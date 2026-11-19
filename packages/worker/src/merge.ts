/**
 * A three-way merge of texts, line by line, for two people saving the same page: the version
 * both started from (base), the one being saved (mine) and the one saved meanwhile (theirs).
 * Lines that neither changed hold the result together; between them, a part only one side
 * changed takes that side, and a part both changed differently becomes a conflict, marked as
 * git marks one.
 */

/** Pairs of equal lines [i in a, j in b], increasing in both: a longest common subsequence (Myers). */
export function commonLines(a: string[], b: string[], maxEdits = 4000): [number, number][] | undefined {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const middle: [number, number][] = [];
  if (n > 0 && m > 0) {
    const max = Math.min(n + m, maxEdits);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    let done = false;
    for (let d = 0; d <= max && !done; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!) ? v[k + 1 + off]! : v[k - 1 + off]! + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x++;
          y++;
        }
        v[k + off] = x;
        if (x >= n && y >= m) {
          done = true;
          break;
        }
      }
    }
    if (!done) return undefined; // too different to line up
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      const t = trace[d]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && t[k - 1 + off]! < t[k + 1 + off]!) ? k + 1 : k - 1;
      const prevX = t[prevK + off]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        middle.push([x + pre, y + pre]);
      }
      x = prevX;
      y = prevY;
    }
    middle.reverse();
  }
  const out: [number, number][] = [];
  for (let i = 0; i < pre; i++) out.push([i, i]);
  out.push(...middle);
  for (let i = suf; i > 0; i--) out.push([a.length - i, b.length - i]);
  return out;
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);

export interface Merged {
  text: string;
  /** Parts both sides changed differently, marked in the text. */
  conflicts: number;
}

/** Merges `mine` and `theirs`, both changed from `base`. Undefined when they cannot be lined up. */
export function merge3(base: string, mine: string, theirs: string, labels: { mine: string; theirs: string }): Merged | undefined {
  const O = base.split("\n");
  const A = mine.split("\n");
  const B = theirs.split("\n");
  const oa = commonLines(O, A);
  const ob = commonLines(O, B);
  if (!oa || !ob) return undefined;
  const inA = new Map(oa);
  const inB = new Map(ob);
  const out: string[] = [];
  let conflicts = 0;
  let o = 0;
  let a = 0;
  let b = 0;
  for (;;) {
    // The next base line both kept: everything before it is one changed part.
    let k = o;
    while (k < O.length && !(inA.has(k) && inB.has(k))) k++;
    const aEnd = k < O.length ? inA.get(k)! : A.length;
    const bEnd = k < O.length ? inB.get(k)! : B.length;
    const was = O.slice(o, k);
    const ours = A.slice(a, aEnd);
    const their = B.slice(b, bEnd);
    if (same(ours, was)) out.push(...their);
    else if (same(their, was) || same(ours, their)) out.push(...ours);
    else {
      conflicts++;
      out.push(`<<<<<<< ${labels.mine}`, ...ours, "=======", ...their, `>>>>>>> ${labels.theirs}`);
    }
    if (k >= O.length) break;
    out.push(O[k]!);
    o = k + 1;
    a = aEnd + 1;
    b = bEnd + 1;
  }
  return { text: out.join("\n"), conflicts };
}

/** Whether a text still has conflict marks from a merge. */
export function hasConflictMarks(text: string): boolean {
  return /^(<<<<<<<|>>>>>>>) /m.test(text);
}
