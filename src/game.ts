import "./game.css";
import {
  buildGameTimeline,
  classifyTransition,
  expectedPrediction,
  gradePrediction,
  isValidDocumentLine,
  runEngineSelfChecks,
  type FieldFeedback,
  type GameTimelineEntry,
  type PredictionGuess,
} from "./game/engine";
import { GAME_PROBLEMS, type GameFunctionDef, type GameProblem, type ProblemTemplate } from "./game/problems";
import {
  expandProblemTemplate,
  newInstanceSeed,
  type Bindings,
} from "./game/loadProblems";
import type {
  MainToWorker,
  TraceTable,
  WorkerToMain,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

if (import.meta.env.DEV) {
  const failures = runEngineSelfChecks();
  if (failures.length > 0) {
    console.error("Game engine self-checks failed:", failures);
  }
}

app.innerHTML = `
  <div class="game-page">
    <header class="game-hero">
      <p class="game-brand">Trace Practice</p>
      <h1>What happens next?</h1>
      <p class="game-lede predict-hint" id="predict-hint">
        Predict each step by clicking in the code or output.
        Set a variable by clicking its name on the left of <code>=</code>,
        then click a line to advance. Or click a call, return, print, or the output box.
      </p>
      <p class="sr-only" id="announce" aria-live="assertive"></p>
      <p class="complete-message" id="complete-message" hidden>
        Nice work — you predicted every step.
      </p>
    </header>

    <section class="game-setup" id="setup" aria-label="Choose a problem">
      <label class="problem-picker">
        <span>Problem</span>
        <select id="problem-select"></select>
      </label>
      <p class="problem-desc" id="problem-desc"></p>
      <button type="button" id="start" disabled>Start</button>
    </section>

    <section class="game-board" id="board" hidden aria-label="Prediction game">
      <div class="game-toolbar">
        <p class="game-status" id="status" aria-live="polite">Loading Python…</p>
        <p class="game-progress" id="progress">Step 0 / 0</p>
        <button type="button" id="restart" class="ghost">Change problem</button>
      </div>

      <div class="game-layout">
        <div class="game-code-pane">
          <h2>Code</h2>
          <pre class="game-code" id="code-view" aria-label="Python source"><code id="code-view-content"></code></pre>
          <div class="game-io predict-output" id="io" tabindex="0" role="button" aria-label="Predict produce output">
            <h2>Output</h2>
            <pre id="stdout"></pre>
          </div>
        </div>

        <div class="game-side-pane">
          <div class="game-panel">
            <h2>Call stack</h2>
            <ul class="stack-list" id="stack-list"></ul>
          </div>
          <div class="game-panel tables-panel">
            <h2>Trace tables</h2>
            <div class="tables-scroll">
              <div id="tables" class="tables"></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
`;

const setupEl = document.querySelector<HTMLElement>("#setup")!;
const boardEl = document.querySelector<HTMLElement>("#board")!;
const problemSelect = document.querySelector<HTMLSelectElement>("#problem-select")!;
const problemDesc = document.querySelector<HTMLElement>("#problem-desc")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const progressEl = document.querySelector<HTMLElement>("#progress")!;
const codeView = document.querySelector<HTMLElement>("#code-view")!;
const codeViewContent = document.querySelector<HTMLElement>("#code-view-content")!;
const stackList = document.querySelector<HTMLUListElement>("#stack-list")!;
const tablesEl = document.querySelector<HTMLDivElement>("#tables")!;
const ioEl = document.querySelector<HTMLElement>("#io")!;
const stdoutEl = document.querySelector<HTMLPreElement>("#stdout")!;
const predictHint = document.querySelector<HTMLElement>("#predict-hint")!;
const completeMessage = document.querySelector<HTMLElement>("#complete-message")!;
const announceEl = document.querySelector<HTMLElement>("#announce")!;

const callTooltip = document.createElement("div");
callTooltip.className = "game-call-tooltip";
callTooltip.hidden = true;
callTooltip.setAttribute("role", "tooltip");
document.body.appendChild(callTooltip);

const popover = document.createElement("div");
popover.className = "predict-popover";
popover.hidden = true;
popover.setAttribute("role", "dialog");
popover.setAttribute("aria-label", "Prediction details");
document.body.appendChild(popover);

type LiteralResult = { ok: boolean; canonical?: string; error?: string };

type PendingPrediction =
  | { kind: "assign"; name: string; line: number; anchor: HTMLElement }
  | {
      kind: "call";
      line: number;
      siteLine: number;
      functionName: string;
      anchor: HTMLElement;
    }
  | { kind: "return"; line: number; keywordLine: number; anchor: HTMLElement }
  | { kind: "output"; anchor: HTMLElement };

let ready = false;
let running = false;
let selectedTemplate: ProblemTemplate = GAME_PROBLEMS[0]!;
let problem: GameProblem = {
  id: selectedTemplate.id,
  title: selectedTemplate.title,
  description: selectedTemplate.description,
  code: "",
};
let sourceLines: string[] = [];
let tables: TraceTable[] = [];
let timeline: GameTimelineEntry[] = [];
let stdout = "";
/** Revealed timeline index; player predicts the transition to index+1. */
let stepIndex = 0;
let attempts = 0;
let pending: PendingPrediction | null = null;
let stagedChanges: Array<{ name: string; value: string }> = [];
let lineErrorTimer: number | null = null;

const pendingLiterals = new Map<
  string,
  { resolve: (value: LiteralResult) => void }
>();
let literalSeq = 0;

const pendingExpands = new Map<
  string,
  {
    resolve: (bindings: Bindings) => void;
    reject: (error: Error) => void;
  }
>();
let expandSeq = 0;

const worker = new Worker(
  new URL("./worker/pyodideWorker.ts", import.meta.url),
  { type: "module" },
);

function post(msg: MainToWorker): void {
  worker.postMessage(msg);
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function announce(text: string): void {
  announceEl.textContent = text;
}

function gameFinished(): boolean {
  return timeline.length > 0 && stepIndex >= timeline.length - 1;
}

function canPredict(): boolean {
  return timeline.length > 0 && !gameFinished() && !running;
}

function formatCallLabel(table: TraceTable): string {
  if (table.functionName === "<module>") return "module";
  return `${table.functionName}(${(table.args ?? []).join(", ")})`;
}

function tablesById(): Map<string, TraceTable> {
  return new Map(tables.map((table) => [table.id, table]));
}

function currentEntry(): GameTimelineEntry | null {
  return timeline[stepIndex] ?? null;
}

function validateLiteral(text: string): Promise<LiteralResult> {
  const id = `lit-${++literalSeq}`;
  return new Promise((resolve) => {
    pendingLiterals.set(id, { resolve });
    post({ type: "validateLiteral", id, text });
  });
}

function runSetupExpand(
  seed: number,
  bindings: Bindings,
  setup: string,
): Promise<Bindings> {
  const id = `exp-${++expandSeq}`;
  return new Promise((resolve, reject) => {
    pendingExpands.set(id, { resolve, reject });
    post({ type: "expand", id, seed, bindings, setup });
  });
}

async function canonicalOrNull(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const result = await validateLiteral(trimmed);
  return result.ok ? (result.canonical ?? null) : null;
}

async function valuesEqual(
  expectedRepr: string,
  guessText: string,
): Promise<boolean> {
  const [expected, guess] = await Promise.all([
    canonicalOrNull(expectedRepr),
    canonicalOrNull(guessText),
  ]);
  if (expected == null || guess == null) return false;
  return expected === guess;
}

function syncProblemPicker(): void {
  problemSelect.replaceChildren();
  for (const item of GAME_PROBLEMS) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    problemSelect.appendChild(option);
  }
  selectedTemplate =
    GAME_PROBLEMS.find((item) => item.id === problemSelect.value) ??
    GAME_PROBLEMS[0]!;
  problemDesc.textContent = selectedTemplate.description;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseParamNames(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const names: string[] = [];
  for (const part of trimmed.split(",")) {
    let piece = part.trim();
    if (!piece || piece === "*" || piece === "/") continue;
    piece = piece.replace(/^\*+/, "").trim();
    if (!piece) continue;
    const name = piece.split("=")[0]!.trim().split(":")[0]!.trim();
    if (/^[A-Za-z_]\w*$/.test(name)) names.push(name);
  }
  return names;
}

/** All defs in the current problem source — used for call targets. */
function discoverFunctions(source: string): GameFunctionDef[] {
  const found: GameFunctionDef[] = [];
  const seen = new Set<string>();
  for (const line of source.replace(/\n$/, "").split("\n")) {
    const match = line.match(
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*:/,
    );
    if (!match) continue;
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    found.push({ name, parameters: parseParamNames(match[2] ?? "") });
  }
  return found;
}

function callableFunctions(): GameFunctionDef[] {
  const source =
    sourceLines.length > 0 ? sourceLines.join("\n") : problem.code;
  const discovered = discoverFunctions(source);
  if (discovered.length > 0) return discovered;
  return problem.functions ?? [];
}

function functionDefInfo(
  name: string,
): { name: string; parameters: string[]; line: number } | null {
  const fn = callableFunctions().find((item) => item.name === name);
  if (!fn) return null;
  const defIndex = sourceLines.findIndex((text) =>
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(`).test(
      text,
    ),
  );
  if (defIndex < 0) return null;
  return { ...fn, line: defIndex + 1 };
}

function functionAtLine(
  line: number,
): { name: string; parameters: string[]; line: number } | null {
  for (const fn of callableFunctions()) {
    const info = functionDefInfo(fn.name);
    if (!info) continue;
    let bodyLine = info.line + 1;
    while (
      bodyLine <= sourceLines.length &&
      isIgnorableSourceLine(sourceLines[bodyLine - 1] ?? "")
    ) {
      bodyLine += 1;
    }
    if (line === info.line || line === bodyLine) return info;
  }
  return null;
}

function activeReturnLine(): number {
  const current = currentEntry();
  if (!current) return 1;
  const table = tablesById().get(current.tableId);
  return table?.callSite?.line ?? current.line;
}

type GameCallRange = {
  table: TraceTable;
  start: number;
  end: number;
  returned: boolean;
  titles: string[];
  children: GameCallRange[];
};

function hideCallTooltip(): void {
  callTooltip.hidden = true;
  callTooltip.replaceChildren();
}

function showCallTooltip(anchor: HTMLElement, titles: string[]): void {
  const list = document.createElement("div");
  list.className = "game-call-tooltip-list";
  for (const title of titles) {
    const row = document.createElement("div");
    row.className = "game-call-tooltip-row";
    row.textContent = title;
    list.appendChild(row);
  }
  callTooltip.replaceChildren(list);
  callTooltip.hidden = false;
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = callTooltip.getBoundingClientRect();
  const gap = 4;
  const maxLeft = Math.max(gap, window.innerWidth - tooltipRect.width - gap);
  const left = Math.min(Math.max(gap, anchorRect.left), maxLeft);
  let top = anchorRect.bottom + gap;
  if (top + tooltipRect.height > window.innerHeight - gap) {
    top = Math.max(gap, anchorRect.top - tooltipRect.height - gap);
  }
  callTooltip.style.left = `${left}px`;
  callTooltip.style.top = `${top}px`;
}

function latestLineForTable(tableId: string): number | null {
  let line: number | null = null;
  for (let i = 0; i <= stepIndex; i++) {
    const entry = timeline[i];
    if (entry?.tableId === tableId && entry.gameEvent !== "output") {
      line = entry.line;
    }
  }
  return line;
}

function stackHighlightLines(): Map<number, "stack" | "current"> {
  const current = currentEntry();
  const result = new Map<number, "stack" | "current">();
  if (!current) return result;
  const byId = tablesById();
  for (let i = 0; i < current.stack.length; i++) {
    const tableId = current.stack[i]!;
    const isCurrent = tableId === current.tableId;
    const childId = current.stack[i + 1];
    const child = childId ? byId.get(childId) : undefined;
    const line =
      (!isCurrent ? child?.callSite?.line : undefined) ??
      latestLineForTable(tableId);
    if (line == null || line < 1) continue;
    if (isCurrent || !result.has(line)) {
      result.set(line, isCurrent ? "current" : "stack");
    }
  }
  return result;
}

function callRangesForLine(line: number, textLength: number): GameCallRange[] {
  const started = new Set(
    timeline.slice(0, stepIndex + 1).map((entry) => entry.tableId),
  );
  const returned = new Set(
    timeline
      .slice(0, stepIndex + 1)
      .filter((entry) => entry.kind === "callReturn")
      .map((entry) => entry.callSiteTableId)
      .filter((id): id is string => id != null),
  );
  const candidates = tables
    .filter(
      (table) =>
        started.has(table.id) &&
        table.callSite?.line === line &&
        table.callSite.endColOffset > table.callSite.colOffset,
    )
    .map((table) => ({
      table,
      start: Math.max(0, Math.min(textLength, table.callSite!.colOffset)),
      end: Math.max(0, Math.min(textLength, table.callSite!.endColOffset)),
      returned: returned.has(table.id),
    }));
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = `${candidate.start}:${candidate.end}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const ranges: GameCallRange[] = [...grouped.values()]
    .map((group) => {
      const latest = group.at(-1)!;
      return {
        ...latest,
        returned: group.every((call) => call.returned),
        titles: group.map((call) =>
          call.returned
            ? `${formatCallLabel(call.table)} → ${call.table.returnValue ?? "None"}`
            : formatCallLabel(call.table),
        ),
        children: [],
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const roots: GameCallRange[] = [];
  const stack: GameCallRange[] = [];
  for (const range of ranges) {
    while (stack.length > 0 && range.start >= stack.at(-1)!.end) stack.pop();
    const parent = stack.at(-1);
    if (parent && range.end <= parent.end) parent.children.push(range);
    else if (!parent) roots.push(range);
    else continue;
    stack.push(range);
  }
  return roots;
}

function tokenPattern(): RegExp | null {
  const names = [...callableFunctions().map((fn) => fn.name)].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) {
    return /\breturn\b|\bprint\b(?=\s*\()/g;
  }
  const nameAlt = names.map(escapeRegExp).join("|");
  return new RegExp(
    `\\breturn\\b|\\bprint\\b(?=\\s*\\()|(?:^|(?<=\\s))(?:async\\s+)?def\\s+(${nameAlt})\\b|\\b(${nameAlt})\\b(?=\\s*\\()`,
    "g",
  );
}

function isIgnorableSourceLine(text: string): boolean {
  return /^\s*(#.*)?$/.test(text);
}

function lineIndent(text: string): number {
  const match = text.match(/^[ \t]*/);
  return match?.[0]?.length ?? 0;
}

function isForLoopLine(line: number): boolean {
  const text = sourceLines[line - 1] ?? "";
  return /^\s*(?:async\s+)?for\b/.test(text);
}

/** True when next stops on a for-header and the following stop leaves the loop. */
function forLoopExitAdvance(): {
  forLine: number;
  afterLine: number;
  afterEntry: GameTimelineEntry;
} | null {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next || !after) return null;
  if (classifyTransition(current, next) !== "advance") return null;
  if (!isForLoopLine(next.line)) return null;
  if (classifyTransition(next, after) !== "advance") return null;
  const forIndent = lineIndent(sourceLines[next.line - 1] ?? "");
  const afterIndent = lineIndent(sourceLines[after.line - 1] ?? "");
  if (afterIndent > forIndent) return null;
  return { forLine: next.line, afterLine: after.line, afterEntry: after };
}

function matchAssignableName(
  text: string,
): { indent: string; name: string; nameStart: number; nameEnd: number } | null {
  const assign = text.match(
    /^(\s*)([A-Za-z_]\w*)\s*(?:\+=|-=|\*=|\/=|\/\/=|%=|\*\*=|&=|\|=|\^=|>>=|<<=|@=|=(?!=))/,
  );
  if (assign) {
    const indent = assign[1] ?? "";
    const name = assign[2]!;
    const nameStart = indent.length;
    return { indent, name, nameStart, nameEnd: nameStart + name.length };
  }
  const forLoop = text.match(/^(\s*)(?:async\s+)?for\s+([A-Za-z_]\w*)\s+in\b/);
  if (forLoop) {
    const indent = forLoop[1] ?? "";
    const name = forLoop[2]!;
    const nameStart = text.indexOf(name, indent.length);
    return { indent, name, nameStart, nameEnd: nameStart + name.length };
  }
  return null;
}

function appendTokenizedCode(
  parent: HTMLElement,
  text: string,
  allowReturn: boolean,
  allowOutput: boolean,
): void {
  const pattern = tokenPattern();
  if (!pattern || !text) {
    parent.append(text);
    return;
  }
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(text.slice(cursor, index));
    const full = match[0]!;
    const defName = match[1];
    const callName = match[2];
    if (full === "return") {
      if (allowReturn) {
        const span = document.createElement("span");
        span.className = "predict-return";
        span.dataset.predict = "return";
        span.textContent = full;
        parent.appendChild(span);
      } else {
        parent.append(full);
      }
    } else if (full === "print") {
      if (allowOutput) {
        const span = document.createElement("span");
        span.className = "predict-print";
        span.dataset.predict = "output";
        span.textContent = full;
        parent.appendChild(span);
      } else {
        parent.append(full);
      }
    } else if (defName) {
      const defPrefix = full.slice(0, full.length - defName.length);
      parent.append(defPrefix);
      const span = document.createElement("span");
      span.className = "predict-call";
      span.dataset.predict = "call";
      span.dataset.functionName = defName;
      span.textContent = defName;
      parent.appendChild(span);
    } else if (callName) {
      const span = document.createElement("span");
      span.className = "predict-call";
      span.dataset.predict = "call";
      span.dataset.functionName = callName;
      span.textContent = callName;
      parent.appendChild(span);
    } else {
      parent.append(full);
    }
    cursor = index + full.length;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function nextReturnCallSiteTableId(): string | null {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next || !canPredict()) return null;
  if (classifyTransition(current, next) !== "return") return null;
  return next.callSiteTableId ?? null;
}

function appendCodeWithCalls(
  parent: HTMLElement,
  text: string,
  start: number,
  end: number,
  ranges: GameCallRange[],
  allowReturn: boolean,
  allowOutput: boolean,
  returnCallSiteTableId: string | null,
): void {
  let cursor = start;
  for (const range of ranges) {
    appendTokenizedCode(
      parent,
      text.slice(cursor, range.start),
      allowReturn,
      allowOutput,
    );
    const call = document.createElement("span");
    call.className = `game-call-history ${range.returned ? "returned" : "pending"}`;
    call.dataset.callTitles = JSON.stringify(range.titles);
    if (!range.returned && range.table.callSite) {
      call.classList.add("predict-return");
      call.dataset.predict = "return";
      call.dataset.returnLine = String(range.table.callSite.line);
    }
    appendCodeWithCalls(
      call,
      text,
      range.start,
      range.end,
      range.children,
      allowReturn,
      allowOutput,
      returnCallSiteTableId,
    );
    if (
      !range.returned &&
      returnCallSiteTableId &&
      range.table.id === returnCallSiteTableId
    ) {
      call.classList.add("return-ready");
      call.title = "Click to return here";
      const chip = document.createElement("span");
      chip.className = "return-ready-chip";
      chip.textContent = "↩";
      chip.setAttribute("aria-hidden", "true");
      call.appendChild(chip);
    }
    parent.appendChild(call);
    cursor = range.end;
  }
  appendTokenizedCode(parent, text.slice(cursor, end), allowReturn, allowOutput);
}

function returnKeywordLines(): Set<number> {
  const current = currentEntry();
  const lines = new Set<number>();
  if (!current || current.line < 1) return lines;
  lines.add(current.line);
  let nextLine = current.line + 1;
  while (
    nextLine <= sourceLines.length &&
    isIgnorableSourceLine(sourceLines[nextLine - 1] ?? "")
  ) {
    nextLine += 1;
  }
  if (nextLine <= sourceLines.length) lines.add(nextLine);
  const loopExit = forLoopExitAdvance();
  if (loopExit) lines.add(loopExit.afterLine);
  return lines;
}

function renderCode(): void {
  const highlights = stackHighlightLines();
  const fragment = document.createDocumentFragment();
  const interactive = canPredict();
  const returnLines = returnKeywordLines();
  const returnCallSiteTableId = nextReturnCallSiteTableId();
  sourceLines.forEach((text, index) => {
    const lineNumber = index + 1;
    const lineEl = document.createElement("div");
    lineEl.className = "code-line";
    lineEl.dataset.line = String(lineNumber);
    const highlight = highlights.get(lineNumber);
    if (highlight === "current") lineEl.classList.add("current-line");
    else if (highlight === "stack") lineEl.classList.add("stack-line");
    const numberEl = document.createElement("span");
    numberEl.className = "code-line-number";
    if (interactive && !isIgnorableSourceLine(text)) {
      lineEl.classList.add("predict-line");
      numberEl.classList.add("predict-line-number");
    }
    numberEl.textContent = String(lineNumber);
    const textEl = document.createElement("span");
    textEl.className = "code-line-text";
    const displayText = text || " ";
    const ranges = callRangesForLine(lineNumber, displayText.length);
    const lhs = matchAssignableName(displayText);
    let contentStart = 0;
    if (lhs && interactive) {
      if (lhs.nameStart > 0) textEl.append(displayText.slice(0, lhs.nameStart));
      const assign = document.createElement("span");
      assign.className = "predict-assign";
      assign.dataset.predict = "assign";
      assign.dataset.varName = lhs.name;
      assign.textContent = lhs.name;
      textEl.appendChild(assign);
      contentStart = lhs.nameEnd;
    }
    const allowReturn = interactive && returnLines.has(lineNumber);
    appendCodeWithCalls(
      textEl,
      displayText,
      contentStart,
      displayText.length,
      ranges,
      allowReturn,
      interactive,
      returnCallSiteTableId,
    );
    lineEl.append(numberEl, textEl);
    fragment.appendChild(lineEl);
  });
  codeViewContent.replaceChildren(fragment);
  ioEl.classList.toggle("predict-ready", interactive);
  if (returnCallSiteTableId) {
    requestAnimationFrame(() => {
      codeViewContent
        .querySelector(".return-ready")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
}

function formatTableTitle(table: TraceTable): string {
  let title = formatCallLabel(table);
  if (table.functionName === "<module>") return title;
  const returned = timeline
    .slice(0, stepIndex + 1)
    .some(
      (entry) =>
        entry.kind === "callReturn" && entry.callSiteTableId === table.id,
    );
  if (returned && table.returnValue != null) {
    title += ` → ${table.returnValue}`;
  }
  return title;
}

function sliceTable(table: TraceTable, maxStepIndex: number): TraceTable | null {
  if (maxStepIndex < 0) return null;
  const allSteps = table.steps ?? [];
  if (allSteps.length === 0) return null;
  const steps = allSteps.slice(0, maxStepIndex + 1);
  const variables: string[] = [];
  const histories: Record<string, string[]> = {};
  const types: Record<string, string> = {};
  let prev: Record<string, string> = {};
  for (const step of steps) {
    for (const [name, value] of Object.entries(step.locals)) {
      if (!(name in histories)) {
        histories[name] = [];
        variables.push(name);
        types[name] = table.types?.[name] ?? "object";
      }
      if (prev[name] !== value) histories[name]!.push(value);
    }
    prev = { ...step.locals };
  }
  return { ...table, variables, types, histories, steps };
}

function maxStepForTable(tableId: string): number {
  let max = -1;
  for (let i = 0; i <= stepIndex; i++) {
    const entry = timeline[i];
    if (entry && entry.tableId === tableId && entry.gameEvent !== "output") {
      max = Math.max(max, entry.stepIndex);
    }
  }
  return max;
}

function changedVarsAtStep(table: TraceTable, at: number): Set<string> {
  const steps = table.steps ?? [];
  const curr = steps[at]?.locals ?? {};
  const prev = at > 0 ? (steps[at - 1]?.locals ?? {}) : {};
  const changed = new Set<string>();
  for (const [name, value] of Object.entries(curr)) {
    if (prev[name] !== value) changed.add(name);
  }
  return changed;
}

function renderTraceTable(
  table: TraceTable,
  role: "active" | "stack" | "idle",
): HTMLElement {
  const details = document.createElement("details");
  details.className = "trace-table";
  if (role === "active") details.classList.add("active");
  if (role === "stack") details.classList.add("on-stack");
  details.open = role !== "idle";
  details.dataset.tableId = table.id;

  const summary = document.createElement("summary");
  summary.className = "call-title";
  summary.textContent = formatTableTitle(table);
  details.appendChild(summary);

  const showStaged = role === "active" && stagedChanges.length > 0;
  const variables = [...table.variables];
  if (showStaged) {
    for (const row of stagedChanges) {
      if (!variables.includes(row.name)) variables.push(row.name);
    }
  }

  if (variables.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No local variables recorded.";
    details.appendChild(empty);
    return details;
  }

  const wrap = document.createElement("div");
  wrap.className = "table-scroll";
  const htmlTable = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const params = new Set(table.parameters ?? []);
  for (const name of variables) {
    const th = document.createElement("th");
    if (params.has(name)) th.classList.add("is-param");
    if (showStaged && stagedChanges.some((row) => row.name === name) &&
      !table.variables.includes(name)) {
      th.classList.add("staged-col");
    }
    const nameEl = document.createElement("span");
    nameEl.className = params.has(name) ? "var-name var-param" : "var-name";
    nameEl.textContent = name;
    th.appendChild(nameEl);
    const typeName = table.types?.[name];
    if (typeName) {
      const typeEl = document.createElement("span");
      typeEl.className = "var-type";
      typeEl.textContent = typeName;
      th.appendChild(typeEl);
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  htmlTable.appendChild(thead);

  const tbody = document.createElement("tbody");
  const highlight = role === "active" && currentEntry()?.kind !== "callReturn";
  const highlightStep = highlight ? (table.steps?.length ?? 1) - 1 : -1;
  const changed = highlight ? changedVarsAtStep(table, highlightStep) : null;
  const stagedByName = new Map(
    showStaged ? stagedChanges.map((row) => [row.name, row.value] as const) : [],
  );
  const columnHeights = variables.map((name) => {
    const historyLen = table.histories[name]?.length ?? 0;
    return stagedByName.has(name) ? historyLen + 1 : historyLen;
  });
  const maxRows = Math.max(0, ...columnHeights);
  for (let row = 0; row < maxRows; row++) {
    const tr = document.createElement("tr");
    for (const name of variables) {
      const td = document.createElement("td");
      const history = table.histories[name] ?? [];
      const stagedValue = stagedByName.get(name);
      if (row < history.length) {
        td.textContent = history[row]!;
        if (changed?.has(name) && row === history.length - 1) {
          td.classList.add("current-cell");
        }
      } else if (stagedValue != null && row === history.length) {
        td.className = "staged-cell";
        const editor = document.createElement("div");
        editor.className = "staged-editor";
        const input = valueInput(
          `staged-${name}`,
          `staged:${name}`,
          stagedValue,
        );
        input.classList.add("staged-value");
        const syncStagedWidth = () => {
          const len = Math.max(input.value.length, input.placeholder.length, 1);
          input.size = Math.max(4, len);
        };
        syncStagedWidth();
        input.addEventListener("input", syncStagedWidth);
        input.addEventListener("change", () => {
          void (async () => {
            const text = input.value.trim();
            if (!text) {
              stagedChanges = stagedChanges.filter((entry) => entry.name !== name);
              renderStackAndTables();
              return;
            }
            const check = await checkStagedAssignValue(name, text);
            if (!check.ok) {
              input.classList.add("field-error");
              input.title = check.message;
              announce(check.message);
              setStatus("Incorrect — try again");
              recordFailedAttempt();
              // Restore the previously staged correct value.
              const previous = stagedChanges.find((entry) => entry.name === name);
              input.value = previous?.value ?? "";
              syncStagedWidth();
              return;
            }
            input.classList.remove("field-error");
            input.title = "";
            stageChange(name, text, false);
            renderStackAndTables();
          })();
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "ghost remove-staged";
        remove.textContent = "×";
        remove.title = `Remove staged ${name}`;
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          stagedChanges = stagedChanges.filter((entry) => entry.name !== name);
          renderStackAndTables();
        });
        editor.append(input, remove);
        td.appendChild(editor);
      } else {
        td.className = "blank";
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  htmlTable.appendChild(tbody);
  wrap.appendChild(htmlTable);
  details.appendChild(wrap);
  return details;
}

function renderStackAndTables(): void {
  const current = currentEntry();
  stackList.replaceChildren();
  tablesEl.replaceChildren();

  if (!current) {
    const empty = document.createElement("li");
    empty.textContent = "No active frames";
    empty.className = "muted";
    stackList.appendChild(empty);
    const emptyTables = document.createElement("p");
    emptyTables.className = "empty muted";
    emptyTables.textContent = "No trace tables yet.";
    tablesEl.appendChild(emptyTables);
    return;
  }

  const byId = tablesById();
  const stackSet = new Set(current.stack);
  for (const tableId of current.stack) {
    const table = byId.get(tableId);
    if (!table) continue;
    const li = document.createElement("li");
    if (tableId === current.tableId) li.classList.add("current");
    const callLine = table.callSite?.line;
    li.textContent =
      callLine != null
        ? `${formatCallLabel(table)} · line ${callLine}`
        : formatCallLabel(table);
    stackList.appendChild(li);
  }

  const ordered = tables.filter((table) => table.functionName !== "<module>");

  let any = false;
  for (const table of ordered) {
    const sliced = sliceTable(table, maxStepForTable(table.id));
    if (!sliced) continue;
    any = true;
    let role: "active" | "stack" | "idle" = "idle";
    if (table.id === current.tableId) role = "active";
    else if (stackSet.has(table.id)) role = "stack";
    tablesEl.appendChild(renderTraceTable(sliced, role));
  }
  if (!any) {
    const emptyTables = document.createElement("p");
    emptyTables.className = "empty muted";
    emptyTables.textContent = "No trace tables yet.";
    tablesEl.appendChild(emptyTables);
  }
}

function renderIo(): void {
  const current = currentEntry();
  stdoutEl.textContent = stdout.slice(0, current?.stdoutLen ?? 0);
}

function renderProgress(): void {
  const total = Math.max(0, timeline.length - 1);
  const done = Math.min(stepIndex, total);
  progressEl.textContent = `Transition ${done} / ${total} · Attempts ${attempts}`;
}

function valueInput(
  name: string,
  field: string,
  initial = "",
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.dataset.field = field;
  input.placeholder = "Python literal";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = initial;
  input.addEventListener("change", async () => {
    const text = input.value.trim();
    if (!text) {
      input.classList.remove("field-warning");
      input.title = "";
      return;
    }
    const result = await validateLiteral(text);
    if (!result.ok) {
      input.classList.add("field-warning");
      input.title = result.error || "Not a valid Python literal";
    } else {
      input.classList.remove("field-warning");
      input.title = "";
    }
  });
  return input;
}

function positionPopover(anchor: HTMLElement): void {
  popover.hidden = false;
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const gap = 6;
  const maxLeft = Math.max(gap, window.innerWidth - popRect.width - gap);
  const left = Math.min(Math.max(gap, anchorRect.left), maxLeft);
  let top = anchorRect.bottom + gap;
  if (top + popRect.height > window.innerHeight - gap) {
    top = Math.max(gap, anchorRect.top - popRect.height - gap);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function clearPopoverFeedback(): void {
  popover
    .querySelectorAll<HTMLElement>("[data-field]")
    .forEach((el) => {
      el.classList.remove("field-error", "field-warning");
    });
  const list = popover.querySelector(".popover-feedback");
  if (list) list.replaceChildren();
}

function showPopoverFeedback(items: FieldFeedback[]): void {
  clearPopoverFeedback();
  const list = popover.querySelector(".popover-feedback");
  if (!list) return;
  for (const item of items) {
    const row = document.createElement("p");
    row.className = item.level;
    row.textContent = item.message;
    list.appendChild(row);
  }
  for (const item of items) {
    const el = popover.querySelector<HTMLElement>(
      `[data-field="${CSS.escape(item.field)}"]`,
    );
    if (!el) continue;
    el.classList.add(item.level === "warning" ? "field-warning" : "field-error");
  }
}

function hidePopover(): void {
  pending = null;
  popover.hidden = true;
  popover.replaceChildren();
}

function flashLineError(line: number, message: string): void {
  const lineEl = codeViewContent.querySelector<HTMLElement>(
    `.code-line[data-line="${line}"]`,
  );
  if (lineEl) {
    lineEl.classList.add("predict-line-error");
    if (lineErrorTimer != null) window.clearTimeout(lineErrorTimer);
    lineErrorTimer = window.setTimeout(() => {
      lineEl.classList.remove("predict-line-error");
      lineErrorTimer = null;
    }, 1600);
  }
  announce(message);
  setStatus("Incorrect — try again");
}

function clearStagedChanges(): void {
  stagedChanges = [];
}

function stageChange(
  name: string,
  value: string,
  rerender = true,
): void {
  const trimmedName = name.trim();
  stagedChanges = stagedChanges.filter((row) => row.name !== trimmedName);
  stagedChanges.push({ name: trimmedName, value });
  if (rerender) renderStackAndTables();
}

/** Validate a staged assign against the next advance step's expected locals. */
async function checkStagedAssignValue(
  name: string,
  value: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next || classifyTransition(current, next) !== "advance") {
    return {
      ok: false,
      message: "No variable update is needed for the next step",
    };
  }
  const expected = expectedPrediction(current, next, tablesById());
  if (expected.kind !== "advance") {
    return {
      ok: false,
      message: "No variable update is needed for the next step",
    };
  }
  const expectedValue = expected.changes[name];
  if (expectedValue == null) {
    return {
      ok: false,
      message: `“${name}” does not change on the next step`,
    };
  }
  if (!(await valuesEqual(expectedValue, value))) {
    return {
      ok: false,
      message: `Incorrect value for “${name}”`,
    };
  }
  return { ok: true };
}

function enablePopoverDrag(handle: HTMLElement): void {
  handle.classList.add("predict-popover-drag");
  handle.title = "Drag to move";
  let drag: { offsetX: number; offsetY: number } | null = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement | null)?.closest("input, textarea, button")) {
      return;
    }
    const rect = popover.getBoundingClientRect();
    drag = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const left = Math.min(
      Math.max(4, event.clientX - drag.offsetX),
      window.innerWidth - 40,
    );
    const top = Math.min(
      Math.max(4, event.clientY - drag.offsetY),
      window.innerHeight - 40,
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  });
  handle.addEventListener("pointerup", () => {
    drag = null;
  });
  handle.addEventListener("pointercancel", () => {
    drag = null;
  });
}

function buildPopover(next: PendingPrediction): void {
  pending = next;
  hideCallTooltip();
  popover.replaceChildren();

  const form = document.createElement("form");
  form.className = "predict-popover-form";

  const description = document.createElement("p");
  description.className = "predict-popover-desc";

  const fields = document.createElement("div");
  fields.className = "predict-popover-fields";

  const actions = document.createElement("div");
  actions.className = "predict-popover-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "predict-submit";
  submit.textContent = "→";
  submit.title =
    next.kind === "assign" ? "Stage variable update" : "Check prediction";
  submit.setAttribute(
    "aria-label",
    next.kind === "assign" ? "Stage variable update" : "Check prediction",
  );
  actions.appendChild(submit);

  const feedback = document.createElement("div");
  feedback.className = "popover-feedback";

  if (next.kind === "assign") {
    description.textContent = `Set ${next.name}`;
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = "assignValue";
    const existing = stagedChanges.find((entry) => entry.name === next.name);
    const input = valueInput("assignValue", "assignValue", existing?.value ?? "");
    input.placeholder = "new value";
    row.append(input);
    fields.appendChild(row);
  } else if (next.kind === "call") {
    description.textContent = `Call ${next.functionName}()`;
    const rows = document.createElement("div");
    rows.className = "param-rows";
    rows.dataset.field = "params";

    const rowHasContent = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLInputElement>('input[type="text"]')].some(
        (input) => input.value.trim(),
      );

    const reindex = () => {
      [...rows.children].forEach((child, i) => {
        const row = child as HTMLElement;
        row.dataset.field = `param:${i}`;
        const inputs = [
          ...row.querySelectorAll<HTMLInputElement>('input[type="text"]'),
        ];
        if (inputs[0]) inputs[0].name = `param-name-${i}`;
        if (inputs[1]) {
          inputs[1].name = `param-value-${i}`;
          inputs[1].dataset.field = `param:${i}:value`;
        }
      });
    };

    const addRow = () => {
      const index = rows.children.length;
      const row = document.createElement("div");
      row.className = "param-row param-row-ghost";
      row.dataset.field = `param:${index}`;
      const nameField = document.createElement("input");
      nameField.type = "text";
      nameField.name = `param-name-${index}`;
      nameField.placeholder = "parameter";
      nameField.autocomplete = "off";
      nameField.spellcheck = false;
      const valField = valueInput(
        `param-value-${index}`,
        `param:${index}:value`,
      );
      valField.placeholder = "value";
      const onEdit = () => {
        const filled = rowHasContent(row);
        row.classList.toggle("param-row-ghost", !filled);
        row.classList.toggle("param-row-solid", filled);
        const last = rows.lastElementChild as HTMLElement | null;
        if (last && rowHasContent(last)) addRow();
        // Drop empty rows that aren't the trailing ghost.
        [...rows.querySelectorAll<HTMLElement>(".param-row")].forEach(
          (entry, _i, list) => {
            if (entry === list.at(-1)) return;
            if (!rowHasContent(entry)) entry.remove();
          },
        );
        reindex();
      };
      nameField.addEventListener("input", onEdit);
      valField.addEventListener("input", onEdit);
      row.append(nameField, valField);
      rows.appendChild(row);
      reindex();
    };

    addRow();
    fields.appendChild(rows);
  } else if (next.kind === "return") {
    description.textContent = "Return";
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = "returnValue";
    const input = valueInput("returnValue", "returnValue");
    input.placeholder = "return value";
    row.append(input);
    fields.appendChild(row);
  } else {
    description.textContent = "Produce output";
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = "output";
    const textarea = document.createElement("textarea");
    textarea.name = "output";
    textarea.rows = 2;
    textarea.placeholder = "Exact output";
    textarea.spellcheck = false;
    row.append(textarea);
    fields.appendChild(row);
  }

  form.append(description, fields, actions, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitPending();
  });
  popover.appendChild(form);
  enablePopoverDrag(description);
  positionPopover(next.anchor);
  const firstInput = popover.querySelector<HTMLElement>("input, textarea");
  firstInput?.focus();
}

function readGuessFromPopover(): PredictionGuess | null {
  if (!pending) return null;
  if (pending.kind === "assign") return null;
  if (pending.kind === "call") {
    const rows = [...popover.querySelectorAll<HTMLElement>(".param-row")];
    const params = rows
      .map((row) => {
        const inputs = [
          ...row.querySelectorAll<HTMLInputElement>('input[type="text"]'),
        ];
        return {
          name: inputs[0]?.value ?? "",
          value: inputs[1]?.value ?? "",
        };
      })
      .filter((row) => row.name.trim() || row.value.trim());
    return { kind: "call", line: pending.line, params };
  }
  if (pending.kind === "return") {
    const returnValue =
      popover.querySelector<HTMLInputElement>('input[name="returnValue"]')
        ?.value ?? "";
    return { kind: "return", line: pending.line, returnValue };
  }
  const output =
    popover.querySelector<HTMLTextAreaElement>('textarea[name="output"]')
      ?.value ?? "";
  return { kind: "output", output };
}

async function collectLiteralWarnings(
  guess: PredictionGuess,
): Promise<FieldFeedback[]> {
  const warnings: FieldFeedback[] = [];
  const check = async (field: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      warnings.push({
        field,
        message: "Value is required",
        level: "error",
      });
      return;
    }
    const result = await validateLiteral(trimmed);
    if (!result.ok) {
      warnings.push({
        field,
        message: "Not a valid Python literal (strings need quotes)",
        level: "warning",
      });
    }
  };

  if (guess.kind === "advance") {
    if (!isValidDocumentLine(guess.line, sourceLines.length)) {
      warnings.push({
        field: "line",
        message: `Line must be between 1 and ${sourceLines.length}`,
        level: "warning",
      });
    }
    for (let i = 0; i < guess.changes.length; i++) {
      const row = guess.changes[i]!;
      if (!row.name.trim()) {
        warnings.push({
          field: `change:${i}`,
          message: "Variable name is required",
          level: "error",
        });
      }
      if (row.name.trim() || row.value.trim()) {
        await check(`change:${i}:value`, row.value);
      }
    }
  } else if (guess.kind === "call") {
    if (!functionAtLine(guess.line)) {
      warnings.push({
        field: "line",
        message: "That line is not a function def or first body line",
        level: "error",
      });
    }
    for (let i = 0; i < guess.params.length; i++) {
      const row = guess.params[i]!;
      if (!row.name.trim()) {
        warnings.push({
          field: `param:${i}`,
          message: "Parameter name is required",
          level: "error",
        });
      }
      await check(`param:${i}:value`, row.value);
    }
  } else if (guess.kind === "return") {
    await check("returnValue", guess.returnValue);
  } else if (guess.kind === "output" && !guess.output.trim()) {
    warnings.push({
      field: "output",
      message: "Output is required",
      level: "error",
    });
  }
  return warnings;
}

async function evaluateGuess(
  expected: ReturnType<typeof expectedPrediction>,
  guess: PredictionGuess,
): Promise<{ ok: boolean; feedback: FieldFeedback[] }> {
  const cache = new Map<string, boolean>();
  const keyFor = (a: string, b: string) => `${a}\0${b}`;
  const pairs: Array<[string, string]> = [];
  if (expected.kind === "advance" && guess.kind === "advance") {
    for (const row of guess.changes) {
      const exp = expected.changes[row.name.trim()];
      if (exp != null) pairs.push([exp, row.value]);
    }
  } else if (expected.kind === "call" && guess.kind === "call") {
    for (const row of guess.params) {
      const exp = expected.params[row.name.trim()];
      if (exp != null) pairs.push([exp, row.value]);
    }
  } else if (expected.kind === "return" && guess.kind === "return") {
    pairs.push([expected.returnValue, guess.returnValue]);
  }
  await Promise.all(
    pairs.map(async ([a, b]) => {
      cache.set(keyFor(a, b), await valuesEqual(a, b));
    }),
  );
  return gradePrediction(expected, guess, (a, b) =>
    cache.get(keyFor(a, b)) ?? a === b,
  );
}

async function applySuccessfulGuesses(steps: number, message: string): Promise<void> {
  attempts += steps;
  hidePopover();
  clearStagedChanges();
  stepIndex += steps;
  setStatus("Correct");
  announce(message);
  renderAll();
}

function stagedAdvanceGuess(line: number): PredictionGuess {
  return {
    kind: "advance",
    line,
    changes: stagedChanges.map((row) => ({ ...row })),
  };
}

/**
 * If the next transition is an advance fully explained by current staged
 * changes (and optional line constraint), apply it. Does not count a failure.
 */
async function tryAutoAdvance(options?: {
  requireLine?: number;
  message?: string;
}): Promise<boolean> {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next) return false;
  if (classifyTransition(current, next) !== "advance") return false;
  const expected = expectedPrediction(current, next, tablesById());
  if (expected.kind !== "advance") return false;
  if (
    options?.requireLine != null &&
    options.requireLine !== expected.line &&
    options.requireLine !== current.line
  ) {
    return false;
  }
  const result = await evaluateGuess(
    expected,
    stagedAdvanceGuess(expected.line),
  );
  if (!result.ok) return false;
  await applySuccessfulGuesses(
    1,
    options?.message ?? "Correct. Advanced.",
  );
  return true;
}

async function submitCallPrediction(guess: PredictionGuess): Promise<void> {
  if (guess.kind !== "call" || !pending || pending.kind !== "call") return;
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return;
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);

  if (nextKind === "call") {
    await gradeAndApply(guess);
    return;
  }

  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "call"
  ) {
    const advanceExpected = expectedPrediction(current, next, byId);
    if (
      advanceExpected.kind === "advance" &&
      advanceExpected.line !== pending.siteLine &&
      pending.siteLine !== current.line
    ) {
      // Call clicked on a line that isn't the upcoming advance target.
      recordFailedAttempt();
      showPopoverFeedback([
        {
          field: "params",
          message: "Advance to the call site first, or click the call on the next line",
          level: "error",
        },
      ]);
      setStatus("Incorrect — try again");
      return;
    }
    const advanceResult = await evaluateGuess(
      advanceExpected,
      stagedAdvanceGuess(
        advanceExpected.kind === "advance"
          ? advanceExpected.line
          : pending.siteLine,
      ),
    );
    if (!advanceResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(advanceResult.feedback);
      announce("Not quite — check values before the call.");
      setStatus("Incorrect — try again");
      return;
    }
    const callExpected = expectedPrediction(next, after, byId);
    const callResult = await evaluateGuess(callExpected, guess);
    if (!callResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(callResult.feedback);
      announce("Not quite — check the call.");
      setStatus("Incorrect — try again");
      return;
    }
    await applySuccessfulGuesses(2, "Correct. Advanced and called.");
    return;
  }

  recordFailedAttempt();
  showPopoverFeedback([
    {
      field: "params",
      message: "Call is not the next step from here",
      level: "error",
    },
  ]);
  setStatus("Incorrect — try again");
}

async function submitOutputPrediction(guess: PredictionGuess): Promise<void> {
  if (guess.kind !== "output") return;
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return;
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);

  if (nextKind === "output") {
    await gradeAndApply(guess);
    return;
  }

  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "output"
  ) {
    const advanceExpected = expectedPrediction(current, next, byId);
    const advanceResult = await evaluateGuess(
      advanceExpected,
      stagedAdvanceGuess(
        advanceExpected.kind === "advance"
          ? advanceExpected.line
          : current.line,
      ),
    );
    if (!advanceResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(advanceResult.feedback);
      announce("Not quite — check values before the output.");
      setStatus("Incorrect — try again");
      return;
    }
    const outputExpected = expectedPrediction(next, after, byId);
    const outputResult = await evaluateGuess(outputExpected, guess);
    if (!outputResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(outputResult.feedback);
      announce("Not quite — check the output.");
      setStatus("Incorrect — try again");
      return;
    }
    await applySuccessfulGuesses(2, "Correct. Advanced and produced output.");
    return;
  }

  recordFailedAttempt();
  showPopoverFeedback([
    {
      field: "output",
      message: "Output is not the next step from here",
      level: "error",
    },
  ]);
  setStatus("Incorrect — try again");
}

function recordFailedAttempt(): void {
  attempts += 1;
  renderProgress();
}

async function gradeAndApply(
  guess: PredictionGuess,
  steps = 1,
): Promise<boolean> {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next) return false;

  const expected = expectedPrediction(current, next, tablesById());
  const result = await evaluateGuess(expected, guess);

  if (!result.ok) {
    recordFailedAttempt();
    if (pending) showPopoverFeedback(result.feedback);
    else if (guess.kind === "advance") {
      const detail =
        result.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(guess.line, detail);
    }
    announce("Not quite — check the highlighted answers and try again.");
    setStatus("Incorrect — try again");
    return false;
  }

  await applySuccessfulGuesses(steps, "Correct. Advanced to the next step.");
  return true;
}

async function submitReturnPrediction(
  returnValue: string,
  keywordLine: number,
): Promise<void> {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  const third = timeline[stepIndex + 3];
  if (!current || !next) return;

  const byId = tablesById();
  const nextKind = classifyTransition(current, next);

  if (nextKind === "return") {
    const expected = expectedPrediction(current, next, byId);
    await gradeAndApply({
      kind: "return",
      line: expected.kind === "return" ? expected.line : activeReturnLine(),
      returnValue,
    });
    return;
  }

  const loopExit = forLoopExitAdvance();
  if (
    loopExit &&
    after &&
    third &&
    loopExit.afterLine === keywordLine &&
    classifyTransition(after, third) === "return"
  ) {
    const staged = stagedChanges.map((row) => ({ ...row }));
    const toFor: PredictionGuess = {
      kind: "advance",
      line: loopExit.forLine,
      changes: staged,
    };
    const forExpected = expectedPrediction(current, next, byId);
    const forResult = await evaluateGuess(forExpected, toFor);
    if (!forResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(forResult.feedback);
      announce("Not quite — check the loop exit / return prediction.");
      setStatus("Incorrect — try again");
      return;
    }

    const toReturn: PredictionGuess = {
      kind: "advance",
      line: loopExit.afterLine,
      changes: [],
    };
    const returnLineExpected = expectedPrediction(next, after, byId);
    const returnLineResult = await evaluateGuess(returnLineExpected, toReturn);
    if (!returnLineResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(returnLineResult.feedback);
      announce("Not quite — check the loop exit / return prediction.");
      setStatus("Incorrect — try again");
      return;
    }

    const returnExpected = expectedPrediction(after, third, byId);
    const returnGuess: PredictionGuess = {
      kind: "return",
      line:
        returnExpected.kind === "return"
          ? returnExpected.line
          : activeReturnLine(),
      returnValue,
    };
    const returnResult = await evaluateGuess(returnExpected, returnGuess);
    if (!returnResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(returnResult.feedback);
      announce("Not quite — check the return value.");
      setStatus("Incorrect — try again");
      return;
    }

    await applySuccessfulGuesses(3, "Correct. Exited the loop and returned.");
    return;
  }

  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "return" &&
    next.line === keywordLine
  ) {
    const advanceGuess: PredictionGuess = {
      kind: "advance",
      line: next.line,
      changes: stagedChanges.map((row) => ({ ...row })),
    };
    const advanceExpected = expectedPrediction(current, next, byId);
    const advanceResult = await evaluateGuess(advanceExpected, advanceGuess);
    if (!advanceResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(advanceResult.feedback);
      announce("Not quite — check the advance/return prediction.");
      setStatus("Incorrect — try again");
      return;
    }

    const returnExpected = expectedPrediction(next, after, byId);
    const returnGuess: PredictionGuess = {
      kind: "return",
      line:
        returnExpected.kind === "return"
          ? returnExpected.line
          : activeReturnLine(),
      returnValue,
    };
    const returnResult = await evaluateGuess(returnExpected, returnGuess);
    if (!returnResult.ok) {
      recordFailedAttempt();
      showPopoverFeedback(returnResult.feedback);
      announce("Not quite — check the return value.");
      setStatus("Incorrect — try again");
      return;
    }

    await applySuccessfulGuesses(2, "Correct. Advanced and returned.");
    return;
  }

  recordFailedAttempt();
  showPopoverFeedback([
    {
      field: "returnValue",
      message: "Return is not the next step from here",
      level: "error",
    },
  ]);
  announce("Not quite — return is not available for this step.");
  setStatus("Incorrect — try again");
}

async function submitPending(): Promise<void> {
  if (!pending) return;

  if (pending.kind === "assign") {
    const value =
      popover.querySelector<HTMLInputElement>('input[name="assignValue"]')
        ?.value ?? "";
    const warnings: FieldFeedback[] = [];
    const trimmed = value.trim();
    if (!trimmed) {
      warnings.push({
        field: "assignValue",
        message: "Value is required",
        level: "error",
      });
    } else {
      const result = await validateLiteral(trimmed);
      if (!result.ok) {
        warnings.push({
          field: "assignValue",
          message: "Not a valid Python literal (strings need quotes)",
          level: "warning",
        });
      }
    }
    if (warnings.length > 0) {
      showPopoverFeedback(warnings);
      return;
    }

    const name = pending.name;
    const assignLine = pending.line;
    const valueCheck = await checkStagedAssignValue(name, trimmed);
    if (!valueCheck.ok) {
      recordFailedAttempt();
      showPopoverFeedback([
        {
          field: "assignValue",
          message: valueCheck.message,
          level: "error",
        },
      ]);
      announce("Not quite — check the value and try again.");
      setStatus("Incorrect — try again");
      return;
    }

    hidePopover();
    stageChange(name, trimmed, false);
    const advanced = await tryAutoAdvance({
      requireLine: assignLine,
      message: "Correct. Set and advanced.",
    });
    if (advanced) return;
    renderStackAndTables();
    announce(
      `Staged ${name} = ${trimmed}. Click the next line to advance, or set another variable.`,
    );
    setStatus("Variable staged — click a line to advance");
    return;
  }

  if (pending.kind === "return") {
    const returnValue =
      popover.querySelector<HTMLInputElement>('input[name="returnValue"]')
        ?.value ?? "";
    const warnings: FieldFeedback[] = [];
    const trimmed = returnValue.trim();
    if (!trimmed) {
      warnings.push({
        field: "returnValue",
        message: "Value is required",
        level: "error",
      });
    } else {
      const result = await validateLiteral(trimmed);
      if (!result.ok) {
        warnings.push({
          field: "returnValue",
          message: "Not a valid Python literal (strings need quotes)",
          level: "warning",
        });
      }
    }
    if (warnings.length > 0) {
      showPopoverFeedback(warnings);
      return;
    }
    await submitReturnPrediction(trimmed, pending.keywordLine);
    return;
  }

  const guess = readGuessFromPopover();
  if (!guess) return;

  const precheck = await collectLiteralWarnings(guess);
  if (precheck.length > 0) {
    showPopoverFeedback(precheck);
    announce("Fix the highlighted fields, then try again.");
    return;
  }

  if (guess.kind === "call") {
    await submitCallPrediction(guess);
    return;
  }
  if (guess.kind === "output") {
    await submitOutputPrediction(guess);
    return;
  }

  await gradeAndApply(guess);
}

function openPrediction(next: PendingPrediction): void {
  if (!canPredict()) return;
  buildPopover(next);
}

async function submitAdvanceToLine(line: number): Promise<void> {
  const current = currentEntry();
  if (!current) return;
  const lineText = sourceLines[line - 1] ?? "";
  if (isIgnorableSourceLine(lineText) || line === current.line) {
    hidePopover();
    return;
  }
  hidePopover();

  const loopExit = forLoopExitAdvance();
  if (loopExit && line === loopExit.afterLine) {
    const next = timeline[stepIndex + 1]!;
    const after = loopExit.afterEntry;
    const byId = tablesById();

    const toFor: PredictionGuess = {
      kind: "advance",
      line: loopExit.forLine,
      changes: stagedChanges.map((row) => ({ ...row })),
    };
    const forExpected = expectedPrediction(current, next, byId);
    const forResult = await evaluateGuess(forExpected, toFor);
    if (!forResult.ok) {
      recordFailedAttempt();
      const detail =
        forResult.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(line, detail);
      announce("Not quite — check the loop exit prediction.");
      setStatus("Incorrect — try again");
      return;
    }

    const toAfter: PredictionGuess = {
      kind: "advance",
      line: loopExit.afterLine,
      changes: [],
    };
    const afterExpected = expectedPrediction(next, after, byId);
    const afterResult = await evaluateGuess(afterExpected, toAfter);
    if (!afterResult.ok) {
      recordFailedAttempt();
      const detail =
        afterResult.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(line, detail);
      announce("Not quite — check the loop exit prediction.");
      setStatus("Incorrect — try again");
      return;
    }

    await applySuccessfulGuesses(2, "Correct. Exited the loop.");
    return;
  }

  const guess: PredictionGuess = {
    kind: "advance",
    line,
    changes: stagedChanges.map((row) => ({ ...row })),
  };
  await gradeAndApply(guess);
}

const DEFAULT_PREDICT_HINT =
  "Predict each step by clicking in the code or output. " +
  "Set a variable by clicking its name on the left of <code>=</code>, " +
  "then click a line to advance. Or click a call, return, print, or the output box.";

function renderPredictionPanel(): void {
  const finished = gameFinished();
  completeMessage.hidden = !finished;
  if (finished) {
    hidePopover();
    clearStagedChanges();
    setStatus("Complete");
    predictHint.hidden = true;
    announce("Problem complete. You predicted every step.");
    return;
  }

  predictHint.hidden = false;
  if (timeline.length === 0) {
    predictHint.innerHTML = DEFAULT_PREDICT_HINT;
  } else if (nextReturnCallSiteTableId()) {
    predictHint.textContent =
      "Return next: click the highlighted call site (↩) and enter the return value.";
  } else {
    predictHint.textContent =
      "Click a variable, call, return, print, or output to predict — advances can combine with those actions when you target the next line.";
  }
}

function renderAll(): void {
  renderCode();
  renderStackAndTables();
  renderIo();
  renderProgress();
  renderPredictionPanel();
}

function showSetup(): void {
  setupEl.hidden = false;
  boardEl.hidden = true;
  tables = [];
  timeline = [];
  stepIndex = 0;
  attempts = 0;
  hidePopover();
  clearStagedChanges();
  completeMessage.hidden = true;
  predictHint.hidden = false;
  predictHint.innerHTML = DEFAULT_PREDICT_HINT;
}

function showBoard(): void {
  setupEl.hidden = true;
  boardEl.hidden = false;
}

problemSelect.addEventListener("change", () => {
  selectedTemplate =
    GAME_PROBLEMS.find((item) => item.id === problemSelect.value) ??
    GAME_PROBLEMS[0]!;
  problemDesc.textContent = selectedTemplate.description;
});

restartBtn.addEventListener("click", () => {
  showSetup();
  setStatus(ready ? "Ready" : "Loading Python…");
  startBtn.disabled = !ready || running;
});

startBtn.addEventListener("click", () => {
  if (!ready || running) return;
  selectedTemplate =
    GAME_PROBLEMS.find((item) => item.id === problemSelect.value) ??
    GAME_PROBLEMS[0]!;
  void startProblem(selectedTemplate);
});

async function startProblem(template: ProblemTemplate): Promise<void> {
  running = true;
  startBtn.disabled = true;
  showBoard();
  setStatus(template.setup ? "Expanding problem…" : "Tracing…");
  attempts = 0;
  stepIndex = 0;
  hidePopover();
  clearStagedChanges();
  tables = [];
  timeline = [];
  stdout = "";
  renderAll();

  try {
    const seed = newInstanceSeed();
    const expanded = await expandProblemTemplate(
      template,
      seed,
      runSetupExpand,
    );
    problem = {
      id: expanded.id,
      title: expanded.title,
      description: expanded.description,
      code: expanded.code,
      seed: expanded.seed,
    };
    sourceLines = problem.code.replace(/\n$/, "").split("\n");
    setStatus("Tracing…");
    renderAll();
    post({ type: "run", code: problem.code });
  } catch (err) {
    running = false;
    startBtn.disabled = !ready;
    showSetup();
    setStatus("Expand failed");
    announce(err instanceof Error ? err.message : String(err));
  }
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  if (msg.type === "ready") {
    ready = true;
    running = false;
    startBtn.disabled = false;
    setStatus("Ready");
    return;
  }
  if (msg.type === "error") {
    ready = false;
    running = false;
    startBtn.disabled = true;
    setStatus("Failed to load");
    announce(msg.message);
    return;
  }
  if (msg.type === "literalResult") {
    const pendingLit = pendingLiterals.get(msg.id);
    if (!pendingLit) return;
    pendingLiterals.delete(msg.id);
    pendingLit.resolve({
      ok: msg.ok,
      canonical: msg.canonical,
      error: msg.error,
    });
    return;
  }
  if (msg.type === "expanded") {
    const pendingExpand = pendingExpands.get(msg.id);
    if (!pendingExpand) return;
    pendingExpands.delete(msg.id);
    if (msg.ok) {
      pendingExpand.resolve(msg.bindings);
    } else {
      pendingExpand.reject(new Error(msg.error));
    }
    return;
  }
  if (msg.type === "result") {
    running = false;
    startBtn.disabled = !ready;
    tables = msg.tables;
    stdout = msg.stdout ?? "";
    timeline = buildGameTimeline(
      msg.timeline ?? [],
      problem.code,
      stdout,
    );
    stepIndex = timeline.length > 0 ? 0 : -1;
    if (msg.error) {
      setStatus("Finished with errors");
      announce(msg.error);
    } else if (timeline.length === 0) {
      setStatus("No steps to predict");
    } else {
      setStatus("Predict the next step");
    }
    hidePopover();
    clearStagedChanges();
    renderAll();
  }
};

worker.onerror = (event) => {
  setStatus("Worker error");
  announce(event.message || "Worker failed");
  running = false;
  startBtn.disabled = true;
};

function callHistoryAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>(".game-call-history");
  return anchor && codeViewContent.contains(anchor) ? anchor : null;
}

codeViewContent.addEventListener("pointerover", (event) => {
  const anchor = callHistoryAnchor(event.target);
  if (!anchor) return;
  if (callHistoryAnchor(event.relatedTarget) === anchor) return;
  try {
    const titles = JSON.parse(anchor.dataset.callTitles ?? "[]") as string[];
    if (titles.length > 0) showCallTooltip(anchor, titles);
  } catch {
    hideCallTooltip();
  }
});

codeViewContent.addEventListener("pointerout", (event) => {
  const anchor = callHistoryAnchor(event.target);
  if (!anchor) return;
  if (callHistoryAnchor(event.relatedTarget) === anchor) return;
  if (
    event.relatedTarget instanceof Node &&
    callTooltip.contains(event.relatedTarget)
  ) {
    return;
  }
  hideCallTooltip();
});

callTooltip.addEventListener("pointerleave", hideCallTooltip);
codeView.addEventListener("scroll", () => {
  hideCallTooltip();
});

codeViewContent.addEventListener("click", (event) => {
  if (!canPredict()) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  const assignTarget = target.closest<HTMLElement>("[data-predict='assign']");
  if (assignTarget && codeViewContent.contains(assignTarget)) {
    event.preventDefault();
    event.stopPropagation();
    const name = assignTarget.dataset.varName ?? "";
    if (!name) return;
    const lineEl = assignTarget.closest<HTMLElement>(".code-line[data-line]");
    const line = Number(lineEl?.dataset.line ?? currentEntry()?.line ?? 1);
    openPrediction({
      kind: "assign",
      name,
      line,
      anchor: assignTarget,
    });
    return;
  }

  const returnTarget = target.closest<HTMLElement>("[data-predict='return']");
  if (returnTarget && codeViewContent.contains(returnTarget)) {
    event.preventDefault();
    event.stopPropagation();
    const lineEl = returnTarget.closest<HTMLElement>(".code-line[data-line]");
    const keywordLine = Number(lineEl?.dataset.line ?? currentEntry()?.line ?? 1);
    const returnLine = Number(
      returnTarget.dataset.returnLine ?? activeReturnLine(),
    );
    openPrediction({
      kind: "return",
      line: returnLine,
      keywordLine,
      anchor: returnTarget,
    });
    return;
  }

  const outputTarget = target.closest<HTMLElement>("[data-predict='output']");
  if (outputTarget && codeViewContent.contains(outputTarget)) {
    event.preventDefault();
    event.stopPropagation();
    openPrediction({
      kind: "output",
      anchor: outputTarget,
    });
    return;
  }

  const callTarget = target.closest<HTMLElement>("[data-predict='call']");
  if (callTarget && codeViewContent.contains(callTarget)) {
    event.preventDefault();
    event.stopPropagation();
    const name = callTarget.dataset.functionName ?? "";
    const info = functionDefInfo(name);
    if (!info) return;
    const lineEl = callTarget.closest<HTMLElement>(".code-line[data-line]");
    const siteLine = Number(lineEl?.dataset.line ?? info.line);
    openPrediction({
      kind: "call",
      line: info.line,
      siteLine,
      functionName: info.name,
      anchor: callTarget,
    });
    return;
  }

  const lineEl = target.closest<HTMLElement>(".code-line[data-line]");
  if (!lineEl || !codeViewContent.contains(lineEl)) return;
  const line = Number(lineEl.dataset.line);
  if (!isValidDocumentLine(line, sourceLines.length)) return;
  void submitAdvanceToLine(line);
});

ioEl.addEventListener("click", (event) => {
  if (!canPredict()) return;
  event.preventDefault();
  openPrediction({
    kind: "output",
    anchor: ioEl,
  });
});

ioEl.addEventListener("keydown", (event) => {
  if (!canPredict()) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openPrediction({
    kind: "output",
    anchor: ioEl,
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pending) {
    event.preventDefault();
    hidePopover();
  }
});

document.addEventListener(
  "pointerdown",
  (event) => {
    if (!pending || popover.hidden) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (popover.contains(target)) return;
    if (pending.anchor.contains(target)) return;
    hidePopover();
  },
  true,
);

window.addEventListener("resize", () => {
  if (pending) positionPopover(pending.anchor);
});

syncProblemPicker();
showSetup();
post({ type: "init" });
