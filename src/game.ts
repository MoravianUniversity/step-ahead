import "./game.css";
import confetti from "canvas-confetti";
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
  type PredictionKind,
} from "./game/engine";
import {
  DIFFICULTY_LABELS,
  SELECTABLE_DIFFICULTIES,
  TUTORIAL_PROBLEM_ID,
  assistsLikeEasy,
  callParamScaffold,
  formatKindMismatch,
  formatNoAssignNeeded,
  formatWrongAssignTarget,
  initialTipsForPopover,
  isTutorial,
  joinReturnValueSlots,
  loadDifficulty,
  progressiveAnswerHints,
  saveDifficulty,
  splitReturnValueSlots,
  tipText,
  tipsForPopover,
  tipsToRevealOnFeedback,
  type Difficulty,
  type PopoverKind,
  type ProgressiveHintContext,
  type TipGuessContext,
  type TipId,
} from "./game/difficulty";
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
      <p class="game-brand">Step Ahead</p>
      <h1>What happens next?</h1>
      <p class="game-lede">
        Predict each step in the code.
      </p>
      <p class="sr-only" id="announce" aria-live="assertive"></p>
    </header>

    <section class="game-setup" id="setup" aria-label="Choose a problem">
      <p class="setup-tutorial">
        First time?
        <a href="#tutorial" class="tutorial-link" id="tutorial-link">Play tutorial</a>
      </p>
      <div class="setup-controls">
        <label class="problem-picker">
          <span>Play:</span>
          <select id="problem-select"></select>
        </label>
        <label class="difficulty-picker">
          <select id="difficulty-select" aria-label="Difficulty"></select>
        </label>
        <button type="button" id="start" disabled>Start →</button>
      </div>
      <p class="problem-desc" id="problem-desc"></p>
    </section>

    <section class="game-board" id="board" hidden aria-label="Prediction game">
      <div class="game-toolbar">
        <div class="game-progress" id="progress" aria-label="Progress">
          <div class="game-progress-meta">
            <span id="progress-label">Step 0 / 0</span>
            <button type="button" class="progress-mistakes" id="progress-mistakes" hidden aria-expanded="false" aria-haspopup="true">
              Mistakes 0
            </button>
          </div>
          <div class="game-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" id="progress-bar">
            <div class="game-progress-fill" id="progress-fill"></div>
          </div>
        </div>
        <div class="game-toolbar-actions">
          <p class="tutorial-badge toolbar-difficulty" id="tutorial-badge" hidden>Tutorial</p>
          <label class="difficulty-picker toolbar-difficulty" id="toolbar-difficulty-wrap">
            <select id="difficulty-select-board" aria-label="Difficulty"></select>
          </label>
          <button type="button" id="restart" class="ghost">Home</button>
        </div>
      </div>

      <div class="game-layout">
        <div class="game-code-pane">
          <div class="game-section">
            <p class="predict-hint" id="predict-hint" hidden></p>
            <h2>Code</h2>
            <pre class="game-code" id="code-view" aria-label="Python source"><code id="code-view-content"></code></pre>
          </div>
          <div class="game-section">
            <h2>Output</h2>
            <div class="game-io predict-output" id="io" tabindex="0" role="button" aria-label="Predict produce output">
              <pre id="stdout"></pre>
            </div>
          </div>
        </div>

        <div class="game-side-pane">
          <div class="game-section tables-panel">
            <h2>Trace tables</h2>
            <div class="game-panel">
              <div class="tables-scroll">
                <div id="tables" class="tables"></div>
              </div>
            </div>
          </div>
          <div class="game-section">
            <h2>Call stack</h2>
            <div class="game-panel">
              <ul class="stack-list" id="stack-list"></ul>
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
const difficultySelect = document.querySelector<HTMLSelectElement>("#difficulty-select")!;
const difficultySelectBoard = document.querySelector<HTMLSelectElement>(
  "#difficulty-select-board",
)!;
const toolbarDifficultyWrap = document.querySelector<HTMLElement>(
  "#toolbar-difficulty-wrap",
)!;
const tutorialBadge = document.querySelector<HTMLElement>("#tutorial-badge")!;
const tutorialLink = document.querySelector<HTMLAnchorElement>("#tutorial-link")!;
const problemDesc = document.querySelector<HTMLElement>("#problem-desc")!;
const startBtn = document.querySelector<HTMLButtonElement>("#start")!;
const restartBtn = document.querySelector<HTMLButtonElement>("#restart")!;
const progressEl = document.querySelector<HTMLElement>("#progress")!;
const progressLabelEl = document.querySelector<HTMLElement>("#progress-label")!;
const progressMistakesEl = document.querySelector<HTMLButtonElement>("#progress-mistakes")!;
const progressBarEl = document.querySelector<HTMLElement>("#progress-bar")!;
const progressFillEl = document.querySelector<HTMLElement>("#progress-fill")!;
const codeView = document.querySelector<HTMLElement>("#code-view")!;
const codeViewContent = document.querySelector<HTMLElement>("#code-view-content")!;
const stackList = document.querySelector<HTMLUListElement>("#stack-list")!;
const tablesEl = document.querySelector<HTMLDivElement>("#tables")!;
const ioEl = document.querySelector<HTMLElement>("#io")!;
const stdoutEl = document.querySelector<HTMLPreElement>("#stdout")!;
const predictHint = document.querySelector<HTMLElement>("#predict-hint")!;
const announceEl = document.querySelector<HTMLElement>("#announce")!;

const callTooltip = document.createElement("div");
callTooltip.className = "game-call-tooltip";
callTooltip.hidden = true;
callTooltip.setAttribute("role", "tooltip");
document.body.appendChild(callTooltip);

const mistakesPanel = document.createElement("div");
mistakesPanel.className = "mistakes-panel";
mistakesPanel.id = "mistakes-panel";
mistakesPanel.hidden = true;
mistakesPanel.setAttribute("role", "dialog");
mistakesPanel.setAttribute("aria-label", "Mistakes");
document.body.appendChild(mistakesPanel);

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
let difficulty: Difficulty = loadDifficulty();
/** Last dropdown difficulty — restored when leaving the tutorial link session. */
let selectableDifficulty: "easy" | "medium" | "hard" = loadDifficulty();
let selectedTemplate: ProblemTemplate = GAME_PROBLEMS.find(
  (item) => item.id !== TUTORIAL_PROBLEM_ID,
) ?? GAME_PROBLEMS[0]!;
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
type MistakeRecord = { line: number; message: string };
let mistakes: MistakeRecord[] = [];
let mistakesPanelPinned = false;
/** Mistakes since the last successful step — drives progressive hints. */
let stepMistakeCount = 0;
let pending: PendingPrediction | null = null;
let stagedChanges: Array<{ name: string; value: string }> = [];
let lineErrorTimer: number | null = null;
let progressToneTimer: number | null = null;
let successFxTimer: number | null = null;
let celebrationTimer: number | null = null;
/** Guards win celebration so re-renders do not retrigger confetti. */
let celebrationPlayed = false;
let celebrating = false;
/** Tips revealed for the open popover session (Medium). */
let revealedTips = new Set<TipId>();
/** Expected return repr used to rebuild Easy multi-slot returns. */
let pendingReturnExpected = "";

const SUCCESS_FX_MS = 850;
const ERROR_FX_MS = 900;
const CELEBRATION_MS = 2800;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function replayAnimationClass(el: HTMLElement, className: string): void {
  el.classList.remove(className);
  // Force reflow so repeated wrong answers retrigger the same animation.
  void el.offsetWidth;
  el.classList.add(className);
}

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

function announce(text: string): void {
  announceEl.textContent = text;
}

function pulseProgressTone(tone: "success" | "error"): void {
  progressEl.classList.remove("is-success", "is-error");
  if (progressToneTimer != null) {
    window.clearTimeout(progressToneTimer);
    progressToneTimer = null;
  }
  // Force reflow so repeated answers retrigger the same glow.
  void progressEl.offsetWidth;
  progressEl.classList.add(tone === "success" ? "is-success" : "is-error");
  progressToneTimer = window.setTimeout(() => {
    progressEl.classList.remove("is-success", "is-error");
    progressToneTimer = null;
  }, tone === "success" ? SUCCESS_FX_MS : ERROR_FX_MS);
}

function clearWinState(): void {
  celebrationPlayed = false;
  celebrating = false;
  if (celebrationTimer != null) {
    window.clearTimeout(celebrationTimer);
    celebrationTimer = null;
  }
  document.body.classList.remove("game-won");
  boardEl.classList.remove("is-celebrating");
  boardEl.removeAttribute("aria-busy");
  boardEl.inert = false;
}

function fireWinConfetti(): void {
  if (prefersReducedMotion()) return;
  const colors = ["#0b8f7f", "#2a9d4a", "#c47a00", "#7ef0d8", "#d64545"];
  confetti({
    particleCount: 110,
    spread: 70,
    startVelocity: 38,
    origin: { y: 0.62 },
    colors,
  });
  window.setTimeout(() => {
    confetti({
      particleCount: 55,
      spread: 95,
      startVelocity: 28,
      origin: { y: 0.7 },
      colors,
    });
  }, 280);
}

function celebrateWin(): void {
  if (celebrationPlayed) return;
  celebrationPlayed = true;
  celebrating = true;
  document.body.classList.add("game-won");
  boardEl.classList.add("is-celebrating");
  boardEl.setAttribute("aria-busy", "true");
  boardEl.inert = true;
  fireWinConfetti();
  if (celebrationTimer != null) window.clearTimeout(celebrationTimer);
  celebrationTimer = window.setTimeout(() => {
    celebrating = false;
    boardEl.classList.remove("is-celebrating");
    boardEl.removeAttribute("aria-busy");
    boardEl.inert = false;
    celebrationTimer = null;
  }, CELEBRATION_MS);
}

function applySuccessFlourish(): void {
  if (successFxTimer != null) {
    window.clearTimeout(successFxTimer);
    successFxTimer = null;
  }
  const mark = () => {
    const line = codeViewContent.querySelector<HTMLElement>(".code-line.current-line");
    line?.classList.add("fx-success-line");
    const stack = stackList.querySelector<HTMLElement>("li.current");
    stack?.classList.add("fx-success-stack");
    const table = tablesEl.querySelector<HTMLElement>(".trace-table.active");
    table?.classList.add("fx-success-table");
    for (const cell of tablesEl.querySelectorAll<HTMLElement>("td.current-cell")) {
      cell.classList.add("fx-success-cell");
    }
    const current = currentEntry();
    if (current?.gameEvent === "output") {
      ioEl.classList.add("fx-success-io");
    }
    successFxTimer = window.setTimeout(() => {
      line?.classList.remove("fx-success-line");
      stack?.classList.remove("fx-success-stack");
      table?.classList.remove("fx-success-table");
      ioEl.classList.remove("fx-success-io");
      for (const cell of tablesEl.querySelectorAll(".fx-success-cell")) {
        cell.classList.remove("fx-success-cell");
      }
      successFxTimer = null;
    }, SUCCESS_FX_MS);
  };
  requestAnimationFrame(() => requestAnimationFrame(mark));
}

function shakeErrorFields(root: ParentNode = popover): void {
  const targets = root.querySelectorAll<HTMLElement>(
    ".field-error, input.field-error, .change-row.field-error",
  );
  for (const el of targets) {
    if (prefersReducedMotion()) continue;
    replayAnimationClass(el, "fx-error-shake");
  }
}

function gameFinished(): boolean {
  return timeline.length > 0 && stepIndex >= timeline.length - 1;
}

function canPredict(): boolean {
  return timeline.length > 0 && !gameFinished() && !running && !celebrating;
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

function catalogProblems(): ProblemTemplate[] {
  return GAME_PROBLEMS.filter((item) => item.id !== TUTORIAL_PROBLEM_ID);
}

function tutorialTemplate(): ProblemTemplate | undefined {
  return GAME_PROBLEMS.find((item) => item.id === TUTORIAL_PROBLEM_ID);
}

function sizeSelectToLongestOption(select: HTMLSelectElement): void {
  const styles = getComputedStyle(select);
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:absolute",
    "visibility:hidden",
    "pointer-events:none",
    "white-space:nowrap",
    `font:${styles.font}`,
    `letter-spacing:${styles.letterSpacing}`,
  ].join(";");
  document.body.appendChild(probe);

  let textWidth = 0;
  for (const option of Array.from(select.options)) {
    probe.textContent = option.textContent ?? "";
    textWidth = Math.max(textWidth, probe.offsetWidth);
  }
  probe.remove();

  const padLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const padRight = Number.parseFloat(styles.paddingRight) || 0;
  const borderLeft = Number.parseFloat(styles.borderLeftWidth) || 0;
  const borderRight = Number.parseFloat(styles.borderRightWidth) || 0;
  // border-box width must leave room past the label: native selects often
  // paint selected text into the padding where the custom chevron sits.
  const labelClearance = 10;
  select.style.width = `${Math.ceil(
    textWidth +
      labelClearance +
      padLeft +
      padRight +
      borderLeft +
      borderRight,
  )}px`;
}

function syncProblemPicker(): void {
  const catalog = catalogProblems();
  problemSelect.replaceChildren();
  for (const item of catalog) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    problemSelect.appendChild(option);
  }
  selectedTemplate =
    catalog.find((item) => item.id === problemSelect.value) ?? catalog[0]!;
  if (selectedTemplate) {
    problemSelect.value = selectedTemplate.id;
    problemDesc.textContent = selectedTemplate.description;
  }
  sizeSelectToLongestOption(problemSelect);
}

function fillDifficultySelect(select: HTMLSelectElement): void {
  select.replaceChildren();
  for (const level of SELECTABLE_DIFFICULTIES) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = DIFFICULTY_LABELS[level];
    select.appendChild(option);
  }
  select.value = selectableDifficulty;
  sizeSelectToLongestOption(select);
}

function syncDifficultySelects(): void {
  difficultySelect.value = selectableDifficulty;
  difficultySelectBoard.value = selectableDifficulty;
}

function syncTutorialChrome(): void {
  const tutorial = isTutorial(difficulty);
  tutorialBadge.hidden = !tutorial;
  toolbarDifficultyWrap.hidden = tutorial;
  tutorialLink.setAttribute("aria-disabled", running && tutorial ? "true" : "false");
}

function setDifficulty(next: Difficulty): void {
  if (difficulty === next) return;
  difficulty = next;
  if (next !== "tutorial") {
    selectableDifficulty = next;
    saveDifficulty(next);
  }
  syncDifficultySelects();
  syncTutorialChrome();
  if (
    pending?.kind === "call" &&
    (assistsLikeEasy(difficulty) || difficulty === "medium") &&
    isUpcomingCallTo(pending.functionName) &&
    expectedCallParamNames(pending.functionName).length === 0
  ) {
    const keep = pending;
    hidePopover();
    void submitZeroArgCall(keep);
    return;
  }
  if (pending && (pending.kind === "call" || pending.kind === "return")) {
    const keep = pending;
    buildPopover(keep);
  } else if (pending) {
    revealedTips = new Set(
      initialTipsForPopover(
        popoverKindOf(pending.kind),
        difficulty,
        expectedValuesForPending(pending),
      ),
    );
    renderPopoverTips();
  }
  if (!boardEl.hidden) renderAll();
}

function exitTutorialDifficulty(): void {
  if (!isTutorial(difficulty)) return;
  difficulty = selectableDifficulty;
  syncDifficultySelects();
  syncTutorialChrome();
}

/**
 * Next action the player should predict. Skips empty line-advances that only
 * exist so a following call/return/output can be entered as a combo.
 */
function nextExpectedKind(): PredictionKind | null {
  const current = currentEntry();
  let index = stepIndex + 1;
  let from = current;
  if (!from) return null;
  const byId = tablesById();

  while (index < timeline.length) {
    const to = timeline[index];
    if (!to || !from) return null;
    const kind = classifyTransition(from, to);
    if (kind === "call" || kind === "return" || kind === "output") return kind;
    if (kind === "advance") {
      const expected = expectedPrediction(from, to, byId);
      if (
        expected.kind === "advance" &&
        Object.keys(expected.changes).length > 0
      ) {
        return "advance";
      }
      // Empty advance — keep looking for the meaningful next action.
      from = to;
      index += 1;
      continue;
    }
    return kind;
  }
  return null;
}

/** True when the next step (or advance-then-call) is a call to this function. */
function isUpcomingCallTo(functionName: string): boolean {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return false;
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);
  if (nextKind === "call") {
    const expected = expectedPrediction(current, next, byId);
    return expected.kind === "call" && expected.functionName === functionName;
  }
  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "call"
  ) {
    const expected = expectedPrediction(next, after, byId);
    return expected.kind === "call" && expected.functionName === functionName;
  }
  return false;
}

function expectedCallParamNames(functionName: string): string[] {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return [];
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);
  if (nextKind === "call") {
    const expected = expectedPrediction(current, next, byId);
    if (expected.kind === "call" && expected.functionName === functionName) {
      return Object.keys(expected.params);
    }
    return [];
  }
  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "call"
  ) {
    const expected = expectedPrediction(next, after, byId);
    if (expected.kind === "call" && expected.functionName === functionName) {
      return Object.keys(expected.params);
    }
    return [];
  }
  return [];
}

function expectedReturnValueRepr(): string {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  const third = timeline[stepIndex + 3];
  if (!current || !next) return "None";
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);
  if (nextKind === "return") {
    const expected = expectedPrediction(current, next, byId);
    if (expected.kind === "return") return expected.returnValue;
  }
  // Combo paths mirror submitReturnPrediction (advance/for-exit then return).
  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "return"
  ) {
    const expected = expectedPrediction(next, after, byId);
    if (expected.kind === "return") return expected.returnValue;
  }
  if (
    nextKind === "advance" &&
    after &&
    third &&
    classifyTransition(next, after) === "advance" &&
    classifyTransition(after, third) === "return"
  ) {
    const expected = expectedPrediction(after, third, byId);
    if (expected.kind === "return") return expected.returnValue;
  }
  return "None";
}

/** Expected stdout chunk for the upcoming output step (direct or advance+output). */
function expectedOutputText(): string {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return "";
  const byId = tablesById();
  const nextKind = classifyTransition(current, next);
  if (nextKind === "output") {
    const expected = expectedPrediction(current, next, byId);
    if (expected.kind === "output") return expected.output;
  }
  if (
    nextKind === "advance" &&
    after &&
    classifyTransition(next, after) === "output"
  ) {
    const expected = expectedPrediction(next, after, byId);
    if (expected.kind === "output") return expected.output;
  }
  return "";
}

/** True when graded output has an embedded newline (trailing print \\n ignored). */
function outputAnswerIsMultiline(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized.includes("\n");
}

function popoverKindOf(pendingKind: PendingPrediction["kind"]): PopoverKind {
  return pendingKind;
}

function renderPopoverTips(): void {
  const list = popover.querySelector(".predict-tips");
  if (!list || !pending) return;
  const kind = popoverKindOf(pending.kind);
  const tips = tipsForPopover(kind, difficulty, revealedTips);
  const progressive = progressiveAnswerHints(
    difficulty,
    stepMistakeCount,
    progressiveHintContextForPending() ?? { kind },
  );
  list.replaceChildren();
  if (tips.length === 0 && progressive.length === 0) {
    list.setAttribute("hidden", "");
    return;
  }
  list.removeAttribute("hidden");
  for (const id of tips) {
    const item = document.createElement("p");
    item.className = "predict-tip";
    item.textContent = tipText(id);
    list.appendChild(item);
  }
  for (const text of progressive) {
    const item = document.createElement("p");
    item.className = "predict-tip predict-tip-progressive";
    item.textContent = text;
    list.appendChild(item);
  }
}

function progressiveHintContextForPending(): ProgressiveHintContext | null {
  if (!pending) return null;
  const current = currentEntry();
  const step = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !step) return { kind: popoverKindOf(pending.kind) };
  const byId = tablesById();

  if (pending.kind === "assign") {
    if (classifyTransition(current, step) !== "advance") {
      return { kind: "assign", assignName: pending.name };
    }
    const expected = expectedPrediction(current, step, byId);
    if (expected.kind !== "advance") {
      return { kind: "assign", assignName: pending.name };
    }
    const value = expected.changes[pending.name];
    return {
      kind: "assign",
      assignName: pending.name,
      assignValue: value,
    };
  }

  if (pending.kind === "call") {
    const context: ProgressiveHintContext = {
      kind: "call",
      functionName: pending.functionName,
    };
    if (!isUpcomingCallTo(pending.functionName)) return context;
    const nextKind = classifyTransition(current, step);
    let expected =
      nextKind === "call"
        ? expectedPrediction(current, step, byId)
        : null;
    if (
      !expected &&
      nextKind === "advance" &&
      after &&
      classifyTransition(step, after) === "call"
    ) {
      expected = expectedPrediction(step, after, byId);
    }
    if (expected?.kind === "call") {
      context.callParams = expected.params;
      context.functionName = expected.functionName;
    }
    return context;
  }

  if (pending.kind === "return") {
    return {
      kind: "return",
      returnValue: expectedReturnValueRepr(),
    };
  }

  return {
    kind: "output",
    output: expectedOutputText(),
  };
}

function revealTipsFromFeedback(
  kind: PopoverKind,
  feedback: FieldFeedback[],
  context: TipGuessContext = {},
): void {
  const toReveal = tipsToRevealOnFeedback(kind, feedback, context, difficulty);
  for (const id of toReveal) revealedTips.add(id);
  renderPopoverTips();
}

/** Expected value reprs for tip gating (e.g. whether a string is in the answer). */
function expectedValuesForPending(next: PendingPrediction): string[] {
  const current = currentEntry();
  const step = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !step) return [];
  const byId = tablesById();

  if (next.kind === "assign") {
    if (classifyTransition(current, step) !== "advance") return [];
    const expected = expectedPrediction(current, step, byId);
    if (expected.kind !== "advance") return [];
    const value = expected.changes[next.name];
    return value != null ? [value] : Object.values(expected.changes);
  }

  if (next.kind === "call") {
    const nextKind = classifyTransition(current, step);
    if (nextKind === "call") {
      const expected = expectedPrediction(current, step, byId);
      if (expected.kind === "call") return Object.values(expected.params);
    }
    if (
      nextKind === "advance" &&
      after &&
      classifyTransition(step, after) === "call"
    ) {
      const expected = expectedPrediction(step, after, byId);
      if (expected.kind === "call") return Object.values(expected.params);
    }
    return [];
  }

  if (next.kind === "return") {
    return [expectedReturnValueRepr()];
  }

  return [];
}

function tipContextFromGuess(
  guess: PredictionGuess,
  expected: ReturnType<typeof expectedPrediction>,
): TipGuessContext {
  if (guess.kind === "call" && expected.kind === "call") {
    return {
      values: guess.params.map((row) => row.value),
      expectedValues: Object.values(expected.params),
    };
  }
  if (guess.kind === "return" && expected.kind === "return") {
    return {
      values: [guess.returnValue],
      expectedValues: [expected.returnValue],
    };
  }
  if (guess.kind === "output" && expected.kind === "output") {
    return {
      values: [guess.output],
      expectedValues: [expected.output],
    };
  }
  if (guess.kind === "advance" && expected.kind === "advance") {
    return {
      values: guess.changes.map((row) => row.value),
      expectedValues: guess.changes.map(
        (row) => expected.changes[row.name.trim()] ?? "",
      ),
    };
  }
  return {};
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

type AssignableName = {
  name: string;
  nameStart: number;
  nameEnd: number;
};

/** Parse comma-separated simple names (e.g. `x, y`) into name spans. */
function parseNameList(listStart: number, listText: string): AssignableName[] {
  const names: AssignableName[] = [];
  const pattern = /[A-Za-z_]\w*/g;
  for (const match of listText.matchAll(pattern)) {
    const name = match[0]!;
    const nameStart = listStart + (match.index ?? 0);
    names.push({ name, nameStart, nameEnd: nameStart + name.length });
  }
  return names;
}

/**
 * Names on the left of `=` / augmented assign, or the `for` target list.
 * Supports multi-target forms like `vx, vy = …` and `for a, b in …`.
 */
function matchAssignableNames(text: string): AssignableName[] {
  const assign = text.match(
    /^(\s*)([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:\+=|-=|\*=|\/=|\/\/=|%=|\*\*=|&=|\|=|\^=|>>=|<<=|@=|=(?!=))/,
  );
  if (assign) {
    const indent = assign[1] ?? "";
    const listText = assign[2]!;
    return parseNameList(indent.length, listText);
  }
  const forLoop = text.match(
    /^(\s*)(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/,
  );
  if (forLoop) {
    const listText = forLoop[2]!;
    const listStart = text.indexOf(listText, (forLoop[1] ?? "").length);
    if (listStart < 0) return [];
    return parseNameList(listStart, listText);
  }
  return [];
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
    const lhsNames = matchAssignableNames(displayText);
    let contentStart = 0;
    if (lhsNames.length > 0 && interactive) {
      for (const lhs of lhsNames) {
        if (lhs.nameStart > contentStart) {
          textEl.append(displayText.slice(contentStart, lhs.nameStart));
        }
        const assign = document.createElement("span");
        assign.className = "predict-assign";
        assign.dataset.predict = "assign";
        assign.dataset.varName = lhs.name;
        assign.textContent = lhs.name;
        textEl.appendChild(assign);
        contentStart = lhs.nameEnd;
      }
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
              applyTutorialGuidance();
              return;
            }
            const check = await checkStagedAssignValue(name, text);
            if (!check.ok) {
              input.classList.add("field-error");
              input.title = check.message;
              if (!prefersReducedMotion()) {
                replayAnimationClass(input, "fx-error-shake");
              }
              announce(check.message);
              recordFailedAttempt(check.message);
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
            applyTutorialGuidance();
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
          applyTutorialGuidance();
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
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const mistakeCount = mistakes.length;
  progressLabelEl.textContent = `Step ${done} / ${total}`;
  progressMistakesEl.hidden = mistakeCount === 0;
  progressMistakesEl.textContent =
    mistakeCount === 1 ? "1 mistake" : `${mistakeCount} mistakes`;
  progressFillEl.style.width = `${pct}%`;
  boardEl.dataset.progress = String(pct);
  progressBarEl.setAttribute("aria-valuemin", "0");
  progressBarEl.setAttribute("aria-valuemax", String(total));
  progressBarEl.setAttribute("aria-valuenow", String(done));
  const valueText =
    mistakeCount === 0
      ? `Step ${done} of ${total}`
      : `Step ${done} of ${total}, ${mistakeCount} ${mistakeCount === 1 ? "mistake" : "mistakes"}`;
  progressBarEl.setAttribute("aria-valuetext", valueText);
  if (mistakeCount === 0) {
    hideMistakesPanel(true);
  } else if (mistakesPanelPinned || !mistakesPanel.hidden) {
    renderMistakesPanelContents();
    positionMistakesPanel();
  }
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
      el.classList.remove("field-error", "field-warning", "fx-error-shake");
    });
  const list = popover.querySelector(".popover-feedback");
  if (list) list.replaceChildren();
}

function showPopoverFeedback(
  items: FieldFeedback[],
  tipContext: TipGuessContext = {},
): void {
  clearPopoverFeedback();
  const list = popover.querySelector(".popover-feedback");
  const hasError = items.some((item) => item.level === "error");
  if (!list) {
    const detail = items[0]?.message;
    if (detail) {
      announce(detail);
    }
    return;
  }
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
  if (hasError) {
    shakeErrorFields();
  }
  if (pending) {
    const needsQuotes = items.some((item) =>
      item.message.toLowerCase().includes("quotes"),
    );
    const notLiteral = items.some((item) =>
      item.message.toLowerCase().includes("not a valid python literal"),
    );
    revealTipsFromFeedback(popoverKindOf(pending.kind), items, {
      ...tipContext,
      needsQuotes: tipContext.needsQuotes ?? needsQuotes,
      notLiteral: tipContext.notLiteral ?? notLiteral,
    });
  }
}

function hidePopover(): void {
  pending = null;
  pendingReturnExpected = "";
  revealedTips = new Set();
  popover.hidden = true;
  popover.replaceChildren();
}

function flashLineError(line: number, message: string): void {
  const lineEl = codeViewContent.querySelector<HTMLElement>(
    `.code-line[data-line="${line}"]`,
  );
  if (lineEl) {
    if (lineErrorTimer != null) window.clearTimeout(lineErrorTimer);
    replayAnimationClass(lineEl, "predict-line-error");
    lineErrorTimer = window.setTimeout(() => {
      lineEl.classList.remove("predict-line-error");
      lineErrorTimer = null;
    }, ERROR_FX_MS);
  }
  announce(message);
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
  const kind = current && next ? classifyTransition(current, next) : null;
  if (!current || !next || kind !== "advance") {
    return {
      ok: false,
      message: kind
        ? formatNoAssignNeeded(kind, difficulty)
        : "No variable update is needed for the next step",
    };
  }
  const expected = expectedPrediction(current, next, tablesById());
  if (expected.kind !== "advance") {
    return {
      ok: false,
      message: formatNoAssignNeeded(expected.kind, difficulty),
    };
  }
  const expectedValue = expected.changes[name];
  if (expectedValue == null) {
    return {
      ok: false,
      message: formatWrongAssignTarget(name, expected.changes, difficulty),
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

function buildCallParamRows(
  rows: HTMLElement,
  functionName: string,
): void {
  const paramNames = expectedCallParamNames(functionName);
  const scaffold = callParamScaffold(difficulty, paramNames);

  const reindex = () => {
    [...rows.children].forEach((child, i) => {
      const row = child as HTMLElement;
      row.dataset.field = `param:${i}`;
      const nameInput = row.querySelector<HTMLInputElement>(
        'input[data-role="param-name"]',
      );
      const valInput = row.querySelector<HTMLInputElement>(
        'input[data-role="param-value"]',
      );
      if (nameInput) nameInput.name = `param-name-${i}`;
      if (valInput) {
        valInput.name = `param-value-${i}`;
        valInput.dataset.field = `param:${i}:value`;
      }
    });
  };

  const appendFixedRow = (name: string, lockedName: boolean) => {
    const index = rows.children.length;
    const row = document.createElement("div");
    row.className = "param-row param-row-fixed param-row-solid";
    row.dataset.field = `param:${index}`;
    if (lockedName) {
      const label = document.createElement("span");
      label.className = "param-name-locked";
      label.textContent = name;
      row.dataset.paramName = name;
      const valField = valueInput(
        `param-value-${index}`,
        `param:${index}:value`,
      );
      valField.dataset.role = "param-value";
      valField.placeholder = "value";
      row.append(label, valField);
    } else {
      const nameField = document.createElement("input");
      nameField.type = "text";
      nameField.name = `param-name-${index}`;
      nameField.dataset.role = "param-name";
      nameField.placeholder = "parameter";
      nameField.autocomplete = "off";
      nameField.spellcheck = false;
      const valField = valueInput(
        `param-value-${index}`,
        `param:${index}:value`,
      );
      valField.dataset.role = "param-value";
      valField.placeholder = "value";
      row.append(nameField, valField);
    }
    rows.appendChild(row);
    reindex();
  };

  if (scaffold.mode === "named-locked") {
    for (const name of scaffold.names) appendFixedRow(name, true);
    return;
  }

  if (scaffold.mode === "fixed-named") {
    for (let i = 0; i < scaffold.rowCount; i++) appendFixedRow("", false);
    return;
  }

  const rowHasContent = (row: HTMLElement) =>
    [...row.querySelectorAll<HTMLInputElement>('input[type="text"]')].some(
      (input) => input.value.trim(),
    );

  const addGhostRow = () => {
    const index = rows.children.length;
    const row = document.createElement("div");
    row.className = "param-row param-row-ghost";
    row.dataset.field = `param:${index}`;
    const nameField = document.createElement("input");
    nameField.type = "text";
    nameField.name = `param-name-${index}`;
    nameField.dataset.role = "param-name";
    nameField.placeholder = "parameter";
    nameField.autocomplete = "off";
    nameField.spellcheck = false;
    const valField = valueInput(
      `param-value-${index}`,
      `param:${index}:value`,
    );
    valField.dataset.role = "param-value";
    valField.placeholder = "value";
    const onEdit = () => {
      const filled = rowHasContent(row);
      row.classList.toggle("param-row-ghost", !filled);
      row.classList.toggle("param-row-solid", filled);
      const last = rows.lastElementChild as HTMLElement | null;
      if (last && rowHasContent(last)) addGhostRow();
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

  addGhostRow();
}

function buildReturnFields(fields: HTMLElement): void {
  pendingReturnExpected = expectedReturnValueRepr();
  if (!assistsLikeEasy(difficulty)) {
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = "returnValue";
    const input = valueInput("returnValue", "returnValue");
    input.placeholder = "None if empty";
    row.append(input);
    fields.appendChild(row);
    return;
  }

  const slots = splitReturnValueSlots(pendingReturnExpected);
  const slotCount = Math.max(slots.length, 1);
  const wrap = document.createElement("div");
  wrap.className = "return-slots";
  wrap.dataset.field = "returnValue";
  for (let i = 0; i < slotCount; i++) {
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = `returnValue:${i}`;
    const input = valueInput(`returnValue-${i}`, `returnValue:${i}`);
    input.dataset.role = "return-slot";
    input.placeholder = slotCount === 1 ? "None if empty" : `value ${i + 1}`;
    row.append(input);
    wrap.appendChild(row);
  }
  fields.appendChild(wrap);
}

function readReturnValueFromPopover(): string {
  if (assistsLikeEasy(difficulty)) {
    const slots = [
      ...popover.querySelectorAll<HTMLInputElement>(
        'input[data-role="return-slot"]',
      ),
    ].map((input) => input.value);
    if (slots.every((value) => !value.trim())) return "";
    return joinReturnValueSlots(slots, pendingReturnExpected);
  }
  return (
    popover.querySelector<HTMLInputElement>('input[name="returnValue"]')
      ?.value ?? ""
  );
}

function buildPopover(next: PendingPrediction): void {
  pending = next;
  revealedTips = new Set(
    initialTipsForPopover(
      popoverKindOf(next.kind),
      difficulty,
      expectedValuesForPending(next),
    ),
  );
  hideCallTooltip();
  popover.replaceChildren();

  const form = document.createElement("form");
  form.className = "predict-popover-form";

  const description = document.createElement("p");
  description.className = "predict-popover-desc";

  const fields = document.createElement("div");
  fields.className = "predict-popover-fields";

  const tips = document.createElement("div");
  tips.className = "predict-tips";
  tips.setAttribute("hidden", "");

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
    buildCallParamRows(rows, next.functionName);
    fields.appendChild(rows);
  } else if (next.kind === "return") {
    description.textContent = "Return";
    buildReturnFields(fields);
  } else {
    description.textContent = "Produce output";
    const row = document.createElement("div");
    row.className = "field";
    row.dataset.field = "output";
    const multiline = outputAnswerIsMultiline(expectedOutputText());
    if (multiline) {
      const textarea = document.createElement("textarea");
      textarea.name = "output";
      textarea.rows = 3;
      textarea.placeholder = "Exact output";
      textarea.spellcheck = false;
      textarea.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        void submitPending();
      });
      row.append(textarea);
      submit.title = "Check prediction (Ctrl+Enter)";
      submit.setAttribute(
        "aria-label",
        "Check prediction (Control Enter)",
      );
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.name = "output";
      input.placeholder = "Exact output";
      input.autocomplete = "off";
      input.spellcheck = false;
      row.append(input);
    }
    fields.appendChild(row);
  }

  form.append(description, fields, tips, actions, feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitPending();
  });
  popover.appendChild(form);
  enablePopoverDrag(description);
  positionPopover(next.anchor);
  renderPopoverTips();
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
        const locked = row.dataset.paramName;
        const nameInput = row.querySelector<HTMLInputElement>(
          'input[data-role="param-name"]',
        );
        const valueInputEl = row.querySelector<HTMLInputElement>(
          'input[data-role="param-value"]',
        );
        return {
          name: locked ?? nameInput?.value ?? "",
          value: valueInputEl?.value ?? "",
        };
      })
      .filter((row) => row.name.trim() || row.value.trim());
    return { kind: "call", line: pending.line, params };
  }
  if (pending.kind === "return") {
    return {
      kind: "return",
      line: pending.line,
      returnValue: readReturnValueFromPopover(),
    };
  }
  const output =
    popover.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '[name="output"]',
    )?.value ?? "";
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
    pairs.push([expected.returnValue, guess.returnValue.trim() || "None"]);
  }
  await Promise.all(
    pairs.map(async ([a, b]) => {
      cache.set(keyFor(a, b), await valuesEqual(a, b));
    }),
  );
  return gradePrediction(
    expected,
    guess,
    (a, b) => cache.get(keyFor(a, b)) ?? a === b,
    difficulty,
  );
}

async function applySuccessfulGuesses(steps: number, message: string): Promise<void> {
  hidePopover();
  clearStagedChanges();
  stepIndex += steps;
  stepMistakeCount = 0;
  pulseProgressTone("success");
  announce(message);
  renderAll();
  if (!gameFinished()) applySuccessFlourish();
  await tryAutoAdvanceAfterCallOnlyLine();
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

/**
 * After the last call (or print output) on a line with no assignments, skip the
 * empty "click next line" advance.
 */
async function tryAutoAdvanceAfterCallOnlyLine(): Promise<boolean> {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next) return false;
  // Only fire once call/output work on this line is done — not after a normal
  // line click, which would otherwise chain through empty advances.
  if (current.kind !== "callReturn" && current.gameEvent !== "output") {
    return false;
  }
  if (classifyTransition(current, next) !== "advance") return false;
  const expected = expectedPrediction(current, next, tablesById());
  if (expected.kind !== "advance") return false;
  // Assignments after a call (e.g. y = foo()) still require staging.
  if (Object.keys(expected.changes).length > 0) return false;
  return tryAutoAdvance({
    message: "Correct. Advanced to the next line.",
  });
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
      recordFailedAttempt(
        "Advance to the call site first, or click the call on the next line",
      );
      showPopoverFeedback([
        {
          field: "params",
          message: "Advance to the call site first, or click the call on the next line",
          level: "error",
        },
      ]);
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
      recordFailedAttempt(advanceResult.feedback);
      showPopoverFeedback(
        advanceResult.feedback,
        tipContextFromGuess(
          stagedAdvanceGuess(
            advanceExpected.kind === "advance"
              ? advanceExpected.line
              : pending.siteLine,
          ),
          advanceExpected,
        ),
      );
      announce("Not quite — check values before the call.");
      return;
    }
    const callExpected = expectedPrediction(next, after, byId);
    const callResult = await evaluateGuess(callExpected, guess);
    if (!callResult.ok) {
      recordFailedAttempt(callResult.feedback);
      showPopoverFeedback(
        callResult.feedback,
        tipContextFromGuess(guess, callExpected),
      );
      announce("Not quite — check the call.");
      return;
    }
    await applySuccessfulGuesses(2, "Correct. Advanced and called.");
    return;
  }

  {
    const expectedKind = nextExpectedKind();
    const message = expectedKind
      ? formatKindMismatch(expectedKind, difficulty)
      : "Call is not the next step from here";
    recordFailedAttempt(message);
    showPopoverFeedback([
      {
        field: "params",
        message,
        level: "error",
      },
    ]);
  }
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
      recordFailedAttempt(advanceResult.feedback);
      showPopoverFeedback(advanceResult.feedback);
      announce("Not quite — check values before the output.");
      return;
    }
    const outputExpected = expectedPrediction(next, after, byId);
    const outputResult = await evaluateGuess(outputExpected, guess);
    if (!outputResult.ok) {
      recordFailedAttempt(outputResult.feedback);
      showPopoverFeedback(outputResult.feedback);
      announce("Not quite — check the output.");
      return;
    }
    await applySuccessfulGuesses(2, "Correct. Advanced and produced output.");
    return;
  }

  {
    const expectedKind = nextExpectedKind();
    const message = expectedKind
      ? formatKindMismatch(expectedKind, difficulty)
      : "Output is not the next step from here";
    recordFailedAttempt(message);
    showPopoverFeedback([
      {
        field: "output",
        message,
        level: "error",
      },
    ]);
  }
}

function feedbackSummary(feedback: FieldFeedback[]): string {
  const preferred = feedback.find((item) => item.level === "error") ?? feedback[0];
  return preferred?.message ?? "Incorrect prediction";
}

function clearMistakes(): void {
  mistakes = [];
  mistakesPanelPinned = false;
  stepMistakeCount = 0;
  hideMistakesPanel(true);
}

function renderMistakesPanelContents(): void {
  mistakesPanel.replaceChildren();
  const title = document.createElement("p");
  title.className = "mistakes-panel-title";
  title.textContent = mistakes.length === 1 ? "1 mistake" : `${mistakes.length} mistakes`;
  const list = document.createElement("ol");
  list.className = "mistakes-panel-list";
  for (const entry of mistakes) {
    const item = document.createElement("li");
    const line = document.createElement("span");
    line.className = "mistakes-panel-step";
    line.textContent = `Line ${entry.line}`;
    const message = document.createElement("span");
    message.className = "mistakes-panel-message";
    message.textContent = entry.message;
    item.append(line, message);
    list.appendChild(item);
  }
  mistakesPanel.append(title, list);
}

function positionMistakesPanel(): void {
  const anchorRect = progressMistakesEl.getBoundingClientRect();
  const panelRect = mistakesPanel.getBoundingClientRect();
  const gap = 6;
  const maxLeft = Math.max(gap, window.innerWidth - panelRect.width - gap);
  const left = Math.min(Math.max(gap, anchorRect.right - panelRect.width), maxLeft);
  let top = anchorRect.bottom + gap;
  if (top + panelRect.height > window.innerHeight - gap) {
    top = Math.max(gap, anchorRect.top - panelRect.height - gap);
  }
  mistakesPanel.style.left = `${left}px`;
  mistakesPanel.style.top = `${top}px`;
}

function showMistakesPanel(pinned = false): void {
  if (mistakes.length === 0) return;
  if (pinned) mistakesPanelPinned = true;
  renderMistakesPanelContents();
  mistakesPanel.hidden = false;
  positionMistakesPanel();
  // Reposition after layout with real size.
  positionMistakesPanel();
  progressMistakesEl.setAttribute("aria-expanded", "true");
}

function hideMistakesPanel(force = false): void {
  if (mistakesPanelPinned && !force) return;
  mistakesPanelPinned = false;
  mistakesPanel.hidden = true;
  progressMistakesEl.setAttribute("aria-expanded", "false");
}

function recordFailedAttempt(detail: string | FieldFeedback[] = "Incorrect prediction"): void {
  const message =
    typeof detail === "string" ? detail.trim() || "Incorrect prediction" : feedbackSummary(detail);
  const line = currentEntry()?.line ?? 1;
  mistakes.push({ line, message });
  stepMistakeCount += 1;
  pulseProgressTone("error");
  renderProgress();
  if (pending) renderPopoverTips();
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
    recordFailedAttempt(result.feedback);
    if (pending) {
      showPopoverFeedback(result.feedback, tipContextFromGuess(guess, expected));
    } else if (guess.kind === "advance") {
      const detail =
        result.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(guess.line, detail);
    }
    announce("Not quite — check the highlighted answers and try again.");
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
      recordFailedAttempt(forResult.feedback);
      showPopoverFeedback(forResult.feedback);
      announce("Not quite — check the loop exit / return prediction.");
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
      recordFailedAttempt(returnLineResult.feedback);
      showPopoverFeedback(returnLineResult.feedback);
      announce("Not quite — check the loop exit / return prediction.");
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
      recordFailedAttempt(returnResult.feedback);
      showPopoverFeedback(returnResult.feedback);
      announce("Not quite — check the return value.");
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
      recordFailedAttempt(advanceResult.feedback);
      showPopoverFeedback(advanceResult.feedback);
      announce("Not quite — check the advance/return prediction.");
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
      recordFailedAttempt(returnResult.feedback);
      showPopoverFeedback(returnResult.feedback);
      announce("Not quite — check the return value.");
      return;
    }

    await applySuccessfulGuesses(2, "Correct. Advanced and returned.");
    return;
  }

  {
    const expectedKind = nextExpectedKind();
    const message = expectedKind
      ? formatKindMismatch(expectedKind, difficulty)
      : "Return is not the next step from here";
    recordFailedAttempt(message);
    showPopoverFeedback([
      {
        field: "returnValue",
        message,
        level: "error",
      },
    ]);
  }
  announce("Not quite — return is not available for this step.");
}

async function submitPending(): Promise<void> {
  if (!pending) return;

  if (pending.kind === "assign") {
    const value =
      popover.querySelector<HTMLInputElement>('input[name="assignValue"]')
        ?.value ?? "";
    const warnings: FieldFeedback[] = [];
    const trimmed = value.trim();
    let needsQuotes = false;
    let notLiteral = false;
    if (!trimmed) {
      warnings.push({
        field: "assignValue",
        message: "Value is required",
        level: "error",
      });
    } else {
      const result = await validateLiteral(trimmed);
      if (!result.ok) {
        notLiteral = true;
        needsQuotes = true;
        warnings.push({
          field: "assignValue",
          message: "Not a valid Python literal (strings need quotes)",
          level: "warning",
        });
      }
    }
    if (warnings.length > 0) {
      showPopoverFeedback(warnings, {
        values: [trimmed],
        needsQuotes,
        notLiteral,
      });
      return;
    }

    const name = pending.name;
    const assignLine = pending.line;
    const valueCheck = await checkStagedAssignValue(name, trimmed);
    if (!valueCheck.ok) {
      recordFailedAttempt(valueCheck.message);
      const current = currentEntry();
      const next = timeline[stepIndex + 1];
      const expected =
        current && next
          ? expectedPrediction(current, next, tablesById())
          : null;
      showPopoverFeedback(
        [
          {
            field: "assignValue",
            message: valueCheck.message,
            level: "error",
          },
        ],
        {
          values: [trimmed],
          expectedValues:
            expected?.kind === "advance"
              ? Object.values(expected.changes)
              : undefined,
        },
      );
      announce("Not quite — check the value and try again.");
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
    applyTutorialGuidance();
    announce(
      `Staged ${name} = ${trimmed}. Click the next line to advance, or set another variable.`,
    );
    return;
  }

  if (pending.kind === "return") {
    const returnValue = readReturnValueFromPopover();
    const warnings: FieldFeedback[] = [];
    const trimmed = returnValue.trim() || "None";
    let needsQuotes = false;
    let notLiteral = false;
    if (returnValue.trim()) {
      const slotInputs = [
        ...popover.querySelectorAll<HTMLInputElement>(
          'input[data-role="return-slot"]',
        ),
      ];
      if (slotInputs.length > 0) {
        for (let i = 0; i < slotInputs.length; i++) {
          const slot = slotInputs[i]!.value.trim();
          if (!slot) continue;
          const result = await validateLiteral(slot);
          if (!result.ok) {
            notLiteral = true;
            needsQuotes = true;
            warnings.push({
              field: `returnValue:${i}`,
              message: "Not a valid Python literal (strings need quotes)",
              level: "warning",
            });
          }
        }
      } else {
        const result = await validateLiteral(trimmed);
        if (!result.ok) {
          notLiteral = true;
          needsQuotes = true;
          warnings.push({
            field: "returnValue",
            message: "Not a valid Python literal (strings need quotes)",
            level: "warning",
          });
        }
      }
    }
    if (warnings.length > 0) {
      showPopoverFeedback(warnings, {
        values: [returnValue],
        expectedValues: [pendingReturnExpected],
        needsQuotes,
        notLiteral,
      });
      return;
    }
    await submitReturnPrediction(trimmed, pending.keywordLine);
    return;
  }

  const guess = readGuessFromPopover();
  if (!guess) return;

  const precheck = await collectLiteralWarnings(guess);
  if (precheck.length > 0) {
    const values =
      guess.kind === "call"
        ? guess.params.map((row) => row.value)
        : guess.kind === "output"
          ? [guess.output]
          : guess.kind === "return"
            ? [guess.returnValue]
            : [];
    showPopoverFeedback(precheck, {
      values,
      needsQuotes: precheck.some((item) =>
        item.message.toLowerCase().includes("quotes"),
      ),
      notLiteral: precheck.some((item) =>
        item.message.toLowerCase().includes("not a valid python literal"),
      ),
    });
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

async function submitZeroArgCall(next: Extract<PendingPrediction, { kind: "call" }>): Promise<void> {
  pending = next;
  const before = stepIndex;
  await submitCallPrediction({
    kind: "call",
    line: next.line,
    params: [],
  });
  // No empty popover for zero-arg easy/medium calls — clear stale pending on failure.
  if (stepIndex === before) {
    pending = null;
  }
}

function openPrediction(next: PendingPrediction): void {
  if (!canPredict()) return;
  if (next.kind === "call") {
    const assisted =
      assistsLikeEasy(difficulty) || difficulty === "medium";
    if (assisted && !isUpcomingCallTo(next.functionName)) {
      buildPopover(next);
      const expectedKind = nextExpectedKind();
      const message = expectedKind
        ? formatKindMismatch(expectedKind, difficulty)
        : "Call is not the next step from here";
      recordFailedAttempt(message);
      showPopoverFeedback([
        {
          field: "params",
          message,
          level: "error",
        },
      ]);
      announce(message);
      return;
    }
    if (assisted && expectedCallParamNames(next.functionName).length === 0) {
      void submitZeroArgCall(next);
      return;
    }
  }
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
      recordFailedAttempt(forResult.feedback);
      const detail =
        forResult.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(line, detail);
      announce("Not quite — check the loop exit prediction.");
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
      recordFailedAttempt(afterResult.feedback);
      const detail =
        afterResult.feedback[0]?.message ??
        "Not quite — that is not the next step.";
      flashLineError(line, detail);
      announce("Not quite — check the loop exit prediction.");
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

const DEFAULT_PREDICT_HINT = "Predict each step in the code.";

function gamePageEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".game-page");
}

function clearTutorialTargets(): void {
  codeViewContent
    .querySelectorAll(
      ".tutorial-target, .tutorial-target-line, .tutorial-target-first",
    )
    .forEach((el) => {
      el.classList.remove(
        "tutorial-target",
        "tutorial-target-line",
        "tutorial-target-first",
      );
    });
  ioEl.classList.remove("tutorial-target", "tutorial-target-first");
  gamePageEl()?.classList.remove("tutorial-mode");
}

function markTutorialTargets(
  nodes: Iterable<Element | null | undefined>,
  options?: { firstStep?: boolean },
): void {
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    node.classList.add("tutorial-target");
    if (options?.firstStep) node.classList.add("tutorial-target-first");
  }
}

function highlightTutorialCall(
  functionName: string,
  options?: { firstStep?: boolean },
): void {
  const calls = [
    ...codeViewContent.querySelectorAll<HTMLElement>("[data-predict='call']"),
  ].filter((el) => el.dataset.functionName === functionName);
  const nonDef = calls.filter((el) => {
    const lineEl = el.closest<HTMLElement>(".code-line");
    const line = Number(lineEl?.dataset.line);
    const text = sourceLines[line - 1] ?? "";
    return !/^\s*(?:async\s+)?def\s/.test(text);
  });
  const targets = nonDef.length > 0 ? nonDef : calls;
  if (options?.firstStep) {
    for (const el of targets) {
      wrapTutorialCallWithParens(el);
    }
    return;
  }
  markTutorialTargets(targets, options);
}

/** Wrap `name` + following `()` so the first-step pulse covers `main()`. */
function wrapTutorialCallWithParens(el: HTMLElement): void {
  const parent = el.parentNode;
  if (!parent) {
    markTutorialTargets([el], { firstStep: true });
    return;
  }
  const wrap = document.createElement("span");
  wrap.className = "tutorial-target tutorial-target-first";
  wrap.dataset.predict = "call";
  wrap.dataset.functionName = el.dataset.functionName ?? "";
  parent.insertBefore(wrap, el);
  wrap.appendChild(el);

  const next = wrap.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE) {
    const text = next.textContent ?? "";
    const match = text.match(/^(\s*\(\s*\))/);
    if (match) {
      wrap.append(match[1]!);
      next.textContent = text.slice(match[1]!.length);
    }
  }
}

/**
 * If the next player action is a call (directly, or via an empty advance then
 * call), return that expected call prediction.
 */
function upcomingTutorialCall(): Extract<
  ReturnType<typeof expectedPrediction>,
  { kind: "call" }
> | null {
  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  const after = timeline[stepIndex + 2];
  if (!current || !next) return null;
  const byId = tablesById();
  const kind = classifyTransition(current, next);
  if (kind === "call") {
    const expected = expectedPrediction(current, next, byId);
    return expected.kind === "call" ? expected : null;
  }
  if (
    kind === "advance" &&
    after &&
    classifyTransition(next, after) === "call"
  ) {
    const advanceExpected = expectedPrediction(current, next, byId);
    if (
      advanceExpected.kind === "advance" &&
      Object.keys(advanceExpected.changes).length === 0
    ) {
      const callExpected = expectedPrediction(next, after, byId);
      if (callExpected.kind === "call") return callExpected;
    }
  }
  return null;
}

function formatTutorialCallHint(
  expected: Extract<ReturnType<typeof expectedPrediction>, { kind: "call" }>,
): string {
  const paramEntries = Object.entries(expected.params);
  if (paramEntries.length === 0) {
    return `<strong class="tutorial-next-label">Next:</strong> Click <code>${expected.functionName}()</code> to call it.`;
  }
  return `<strong class="tutorial-next-label">Next:</strong> Click <code>${expected.functionName}()</code> and enter ${paramEntries
    .map(([name, value]) => `<code>${name}=${value}</code>`)
    .join(", ")}.`;
}

function formatTutorialAssignHint(
  changes: Record<string, string>,
  needed: string[],
): string {
  const parts = needed.map((name) => {
    const value = changes[name];
    return value != null
      ? `<code>${name}</code> to <code>${value}</code>`
      : `<code>${name}</code>`;
  });
  if (parts.length === 1) {
    return `<strong class="tutorial-next-label">Next:</strong> Set ${parts[0]}. Click that variable on the left of <code>=</code>.`;
  }
  return `<strong class="tutorial-next-label">Next:</strong> Set ${parts.join(" and ")}. Click each variable on the left of <code>=</code>.`;
}

function applyTutorialGuidance(): void {
  clearTutorialTargets();
  if (!isTutorial(difficulty)) return;
  gamePageEl()?.classList.add("tutorial-mode");
  if (!canPredict()) return;

  const current = currentEntry();
  const next = timeline[stepIndex + 1];
  if (!current || !next) return;

  const upcomingCall = upcomingTutorialCall();
  // Starting the program: pulse main() even when an empty advance comes first.
  if (
    upcomingCall &&
    upcomingCall.functionName === "main" &&
    current.stack.length <= 1
  ) {
    predictHint.innerHTML =
      `<strong class="tutorial-next-label">Next:</strong> Click <code>main()</code> to call it and start the program.`;
    highlightTutorialCall("main", { firstStep: true });
    return;
  }

  // Empty advance-then-call: guide the call with explicit parameter values.
  if (upcomingCall) {
    predictHint.innerHTML = formatTutorialCallHint(upcomingCall);
    highlightTutorialCall(upcomingCall.functionName);
    return;
  }

  const kind = classifyTransition(current, next);
  const expected = expectedPrediction(current, next, tablesById());

  if (kind === "advance" && expected.kind === "advance") {
    const needed = Object.keys(expected.changes).filter(
      (name) => !stagedChanges.some((row) => row.name === name),
    );
    if (needed.length > 0) {
      predictHint.innerHTML = formatTutorialAssignHint(
        expected.changes,
        needed,
      );
      for (const name of needed) {
        markTutorialTargets(
          codeViewContent.querySelectorAll(
            `[data-predict='assign'][data-var-name="${CSS.escape(name)}"]`,
          ),
        );
      }
      return;
    }
    predictHint.innerHTML = `<strong class="tutorial-next-label">Next:</strong> Click line <code>${expected.line}</code> to advance.`;
    const lineEl = codeViewContent.querySelector(
      `.code-line[data-line="${expected.line}"]`,
    );
    lineEl?.classList.add("tutorial-target-line");
    return;
  }

  if (kind === "call" && expected.kind === "call") {
    predictHint.innerHTML = formatTutorialCallHint(expected);
    highlightTutorialCall(expected.functionName);
    return;
  }

  if (kind === "return") {
    const returnValue =
      expected.kind === "return"
        ? expected.returnValue
        : expectedReturnValueRepr();
    predictHint.innerHTML = `<strong class="tutorial-next-label">Next:</strong> Return <code>${returnValue}</code>. Click <code>return</code> or the highlighted call site and enter that value.`;
    markTutorialTargets(
      codeViewContent.querySelectorAll(
        "[data-predict='return'], .return-ready, .predict-return",
      ),
    );
    return;
  }

  if (kind === "output") {
    const output =
      expected.kind === "output" ? expected.output : expectedOutputText();
    const shown = output === "" ? "(empty)" : output;
    predictHint.innerHTML = `<strong class="tutorial-next-label">Next:</strong> Produce output <code>${shown}</code>. Click <code>print</code> or the Output box and enter that text.`;
    markTutorialTargets(
      codeViewContent.querySelectorAll("[data-predict='output']"),
    );
    ioEl.classList.add("tutorial-target");
  }
}

function renderPredictionPanel(): void {
  const finished = gameFinished();
  if (finished) {
    hidePopover();
    clearStagedChanges();
    clearTutorialTargets();
    predictHint.hidden = true;
    announce("Problem complete. You predicted every step.");
    celebrateWin();
    if (mistakes.length > 0) showMistakesPanel(true);
    return;
  }

  predictHint.hidden = false;
  if (timeline.length === 0) {
    predictHint.innerHTML = isTutorial(difficulty)
      ? "Tutorial mode highlights what to click next — assignments, calls, returns, and print."
      : DEFAULT_PREDICT_HINT;
  } else if (isTutorial(difficulty)) {
    // Hint text filled by applyTutorialGuidance.
    predictHint.textContent = "";
  } else if (nextReturnCallSiteTableId()) {
    predictHint.textContent =
      "Return next: click the highlighted call site (↩) and enter the return value.";
  } else {
    predictHint.textContent =
      "Click a variable, call, return, or print to predict the next step.";
  }
}

function renderAll(): void {
  renderCode();
  renderStackAndTables();
  renderIo();
  renderProgress();
  renderPredictionPanel();
  applyTutorialGuidance();
}

function showSetup(): void {
  setupEl.hidden = false;
  boardEl.hidden = true;
  tables = [];
  timeline = [];
  stepIndex = 0;
  clearMistakes();
  hidePopover();
  clearStagedChanges();
  clearTutorialTargets();
  exitTutorialDifficulty();
  clearWinState();
  predictHint.hidden = false;
  predictHint.innerHTML = DEFAULT_PREDICT_HINT;
  syncTutorialChrome();
  renderProgress();
}

function showBoard(): void {
  setupEl.hidden = true;
  boardEl.hidden = false;
  syncTutorialChrome();
}

problemSelect.addEventListener("change", () => {
  selectedTemplate =
    catalogProblems().find((item) => item.id === problemSelect.value) ??
    catalogProblems()[0]!;
  problemDesc.textContent = selectedTemplate.description;
});

function onDifficultySelectChange(event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  const next = select.value as "easy" | "medium" | "hard";
  setDifficulty(next);
}

difficultySelect.addEventListener("change", onDifficultySelectChange);
difficultySelectBoard.addEventListener("change", onDifficultySelectChange);

restartBtn.addEventListener("click", () => {
  showSetup();
  startBtn.disabled = !ready || running;
});

progressMistakesEl.addEventListener("click", (event) => {
  event.preventDefault();
  if (mistakes.length === 0) return;
  if (mistakesPanelPinned && !mistakesPanel.hidden) {
    hideMistakesPanel(true);
  } else {
    showMistakesPanel(true);
  }
});

progressMistakesEl.addEventListener("pointerenter", () => {
  if (mistakes.length === 0) return;
  showMistakesPanel();
});

progressMistakesEl.addEventListener("pointerleave", (event) => {
  if (
    event.relatedTarget instanceof Node &&
    mistakesPanel.contains(event.relatedTarget)
  ) {
    return;
  }
  hideMistakesPanel();
});

mistakesPanel.addEventListener("pointerleave", (event) => {
  if (
    event.relatedTarget instanceof Node &&
    progressMistakesEl.contains(event.relatedTarget)
  ) {
    return;
  }
  hideMistakesPanel();
});

document.addEventListener("pointerdown", (event) => {
  if (!mistakesPanelPinned || mistakesPanel.hidden) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (mistakesPanel.contains(target) || progressMistakesEl.contains(target)) {
    return;
  }
  hideMistakesPanel(true);
});

window.addEventListener("resize", () => {
  if (!mistakesPanel.hidden) positionMistakesPanel();
});

window.addEventListener("scroll", () => {
  if (!mistakesPanel.hidden) positionMistakesPanel();
}, true);

startBtn.addEventListener("click", () => {
  if (!ready || running) return;
  exitTutorialDifficulty();
  selectedTemplate =
    catalogProblems().find((item) => item.id === problemSelect.value) ??
    catalogProblems()[0]!;
  void startProblem(selectedTemplate);
});

tutorialLink.addEventListener("click", (event) => {
  event.preventDefault();
  if (!ready || running) return;
  const tutorial = tutorialTemplate();
  if (!tutorial) {
    announce("Tutorial problem is not available.");
    return;
  }
  setDifficulty("tutorial");
  void startProblem(tutorial);
});

async function startProblem(template: ProblemTemplate): Promise<void> {
  running = true;
  startBtn.disabled = true;
  clearWinState();
  showBoard();
  clearMistakes();
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
    renderAll();
    post({ type: "run", code: problem.code });
  } catch (err) {
    running = false;
    startBtn.disabled = !ready;
    showSetup();
    announce(err instanceof Error ? err.message : String(err));
  }
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  if (msg.type === "ready") {
    ready = true;
    running = false;
    startBtn.disabled = false;
    return;
  }
  if (msg.type === "error") {
    ready = false;
    running = false;
    startBtn.disabled = true;
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
      announce(msg.error);
    }
    hidePopover();
    clearStagedChanges();
    renderAll();
  }
};

worker.onerror = (event) => {
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
fillDifficultySelect(difficultySelect);
fillDifficultySelect(difficultySelectBoard);
syncDifficultySelects();
syncTutorialChrome();
showSetup();
void document.fonts.ready.then(() => {
  sizeSelectToLongestOption(problemSelect);
  sizeSelectToLongestOption(difficultySelect);
  sizeSelectToLongestOption(difficultySelectBoard);
});
post({ type: "init" });
