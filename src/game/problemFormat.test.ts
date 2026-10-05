/**
 * Self-running checks for the .problem format parser/expander.
 * Run: npx --yes tsx src/game/problemFormat.test.ts
 */
import {
  coerceSetupValue,
  compareProblemOrder,
  createRng,
  expandDeclarative,
  expandRandom,
  mergeSetupBindings,
  parseProblemFile,
  sampleWithoutReplacement,
  stringifySlot,
  substituteSlots,
} from "./problemFormat";

let failed = 0;

function assert(cond: unknown, message: string): void {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const ok = Object.is(actual, expected) ||
    JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error("FAIL:", message, { actual, expected });
  }
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
    failed += 1;
    console.error("FAIL:", message, "(expected throw)");
  } catch {
    // ok
  }
}

// --- seed stability ---
{
  const source = `
id: demo
title: Demo

[random]
n = 1..10
fn ~ double twice scale

[code]
x = $n
y = $fn
`;
  const template = parseProblemFile(source);
  const a = expandDeclarative(template, 42);
  const b = expandDeclarative(template, 42);
  assertEqual(a.code, b.code, "same seed → same expansion");
  const c = expandDeclarative(template, 43);
  assert(a.code !== c.code || a.bindings.n !== c.bindings.n, "different seeds usually differ");
}

// --- multi-LHS without replacement ---
{
  const rng = createRng(7);
  const bindings = expandRandom(
    [{ kind: "choose", names: ["a", "b", "c"], pool: ["x", "y", "z", "w"] }],
    rng,
  );
  const values = [bindings.a, bindings.b, bindings.c];
  assertEqual(new Set(values).size, 3, "multi-LHS picks are distinct");
  for (const v of values) {
    assert(["x", "y", "z", "w"].includes(String(v)), `pick ${v} from pool`);
  }
}

{
  assertThrows(
    () =>
      sampleWithoutReplacement(createRng(1), ["a", "b"], 3),
    "pool smaller than LHS count throws",
  );
  assertThrows(
    () =>
      expandRandom(
        [{ kind: "choose", names: ["a", "b", "c"], pool: ["x", "y"] }],
        createRng(1),
      ),
    "expandRandom rejects undersized pool",
  );
}

// --- $$ escape and unbound ---
{
  assertEqual(
    substituteSlots("price = $$? $n", { n: 3 }),
    "price = $? 3",
    "$$ becomes literal $",
  );
  assertThrows(
    () => substituteSlots("x = $missing", {}),
    "unbound slot throws",
  );
}

// --- fixed / range / strings ---
{
  const template = parseProblemFile(`
title: T
id: t

[random]
n = 5
label = "hi"
flag = True
r = 2..2

[code]
$n $label $flag $r
`);
  const { code, bindings } = expandDeclarative(template, 1);
  assertEqual(bindings.n, 5, "fixed int");
  assertEqual(bindings.label, "hi", "fixed string");
  assertEqual(bindings.flag, true, "fixed bool");
  assertEqual(bindings.r, 2, "degenerate range");
  assertEqual(code, "5 hi True 2\n", "substituted code");
}

// --- id from filename stem ---
{
  const template = parseProblemFile(
    `title: From stem\n\n[code]\npass\n`,
    "my-problem",
  );
  assertEqual(template.id, "my-problem", "id defaults to stem");
}

// --- order metadata ---
{
  const withOrder = parseProblemFile(`
id: a
title: A
order: 20

[code]
pass
`);
  assertEqual(withOrder.order, 20, "parses order");

  const noOrder = parseProblemFile(`
id: b
title: B

[code]
pass
`);
  assertEqual(
    noOrder.order,
    Number.POSITIVE_INFINITY,
    "missing order defaults to Infinity",
  );

  assertThrows(
    () =>
      parseProblemFile(`
id: c
title: C
order: 1.5

[code]
pass
`),
    "non-integer order rejected",
  );

  const sorted = [
    { order: Number.POSITIVE_INFINITY, title: "Zeta" },
    { order: 20, title: "Beta" },
    { order: 10, title: "Gamma" },
    { order: 20, title: "Alpha" },
  ].sort(compareProblemOrder);
  assertEqual(
    sorted.map((p) => p.title),
    ["Gamma", "Alpha", "Beta", "Zeta"],
    "sort by order then title; missing order last",
  );
}

// --- enable metadata ---
{
  const on = parseProblemFile(`
id: on
title: On

[code]
pass
`);
  assertEqual(on.enable, true, "enable defaults to true");

  const off = parseProblemFile(`
id: off
title: Off
enable: false

[code]
pass
`);
  assertEqual(off.enable, false, "enable: false");

  const explicitOn = parseProblemFile(`
id: explicit
title: Explicit
enable: true

[code]
pass
`);
  assertEqual(explicitOn.enable, true, "enable: true");

  assertThrows(
    () =>
      parseProblemFile(`
id: bad
title: Bad
enable: maybe

[code]
pass
`),
    "invalid enable rejected",
  );
}

// --- setup merge / coerce ---
{
  const merged = mergeSetupBindings({ n: 1, x: "a" }, { n: 9, label: "big" });
  assertEqual(merged.n, 9, "setup overrides random");
  assertEqual(merged.x, "a", "keeps other random");
  assertEqual(merged.label, "big", "adds setup slot");
  assertEqual(stringifySlot(true), "True", "bool stringify");
  assertEqual(coerceSetupValue("k", 3), 3, "coerce number");
  assertThrows(() => coerceSetupValue("k", [1, 2]), "reject list");
  assertThrows(() => coerceSetupValue("k", { a: 1 }), "reject dict");
}

// --- parse rejects bad lines ---
{
  assertThrows(
    () => parseProblemFile("title: X\n\n[random]\nok\n\n[code]\npass\n"),
    "malformed random line",
  );
  assertThrows(
    () => parseProblemFile("title: X\n\npass\n"),
    "missing [code]",
  );
}

// --- real-ish problem expands ---
{
  const template = parseProblemFile(`
id: double-and-branch
title: Double and branch
description: demo

[random]
n = 1..3
fn ~ double twice scale
arg, result ~ n x value num total
y, z ~ a b c d e

[code]
def $fn($arg):
    $result = 0
    for i in range($arg):
        $result += 2
    return $result

def main():
    $arg = $n
    $y = $fn($arg)
    if $y > 1:
        $z = $y + 1
    else:
        $z = 0
    print($z)
`);
  const { code, bindings } = expandDeclarative(template, 99);
  assert(!code.includes("$"), `no leftover slots: ${code}`);
  assert(
    bindings.arg !== bindings.result,
    "arg and result distinct",
  );
  assert(bindings.y !== bindings.z, "y and z distinct");
  // Smoke: expanded source should be parseable-looking
  assert(code.includes(`def ${bindings.fn}(`), "function name substituted");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("problemFormat checks passed");
