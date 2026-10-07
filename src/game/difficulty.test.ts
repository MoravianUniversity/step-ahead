/**
 * Self-running checks for difficulty policy helpers.
 * Run: npx --yes tsx src/game/difficulty.test.ts
 */
import {
  assistsLikeEasy,
  callParamScaffold,
  formatKindMismatch,
  formatNoAssignNeeded,
  formatWrongAssignTarget,
  initialTipsForPopover,
  isTutorial,
  joinReturnValueSlots,
  parseDifficulty,
  progressiveAnswerHints,
  progressiveHintThresholds,
  returnValueSlotCount,
  splitReturnValueSlots,
  tipsForPopover,
  tipsToRevealOnFeedback,
} from "./difficulty";

let failed = 0;

function assert(cond: unknown, message: string): void {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const ok =
    Object.is(actual, expected) ||
    JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed += 1;
    console.error("FAIL:", message, { actual, expected });
  }
}

assertEqual(parseDifficulty("easy"), "easy", "parse easy");
assertEqual(parseDifficulty("tutorial"), "tutorial", "parse tutorial");
assertEqual(parseDifficulty("nope"), "hard", "parse fallback");
assert(isTutorial("tutorial"), "isTutorial true");
assert(!isTutorial("easy"), "isTutorial false for easy");
assert(assistsLikeEasy("tutorial"), "tutorial assists like easy");
assert(assistsLikeEasy("easy"), "easy assists like easy");
assert(!assistsLikeEasy("medium"), "medium does not assist like easy");

assertEqual(
  formatKindMismatch("advance", "hard"),
  "Wrong event type for the next step",
  "hard kind mismatch",
);
assert(
  formatKindMismatch("advance", "medium").includes("variable assignment"),
  "medium names action",
);
assert(
  !formatKindMismatch("advance", "medium").includes("Click"),
  "medium omits how-to",
);
assert(
  formatKindMismatch("advance", "easy").includes("Click the variable"),
  "easy includes how-to",
);

assertEqual(
  formatWrongAssignTarget("x", { y: "1" }, "easy"),
  "The variable `y` needs to be set next",
  "easy wrong assign names target",
);
assertEqual(
  formatWrongAssignTarget("x", { y: "1" }, "medium"),
  "That is not the next variable to set",
  "medium wrong assign vague",
);
assertEqual(
  formatWrongAssignTarget("x", { y: "1" }, "hard"),
  "`x` does not change on the next step",
  "hard wrong assign current wording",
);

assert(
  formatNoAssignNeeded("output", "easy").includes("output"),
  "no-assign easy points at output",
);

const names = ["a", "b"];
assertEqual(
  callParamScaffold("tutorial", names).mode,
  "named-locked",
  "tutorial scaffold mode",
);
assertEqual(
  callParamScaffold("easy", names).mode,
  "named-locked",
  "easy scaffold mode",
);
assertEqual(
  callParamScaffold("easy", names).rowCount,
  2,
  "easy scaffold count",
);
assertEqual(
  callParamScaffold("medium", names).mode,
  "fixed-named",
  "medium scaffold mode",
);
assertEqual(
  callParamScaffold("medium", names).rowCount,
  2,
  "medium scaffold count",
);
assertEqual(
  callParamScaffold("hard", names).mode,
  "freeform",
  "hard scaffold mode",
);

assertEqual(returnValueSlotCount("5"), 1, "single return slot");
assertEqual(returnValueSlotCount("(1, 2)"), 2, "tuple return slots");
assertEqual(returnValueSlotCount("1, 2"), 2, "bare pair slots");
assertEqual(
  splitReturnValueSlots("(1, 'a,b')"),
  ["1", "'a,b'"],
  "tuple split respects string commas",
);
assertEqual(
  joinReturnValueSlots(["1", "2"], "(1, 2)"),
  "(1, 2)",
  "join keeps parens",
);
assertEqual(
  joinReturnValueSlots(["1", "2"], "1, 2"),
  "1, 2",
  "join bare pair",
);

assertEqual(
  initialTipsForPopover("output", "easy"),
  ["output-format"],
  "easy output tips up front",
);
assertEqual(
  initialTipsForPopover("assign", "tutorial", ["'hi'"]),
  ["literal-value", "string-quotes"],
  "tutorial tips like easy when string in answer",
);
assertEqual(
  initialTipsForPopover("assign", "easy", ["42"]),
  ["literal-value"],
  "easy assign tips omit string tip without string answer",
);
assertEqual(
  initialTipsForPopover("assign", "easy", ["'hi'"]),
  ["literal-value", "string-quotes"],
  "easy assign tips include string tip when answer is a string",
);
assertEqual(
  initialTipsForPopover("call", "medium"),
  [],
  "medium no tips up front",
);
assertEqual(
  tipsForPopover("call", "hard", new Set(["literal-value"])),
  [],
  "hard never shows tips",
);
assertEqual(
  tipsForPopover("call", "medium", new Set(["literal-value", "output-format"])),
  ["literal-value"],
  "medium shows only revealed applicable tips",
);

assertEqual(
  tipsToRevealOnFeedback(
    "output",
    [{ field: "output", message: "Incorrect output", level: "error" }],
    {},
    "medium",
  ),
  ["output-format"],
  "medium reveals output tip after failed output",
);
assertEqual(
  tipsToRevealOnFeedback(
    "assign",
    [
      {
        field: "assignValue",
        message: "Not a valid Python literal (strings need quotes)",
        level: "warning",
      },
    ],
    { values: ["hello"], expectedValues: ["'hello'"], needsQuotes: true },
    "medium",
  ),
  ["literal-value", "string-quotes"],
  "medium reveals literal and quotes tips when answer is a string",
);
assertEqual(
  tipsToRevealOnFeedback(
    "assign",
    [
      {
        field: "assignValue",
        message: "Not a valid Python literal (strings need quotes)",
        level: "warning",
      },
    ],
    { values: ["x"], expectedValues: ["42"], needsQuotes: true, notLiteral: true },
    "medium",
  ),
  ["literal-value"],
  "medium omits quotes tip when answer is not a string",
);
assertEqual(
  tipsToRevealOnFeedback(
    "assign",
    [{ field: "assignValue", message: "Incorrect value", level: "error" }],
    {},
    "hard",
  ),
  [],
  "hard never reveals tips on feedback",
);

assertEqual(
  progressiveHintThresholds("easy"),
  { identity: 2, answer: 3 },
  "easy progressive thresholds",
);
assertEqual(
  progressiveHintThresholds("medium"),
  { identity: 3, answer: 5 },
  "medium progressive thresholds",
);
assertEqual(progressiveHintThresholds("hard"), null, "hard has no progressive hints");

assertEqual(
  progressiveAnswerHints("easy", 1, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }),
  [],
  "easy assign quiet before identity threshold",
);
assertEqual(
  progressiveAnswerHints("easy", 2, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }),
  ["The variable `x` is being set."],
  "easy assign names variable at 2 mistakes",
);
assertEqual(
  progressiveAnswerHints("easy", 3, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }),
  ["The variable `x` is being set.", "Set `x` to `3`."],
  "easy assign reveals value at 3 mistakes",
);
assertEqual(
  progressiveAnswerHints("medium", 3, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }),
  ["The variable `x` is being set."],
  "medium assign names variable at 3 mistakes",
);
assert(
  progressiveAnswerHints("medium", 5, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }).some((hint) => hint.includes("trace table")),
  "medium assign points at trace table instead of value",
);
assert(
  !progressiveAnswerHints("medium", 5, {
    kind: "assign",
    assignName: "x",
    assignValue: "3",
  }).some((hint) => hint.includes("3")),
  "medium assign does not reveal exact value",
);
assert(
  progressiveAnswerHints("easy", 3, {
    kind: "return",
    returnValue: "42",
  }).includes("Return `42`."),
  "easy return reveals value",
);
assert(
  progressiveAnswerHints("medium", 5, {
    kind: "return",
    returnValue: "42",
  }).some((hint) => hint.toLowerCase().includes("call stack")),
  "medium return points at call stack",
);
assert(
  progressiveAnswerHints("easy", 3, {
    kind: "call",
    functionName: "foo",
    callParams: { a: "1", b: "2" },
  }).some((hint) => hint.includes("a=1") && hint.includes("b=2")),
  "easy call reveals parameter values",
);
assert(
  progressiveAnswerHints("medium", 5, {
    kind: "output",
    output: "hi",
  }).some((hint) => hint.includes("trace table")),
  "medium output points at trace table",
);
assertEqual(
  progressiveAnswerHints("hard", 10, {
    kind: "assign",
    assignName: "x",
    assignValue: "1",
  }),
  [],
  "hard never gets progressive answer hints",
);

if (failed > 0) {
  console.error(`\n${failed} difficulty test(s) failed`);
  process.exit(1);
}
console.log("All difficulty tests passed");
