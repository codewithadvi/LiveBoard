import assert from "node:assert/strict";
import { test } from "node:test";
import { applyText, diffToOps, transformPair, type TextOp } from "../src/ot.ts";

function opsFor(text: string, clientId: string): TextOp[] {
  const ops: TextOp[] = [];
  for (let i = 0; i <= text.length; i++) {
    for (const char of ["X", "Y"]) ops.push({ type: "insert", index: i, char, clientId });
  }
  for (let i = 0; i < text.length; i++) ops.push({ type: "delete", index: i, clientId });
  return ops;
}

test("TP1 holds for every pair of concurrent ops on every small text", () => {
  let checked = 0;
  for (const text of ["", "a", "ab", "abc", "abcd"]) {
    for (const a of opsFor(text, "A")) {
      for (const b of opsFor(text, "B")) {
        const [a2, b2] = transformPair(a, b);
        const left = applyText(applyText(text, a), b2);
        const right = applyText(applyText(text, b), a2);
        assert.equal(left, right, `text=${JSON.stringify(text)} a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 400, `only ${checked} pairs checked`);
});

test("same-position inserts break the tie the same way from both sides", () => {
  const a: TextOp = { type: "insert", index: 1, char: "X", clientId: "A" };
  const b: TextOp = { type: "insert", index: 1, char: "Y", clientId: "B" };
  const [a2, b2] = transformPair(a, b);
  assert.equal(applyText(applyText("pq", a), b2), "pXYq");
  assert.equal(applyText(applyText("pq", b), a2), "pXYq");
});

test("both deleting the same character removes it once", () => {
  const a: TextOp = { type: "delete", index: 1, clientId: "A" };
  const b: TextOp = { type: "delete", index: 1, clientId: "B" };
  const [a2, b2] = transformPair(a, b);
  assert.equal(applyText(applyText("abc", a), b2), "ac");
  assert.equal(applyText(applyText("abc", b), a2), "ac");
});

test("diffToOps reproduces the new text", () => {
  const cases: [string, string][] = [
    ["", "hello"],
    ["hello", ""],
    ["hello", "hello world"],
    ["hello world", "hello"],
    ["abcdef", "abXYef"],
    ["aaa", "aaaa"],
    ["abc", "abc"],
  ];
  for (const [from, to] of cases) {
    const result = diffToOps(from, to, "A").reduce(applyText, from);
    assert.equal(result, to);
  }
});
