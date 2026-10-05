export type Difficulty = "tutorial" | "easy" | "medium" | "hard";

export type TipId = "output-format" | "literal-value" | "string-quotes";

export type PopoverKind = "assign" | "call" | "return" | "output";

export type ActionKind = "advance" | "call" | "return" | "output";

type FeedbackLike = {
  field: string;
  message: string;
  level: "error" | "warning";
};

export const DIFFICULTY_STORAGE_KEY = "step-ahead-difficulty";

export const TUTORIAL_PROBLEM_ID = "tutorial";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  tutorial: "Tutorial",
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/** Levels shown in difficulty dropdowns (tutorial is started via a link). */
export const SELECTABLE_DIFFICULTIES: Array<"easy" | "medium" | "hard"> = [
  "easy",
  "medium",
  "hard",
];

export const DIFFICULTIES: Difficulty[] = [
  "tutorial",
  ...SELECTABLE_DIFFICULTIES,
];

/** Easy scaffolding, tips, and explicit error wording (includes Tutorial). */
export function assistsLikeEasy(difficulty: Difficulty): boolean {
  return difficulty === "tutorial" || difficulty === "easy";
}

export function isTutorial(difficulty: Difficulty): boolean {
  return difficulty === "tutorial";
}

const TIP_COPY: Record<TipId, string> = {
  "output-format":
    "Print separates values with spaces, not commas. A lone string prints without quotes.",
  "literal-value":
    "Enter the actual value (a Python literal), not a variable name or expression.",
  "string-quotes":
    'Use proper Python string notation — strings need quotes (e.g. "hello").',
};

export function parseDifficulty(value: string | null | undefined): Difficulty {
  if (value === "tutorial") return "tutorial";
  if (value === "easy" || value === "medium" || value === "hard") return value;
  return "hard";
}

/** Persisted preference — never stores tutorial (session-only via the link). */
export function loadDifficulty(): "easy" | "medium" | "hard" {
  try {
    const parsed = parseDifficulty(localStorage.getItem(DIFFICULTY_STORAGE_KEY));
    if (parsed === "tutorial") return "easy";
    return parsed;
  } catch {
    return "hard";
  }
}

export function saveDifficulty(difficulty: Difficulty): void {
  if (difficulty === "tutorial") return;
  try {
    localStorage.setItem(DIFFICULTY_STORAGE_KEY, difficulty);
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function describeNextAction(kind: ActionKind): {
  short: string;
  howTo: string;
} {
  switch (kind) {
    case "advance":
      return {
        short: "variable assignment",
        howTo:
          "Click the variable on the left of `=` that gets a new value.",
      };
    case "call":
      return {
        short: "a function call",
        howTo: "Click the function name being called.",
      };
    case "return":
      return {
        short: "a return",
        howTo: "Click `return` or the highlighted call site.",
      };
    case "output":
      return {
        short: "output",
        howTo: "Click `print` or the Output box.",
      };
  }
}

export function formatKindMismatch(
  expectedKind: ActionKind,
  difficulty: Difficulty,
): string {
  if (difficulty === "hard") {
    return "Wrong event type for the next step";
  }
  const { short, howTo } = describeNextAction(expectedKind);
  if (difficulty === "medium") {
    return `The next step is ${short}.`;
  }
  // tutorial + easy
  return `The next step is ${short}. ${howTo}`;
}

export function formatWrongAssignTarget(
  clickedName: string,
  expectedChanges: Record<string, string>,
  difficulty: Difficulty,
): string {
  if (assistsLikeEasy(difficulty)) {
    const nextName = Object.keys(expectedChanges)[0];
    if (nextName) return `The variable ${nextName} needs to be set next`;
  }
  if (difficulty === "medium") {
    return "That is not the next variable to set";
  }
  return `“${clickedName}” does not change on the next step`;
}

export function formatNoAssignNeeded(
  expectedKind: ActionKind,
  difficulty: Difficulty,
): string {
  if (difficulty === "hard") {
    return "No variable update is needed for the next step";
  }
  return formatKindMismatch(expectedKind, difficulty);
}

export type CallParamScaffold = {
  mode: "freeform" | "named-locked" | "fixed-named";
  names: string[];
  rowCount: number;
};

export function callParamScaffold(
  difficulty: Difficulty,
  paramNames: string[],
): CallParamScaffold {
  const names = [...paramNames];
  if (assistsLikeEasy(difficulty)) {
    return { mode: "named-locked", names, rowCount: names.length };
  }
  if (difficulty === "medium") {
    return { mode: "fixed-named", names, rowCount: Math.max(names.length, 0) };
  }
  return { mode: "freeform", names, rowCount: 0 };
}

/**
 * Split a simple tuple-like Python repr into top-level elements.
 * Returns a single-element array for non-tuple values.
 */
export function splitReturnValueSlots(expectedReturnRepr: string): string[] {
  const text = expectedReturnRepr.trim();
  if (!text || text === "None") return [text || "None"];

  let inner = text;
  let wrapped = false;
  if (inner.startsWith("(") && inner.endsWith(")")) {
    inner = inner.slice(1, -1).trim();
    wrapped = true;
    if (!inner) return ["()"];
  }

  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escape = false;
  let start = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) parts.push(last);

  // Bare values and single-element parens without a comma stay one slot.
  if (!wrapped || parts.length <= 1) {
    if (wrapped && parts.length === 1 && !inner.includes(",")) {
      return [text];
    }
    if (!wrapped && parts.length <= 1) return [text];
  }

  return parts.length > 0 ? parts : [text];
}

export function returnValueSlotCount(expectedReturnRepr: string): number {
  return splitReturnValueSlots(expectedReturnRepr).length;
}

export function joinReturnValueSlots(
  values: string[],
  expectedReturnRepr: string,
): string {
  const expected = expectedReturnRepr.trim();
  const parts = values.map((value) => value.trim()).filter((value) => value);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  const joined = parts.join(", ");
  if (expected.startsWith("(") && expected.endsWith(")")) {
    return `(${joined})`;
  }
  return joined;
}

export function tipText(id: TipId): string {
  return TIP_COPY[id];
}

export function initialTipsForPopover(
  kind: PopoverKind,
  difficulty: Difficulty,
  expectedValues: string[] = [],
): TipId[] {
  if (!assistsLikeEasy(difficulty)) return [];
  if (kind === "output") return ["output-format"];
  if (kind === "assign" || kind === "call" || kind === "return") {
    const tips: TipId[] = ["literal-value"];
    if (expectedContainsString(expectedValues)) tips.push("string-quotes");
    return tips;
  }
  return [];
}

export function tipsForPopover(
  kind: PopoverKind,
  difficulty: Difficulty,
  revealed: ReadonlySet<TipId>,
): TipId[] {
  if (difficulty === "hard") return [];
  return [...revealed].filter((id) => tipAppliesToKind(id, kind));
}

function tipAppliesToKind(id: TipId, kind: PopoverKind): boolean {
  if (id === "output-format") return kind === "output";
  return kind === "assign" || kind === "call" || kind === "return";
}

export type TipGuessContext = {
  /** Raw value texts the player submitted (assign/call/return/output). */
  values?: string[];
  /** Expected string reprs for those values when available. */
  expectedValues?: string[];
  /** True when literal validation reported a quotes-related issue. */
  needsQuotes?: boolean;
  /** True when a value failed literal validation as a name/expression. */
  notLiteral?: boolean;
};

export function looksLikeStringRepr(text: string): boolean {
  const t = text.trim();
  return (
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ||
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2)
  );
}

export function expectedContainsString(expectedValues: string[]): boolean {
  return expectedValues.some(looksLikeStringRepr);
}

function unquote(text: string): string {
  const t = text.trim();
  if (looksLikeStringRepr(t)) return t.slice(1, -1);
  return t;
}

function guessLooksUnquotedString(
  guess: string,
  expected: string | undefined,
): boolean {
  if (!expected || !looksLikeStringRepr(expected)) return false;
  const g = guess.trim();
  if (!g || looksLikeStringRepr(g)) return false;
  return g === unquote(expected);
}

function messageSuggestsLiteralTip(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not a valid python literal") ||
    m.includes("variable name") ||
    m.includes("expression")
  );
}

function messageSuggestsQuotesTip(message: string): boolean {
  return message.toLowerCase().includes("quotes");
}

export function tipsToRevealOnFeedback(
  kind: PopoverKind,
  feedback: FeedbackLike[],
  context: TipGuessContext,
  difficulty: Difficulty,
): TipId[] {
  if (difficulty !== "medium") return [];

  const revealed: TipId[] = [];
  const messages = feedback.map((item) => item.message);

  if (kind === "output") {
    const failed = feedback.some((item) => item.level === "error");
    if (failed || context.notLiteral) revealed.push("output-format");
  }

  if (kind === "assign" || kind === "call" || kind === "return") {
    if (
      context.notLiteral ||
      messages.some(messageSuggestsLiteralTip) ||
      (context.values ?? []).some((value) => {
        const t = value.trim();
        return Boolean(t) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
      })
    ) {
      revealed.push("literal-value");
    }

    const hasStringAnswer = expectedContainsString(context.expectedValues ?? []);
    if (
      hasStringAnswer &&
      (context.needsQuotes ||
        messages.some(messageSuggestsQuotesTip) ||
        (context.values ?? []).some((guess, i) =>
          guessLooksUnquotedString(guess, context.expectedValues?.[i]),
        ))
    ) {
      revealed.push("string-quotes");
    }
  }

  return revealed.filter((id) => tipAppliesToKind(id, kind));
}
