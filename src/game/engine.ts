import type { TimelineEntry, TraceTable } from "../types";

export type PredictionKind = "advance" | "call" | "return" | "output";

export type GameTimelineEntry = TimelineEntry & {
  gameEvent?: "output";
  outputText?: string;
};

export type ExpectedAdvance = {
  kind: "advance";
  line: number;
  changes: Record<string, string>;
};

export type ExpectedCall = {
  kind: "call";
  functionName: string;
  /** The player may enter the def line or first executable body line. */
  acceptedLines: number[];
  /** Parameter name → value repr at call time. */
  params: Record<string, string>;
};

export type ExpectedReturn = {
  kind: "return";
  line: number;
  returnValue: string;
};

export type ExpectedOutput = {
  kind: "output";
  output: string;
};

export type ExpectedPrediction =
  | ExpectedAdvance
  | ExpectedCall
  | ExpectedReturn
  | ExpectedOutput;

export type AdvanceGuess = {
  kind: "advance";
  line: number;
  changes: Array<{ name: string; value: string }>;
};

export type CallGuess = {
  kind: "call";
  line: number;
  params: Array<{ name: string; value: string }>;
};

export type ReturnGuess = {
  kind: "return";
  line: number;
  returnValue: string;
};

export type OutputGuess = {
  kind: "output";
  output: string;
};

export type PredictionGuess =
  | AdvanceGuess
  | CallGuess
  | ReturnGuess
  | OutputGuess;

export type FieldFeedback = {
  field: string;
  message: string;
  level: "error" | "warning";
};

export function classifyTransition(
  current: GameTimelineEntry,
  next: GameTimelineEntry,
): PredictionKind {
  if (next.gameEvent === "output") return "output";
  if (next.kind === "callReturn") return "return";
  if (next.stack.length > current.stack.length) return "call";
  return "advance";
}

/**
 * Remove trace-only stops (line 0 and executable `def` statements), and add
 * explicit output stops so output—including final output—must be predicted.
 */
export function buildGameTimeline(
  raw: TimelineEntry[],
  source: string,
  stdout: string,
): GameTimelineEntry[] {
  const lines = source.replace(/\n$/, "").split("\n");
  const playable = raw.filter((entry) => {
    if (entry.line < 1) return false;
    const text = lines[entry.line - 1] ?? "";
    return !/^\s*(?:async\s+)?def\b/.test(text);
  });
  if (playable.length === 0) return [];

  const expanded: GameTimelineEntry[] = [];
  for (let i = 0; i < playable.length; i++) {
    const current = playable[i]!;
    expanded.push({ ...current });
    const next = playable[i + 1];
    const outputEnd = next?.stdoutLen ?? stdout.length;
    if (outputEnd > current.stdoutLen) {
      expanded.push({
        ...current,
        gameEvent: "output",
        outputText: stdout.slice(current.stdoutLen, outputEnd),
        stdoutLen: outputEnd,
      });
    }
  }
  return expanded;
}

function localsAt(
  table: TraceTable,
  stepIndex: number,
): Record<string, string> {
  const step = table.steps?.[stepIndex];
  return step?.locals ?? {};
}

function changedLocals(
  previous: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const [name, value] of Object.entries(next)) {
    if (previous[name] !== value) {
      changes[name] = value;
    }
  }
  return changes;
}

export function expectedPrediction(
  current: GameTimelineEntry,
  next: GameTimelineEntry,
  tablesById: Map<string, TraceTable>,
): ExpectedPrediction {
  const kind = classifyTransition(current, next);

  if (kind === "output") {
    return { kind: "output", output: next.outputText ?? "" };
  }

  if (kind === "call") {
    const table = tablesById.get(next.tableId);
    if (!table) {
      return {
        kind: "call",
        functionName: "?",
        acceptedLines: [next.line],
        params: {},
      };
    }
    const params: Record<string, string> = {};
    const names = table.parameters ?? [];
    names.forEach((name, index) => {
      const fromArgs = table.args[index];
      if (fromArgs != null) {
        params[name] = fromArgs;
        return;
      }
      const fromLocals = localsAt(table, next.stepIndex)[name];
      if (fromLocals != null) params[name] = fromLocals;
    });
    return {
      kind: "call",
      functionName: table.functionName,
      acceptedLines: [
        ...new Set(
          [table.steps?.[0]?.line, next.line].filter(
            (line): line is number => line != null && line > 0,
          ),
        ),
      ],
      params,
    };
  }

  if (kind === "return") {
    const childId = next.callSiteTableId ?? current.tableId;
    const child = tablesById.get(childId);
    return {
      kind: "return",
      line: next.line,
      returnValue: child?.returnValue ?? "None",
    };
  }

  const table = tablesById.get(next.tableId);
  const prevLocals =
    next.tableId === current.tableId
      ? localsAt(tablesById.get(current.tableId)!, current.stepIndex)
      : localsAt(table!, Math.max(0, next.stepIndex - 1));
  // After a callReturn stop, stepIndex does not advance; compare against the
  // same parent step when the next event stays on that table.
  const baseline =
    current.kind === "callReturn" && next.tableId === current.tableId
      ? localsAt(tablesById.get(current.tableId)!, current.stepIndex)
      : prevLocals;

  const nextLocals = localsAt(table!, next.stepIndex);
  return {
    kind: "advance",
    line: next.line,
    changes: changedLocals(baseline, nextLocals),
  };
}

export function defaultAdvanceLine(
  currentLine: number,
  lineCount: number,
): number {
  return Math.min(lineCount, Math.max(1, currentLine + 1));
}

export function isValidDocumentLine(
  line: number,
  lineCount: number,
): boolean {
  return Number.isInteger(line) && line >= 1 && line <= lineCount;
}

/** Compare change maps ignoring order; values compared as exact repr strings. */
export function sameChangeMap(
  expected: Record<string, string>,
  actual: Array<{ name: string; value: string }>,
  valueEqual: (a: string, b: string) => boolean,
): { ok: boolean; feedback: FieldFeedback[] } {
  const feedback: FieldFeedback[] = [];
  const used = new Set<string>();
  const expectedNames = new Set(Object.keys(expected));

  for (let i = 0; i < actual.length; i++) {
    const row = actual[i]!;
    const name = row.name.trim();
    const field = `change:${i}`;
    if (!name) {
      feedback.push({
        field,
        message: "Variable name is required",
        level: "error",
      });
      continue;
    }
    if (used.has(name)) {
      feedback.push({
        field,
        message: `Duplicate variable “${name}”`,
        level: "error",
      });
      continue;
    }
    used.add(name);
    const expectedValue = expected[name];
    if (expectedValue == null) {
      feedback.push({
        field,
        message: `“${name}” does not change on this step`,
        level: "error",
      });
      continue;
    }
    if (!valueEqual(expectedValue, row.value.trim())) {
      feedback.push({
        field: `${field}:value`,
        message: `Incorrect value for “${name}”`,
        level: "error",
      });
    }
  }

  for (const name of expectedNames) {
    if (!used.has(name)) {
      feedback.push({
        field: "changes",
        message: `Missing change for “${name}”`,
        level: "error",
      });
    }
  }

  if (actual.length === 0 && expectedNames.size === 0) {
    return { ok: true, feedback: [] };
  }

  return { ok: feedback.length === 0, feedback };
}

export function gradePrediction(
  expected: ExpectedPrediction,
  guess: PredictionGuess,
  valueEqual: (expectedRepr: string, guessText: string) => boolean,
): { ok: boolean; feedback: FieldFeedback[] } {
  if (guess.kind !== expected.kind) {
    return {
      ok: false,
      feedback: [
        {
          field: "kind",
          message: "Wrong event type for the next step",
          level: "error",
        },
      ],
    };
  }

  if (expected.kind === "advance" && guess.kind === "advance") {
    const feedback: FieldFeedback[] = [];
    if (guess.line !== expected.line) {
      feedback.push({
        field: "line",
        message: "Incorrect line number",
        level: "error",
      });
    }
    const changes = sameChangeMap(expected.changes, guess.changes, valueEqual);
    feedback.push(...changes.feedback);
    return { ok: feedback.length === 0, feedback };
  }

  if (expected.kind === "call" && guess.kind === "call") {
    const feedback: FieldFeedback[] = [];
    if (!expected.acceptedLines.includes(guess.line)) {
      feedback.push({
        field: "line",
        message: "Incorrect function destination line",
        level: "error",
      });
    }
    const expectedNames = Object.keys(expected.params);
    const seen = new Set<string>();
    for (let i = 0; i < guess.params.length; i++) {
      const row = guess.params[i]!;
      const name = row.name.trim();
      const field = `param:${i}`;
      if (!name) {
        feedback.push({
          field,
          message: "Parameter name is required",
          level: "error",
        });
        continue;
      }
      seen.add(name);
      const expectedValue = expected.params[name];
      if (expectedValue == null) {
        feedback.push({
          field,
          message: `Unexpected parameter “${name}”`,
          level: "error",
        });
        continue;
      }
      if (!valueEqual(expectedValue, row.value.trim())) {
        feedback.push({
          field: `${field}:value`,
          message: `Incorrect value for “${name}”`,
          level: "error",
        });
      }
    }
    for (const name of expectedNames) {
      if (!seen.has(name)) {
        feedback.push({
          field: "params",
          message: `Missing parameter “${name}”`,
          level: "error",
        });
      }
    }
    return { ok: feedback.length === 0, feedback };
  }

  if (expected.kind === "return" && guess.kind === "return") {
    const feedback: FieldFeedback[] = [];
    if (guess.line !== expected.line) {
      feedback.push({
        field: "line",
        message: "Incorrect return destination line",
        level: "error",
      });
    }
    if (!valueEqual(expected.returnValue, guess.returnValue.trim())) {
      feedback.push({
        field: "returnValue",
        message: "Incorrect return value",
        level: "error",
      });
    }
    return { ok: feedback.length === 0, feedback };
  }

  if (expected.kind === "output" && guess.kind === "output") {
    const normalize = (text: string) =>
      text.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const ok = normalize(guess.output) === normalize(expected.output);
    return {
      ok,
      feedback: ok
        ? []
        : [
            {
              field: "output",
              message: "Incorrect output",
              level: "error",
            },
          ],
    };
  }

  return {
    ok: false,
    feedback: [{ field: "kind", message: "Unable to grade", level: "error" }],
  };
}

/** Lightweight checks exercised in DEV / verify script. */
export function runEngineSelfChecks(): string[] {
  const failures: string[] = [];
  const assert = (cond: boolean, message: string) => {
    if (!cond) failures.push(message);
  };

  const current: TimelineEntry = {
    tableId: "t1",
    line: 4,
    stepIndex: 1,
    stack: ["t1"],
    stdoutLen: 0,
  };
  const callNext: TimelineEntry = {
    tableId: "t2",
    line: 2,
    stepIndex: 0,
    stack: ["t1", "t2"],
    stdoutLen: 0,
  };
  assert(classifyTransition(current, callNext) === "call", "stack growth → call");

  const retNext: TimelineEntry = {
    tableId: "t1",
    line: 4,
    stepIndex: 1,
    kind: "callReturn",
    callSiteTableId: "t2",
    stack: ["t1"],
    stdoutLen: 0,
  };
  assert(classifyTransition(callNext, retNext) === "return", "callReturn → return");

  const advanceNext: TimelineEntry = {
    tableId: "t1",
    line: 5,
    stepIndex: 2,
    stack: ["t1"],
    stdoutLen: 0,
  };
  assert(
    classifyTransition(retNext, advanceNext) === "advance",
    "same stack → advance",
  );

  const tables = new Map<string, TraceTable>([
    [
      "t1",
      {
        id: "t1",
        functionName: "<module>",
        args: [],
        returnValue: null,
        parameters: [],
        callIndex: 1,
        variables: ["x", "y"],
        types: { x: "int", y: "int" },
        histories: {},
        steps: [
          { line: 4, locals: { x: "1" } },
          { line: 4, locals: { x: "1" } },
          { line: 5, locals: { x: "1", y: "2" } },
        ],
      },
    ],
    [
      "t2",
      {
        id: "t2",
        functionName: "double",
        args: ["1"],
        returnValue: "2",
        parameters: ["n"],
        callIndex: 1,
        variables: ["n", "result"],
        types: { n: "int", result: "int" },
        histories: {},
        callSite: { line: 4, colOffset: 4, endColOffset: 13 },
        steps: [
          { line: 2, locals: { n: "1" } },
          { line: 3, locals: { n: "1", result: "2" } },
        ],
      },
    ],
  ]);

  const callExpected = expectedPrediction(current, callNext, tables);
  assert(callExpected.kind === "call", "expected call kind");
  if (callExpected.kind === "call") {
    assert(callExpected.functionName === "double", "call function name");
    assert(callExpected.params.n === "1", "call param n");
  }

  const returnExpected = expectedPrediction(callNext, retNext, tables);
  assert(returnExpected.kind === "return", "expected return kind");
  if (returnExpected.kind === "return") {
    assert(returnExpected.line === 4, "return line");
    assert(returnExpected.returnValue === "2", "return value");
  }

  const advanceExpected = expectedPrediction(retNext, advanceNext, tables);
  assert(advanceExpected.kind === "advance", "expected advance kind");
  if (advanceExpected.kind === "advance") {
    assert(advanceExpected.line === 5, "advance line");
    assert(advanceExpected.changes.y === "2", "advance change y");
  }

  const graded = gradePrediction(
    advanceExpected,
    {
      kind: "advance",
      line: 5,
      changes: [{ name: "y", value: "2" }],
    },
    (a, b) => a === b,
  );
  assert(graded.ok, "correct advance grades ok");

  const wrong = gradePrediction(
    advanceExpected,
    {
      kind: "advance",
      line: 6,
      changes: [{ name: "y", value: "3" }],
    },
    (a, b) => a === b,
  );
  assert(!wrong.ok, "wrong advance fails");
  assert(
    wrong.feedback.some((item) => item.field === "line"),
    "wrong line feedback",
  );

  assert(defaultAdvanceLine(4, 10) === 5, "default next line");
  assert(isValidDocumentLine(0, 10) === false, "line 0 invalid");
  assert(isValidDocumentLine(10, 10) === true, "last line valid");

  return failures;
}
