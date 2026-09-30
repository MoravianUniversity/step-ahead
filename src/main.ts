import "./styles.css";
import { SAMPLE_CODE } from "./sample";
import type {
  CallSite,
  MainToWorker,
  TableStyle,
  TimelineEntry,
  TraceStep,
  TraceTable,
  WorkerToMain,
} from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <div class="page">
    <header class="hero">
      <h1 class="brand">Auto Trace Table</h1>
    </header>

    <section class="workspace is-editing" id="workspace" aria-label="Code and results">
      <div class="editor-pane">
        <div class="toolbar">
          <label class="status" id="status">Loading Python…</label>
          <div class="toolbar-actions">
            <label class="style-setting">
              <span>Style</span>
              <select id="table-style">
                <option value="valueHistory" selected>Value history</option>
                <option value="changesOnly">Changes only</option>
                <option value="fullSnapshot">Full snapshot</option>
              </select>
            </label>
            <button type="button" id="edit" hidden>Edit</button>
            <button type="button" id="run" disabled>Run</button>
          </div>
        </div>
        <div class="code-edit" id="code-edit">
          <div class="code-edit-gutter" id="code-gutter" aria-hidden="true"></div>
          <textarea
            id="code"
            spellcheck="false"
            aria-label="Python source"
          ></textarea>
        </div>
        <pre id="code-view" class="code-view" aria-label="Python source playback" hidden><code id="code-view-content"></code></pre>
        <div class="playback" id="playback" hidden>
          <button type="button" id="step-reset" title="First step">⏮</button>
          <button type="button" id="step-prev" title="Previous step">◀</button>
          <span class="playback-meta" id="playback-meta">Step 0 / 0</span>
          <button type="button" id="step-next" title="Next step">▶</button>
          <button type="button" id="step-end" title="Skip to end">⏭</button>
          <button type="button" id="step-play" title="Play / pause">Play</button>
        </div>
      </div>

      <div class="output-pane" id="output-pane" hidden>
        <div id="io" class="io" hidden>
          <h2>Output</h2>
          <pre id="stdout"></pre>
          <pre id="error" class="error" hidden></pre>
        </div>
        <div class="tables-scroll">
          <div id="tables" class="tables"></div>
        </div>
      </div>
    </section>
  </div>
`;

const codeEl = document.querySelector<HTMLTextAreaElement>("#code")!;
const codeEdit = document.querySelector<HTMLDivElement>("#code-edit")!;
const codeGutter = document.querySelector<HTMLDivElement>("#code-gutter")!;
const codeView = document.querySelector<HTMLPreElement>("#code-view")!;
const codeViewContent = document.querySelector<HTMLElement>("#code-view-content")!;
const workspace = document.querySelector<HTMLElement>("#workspace")!;
const runBtn = document.querySelector<HTMLButtonElement>("#run")!;
const editBtn = document.querySelector<HTMLButtonElement>("#edit")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const outputPane = document.querySelector<HTMLDivElement>("#output-pane")!;
const tablesEl = document.querySelector<HTMLDivElement>("#tables")!;
const ioEl = document.querySelector<HTMLDivElement>("#io")!;
const stdoutEl = document.querySelector<HTMLPreElement>("#stdout")!;
const errorEl = document.querySelector<HTMLPreElement>("#error")!;
const styleSelect = document.querySelector<HTMLSelectElement>("#table-style")!;
const playbackEl = document.querySelector<HTMLDivElement>("#playback")!;
const stepResetBtn = document.querySelector<HTMLButtonElement>("#step-reset")!;
const stepPrevBtn = document.querySelector<HTMLButtonElement>("#step-prev")!;
const stepNextBtn = document.querySelector<HTMLButtonElement>("#step-next")!;
const stepEndBtn = document.querySelector<HTMLButtonElement>("#step-end")!;
const stepPlayBtn = document.querySelector<HTMLButtonElement>("#step-play")!;
const playbackMeta = document.querySelector<HTMLElement>("#playback-meta")!;

const callTooltip = document.createElement("div");
callTooltip.className = "call-site-tooltip";
callTooltip.hidden = true;
callTooltip.setAttribute("role", "tooltip");
document.body.appendChild(callTooltip);

codeEl.value = SAMPLE_CODE;

let tableStyle: TableStyle = "valueHistory";
let appMode: "edit" | "run" = "edit";
let sourceCode = SAMPLE_CODE;
let lastTables: TraceTable[] = [];
let lastTimeline: TimelineEntry[] = [];
let lastStdout = "";
let lastError: string | undefined;
/** Current timeline index in line-by-line mode; -1 = before first step. */
let playbackIndex = -1;
/** When true, code/table views may auto-scroll to the active step. */
let followPlaybackScroll = false;
let ready = false;
let running = false;
let playTimer: number | null = null;
let callTooltipHideTimer: number | null = null;

type CallSiteOccurrence = {
  table: TraceTable;
  startTimelineIndex: number;
  returned: boolean;
};

type CallSiteGroup = {
  key: string;
  site: CallSite;
  calls: CallSiteOccurrence[];
};

type CallSiteRange = {
  group: CallSiteGroup;
  start: number;
  end: number;
  children: CallSiteRange[];
};

type StackFrameDisplay = {
  tableId: string;
  label: string;
  line: number | null;
  current: boolean;
};

let visibleCallSiteGroups = new Map<string, CallSiteGroup>();

styleSelect.value = tableStyle;

const worker = new Worker(
  new URL("./worker/pyodideWorker.ts", import.meta.url),
  { type: "module" },
);

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function post(msg: MainToWorker): void {
  worker.postMessage(msg);
}

function stopPlayback(): void {
  if (playTimer != null) {
    window.clearInterval(playTimer);
    playTimer = null;
  }
  stepPlayBtn.textContent = "Play";
}

function formatCallLabel(table: TraceTable): string {
  if (table.functionName === "<module>") {
    return "module";
  }
  const args = (table.args ?? []).join(", ");
  return `${table.functionName}(${args})`;
}

function formatTableTitle(
  table: TraceTable,
  timelineIndex: number | null,
): string {
  let title = formatCallLabel(table);
  if (table.functionName === "<module>") {
    return title;
  }
  const returned =
    table.returnValue != null &&
    (timelineIndex == null ||
      (table.returnTimelineIndex != null &&
        timelineIndex >= table.returnTimelineIndex));
  if (returned) {
    title += ` → ${table.returnValue}`;
  }
  return title;
}

/** Opening call stack for a table (outermost → innermost), frozen at first stop. */
function invocationStackFor(tableId: string): StackFrameDisplay[] {
  const openingIndex = lastTimeline.findIndex(
    (entry) => entry.tableId === tableId,
  );
  if (openingIndex < 0) return [];
  const opening = lastTimeline[openingIndex]!;
  const stackIds = opening.stack?.length ? opening.stack : [tableId];
  const tablesById = new Map(lastTables.map((table) => [table.id, table]));
  const frames: StackFrameDisplay[] = [];

  for (let i = 0; i < stackIds.length; i++) {
    const id = stackIds[i]!;
    const table = tablesById.get(id);
    if (!table) continue;
    const childId = stackIds[i + 1];
    const child = childId ? tablesById.get(childId) : undefined;
    const line =
      child?.callSite?.line ??
      (id === tableId ? opening.line : table.callSite?.line ?? null);
    frames.push({
      tableId: id,
      label: formatCallLabel(table),
      line: line != null && line > 0 ? line : null,
      current: id === tableId,
    });
  }
  return frames;
}

function callSiteKey(site: CallSite): string {
  return `${site.line}:${site.colOffset}:${site.endColOffset}`;
}

function callSiteGroupsAt(timelineIndex: number): Map<string, CallSiteGroup> {
  const groups = new Map<string, CallSiteGroup>();
  if (timelineIndex < 0) return groups;
  const current = lastTimeline[timelineIndex];
  if (!current) return groups;
  const currentStack = new Set(
    current.stack?.length ? current.stack : [current.tableId],
  );
  const tablesById = new Map(lastTables.map((table) => [table.id, table]));
  const activeFunctionBodies = new Set(
    [...currentStack]
      .map((tableId) => tablesById.get(tableId)?.functionName)
      .filter((name): name is string => name != null),
  );

  for (const table of lastTables) {
    const site = table.callSite;
    if (!site) continue;
    const startTimelineIndex = lastTimeline.findIndex(
      (entry) => entry.tableId === table.id,
    );
    if (startTimelineIndex < 0 || startTimelineIndex > timelineIndex) continue;
    const openingStack = lastTimeline[startTimelineIndex]?.stack ?? [];
    const tableStackIndex = openingStack.lastIndexOf(table.id);
    const callerTableId =
      tableStackIndex > 0 ? openingStack[tableStackIndex - 1] : undefined;
    const callerFunctionName = callerTableId
      ? tablesById.get(callerTableId)?.functionName
      : undefined;
    if (!callerFunctionName || !activeFunctionBodies.has(callerFunctionName)) {
      continue;
    }

    const key = callSiteKey(site);
    let group = groups.get(key);
    if (!group) {
      group = { key, site, calls: [] };
      groups.set(key, group);
    }
    group.calls.push({
      table,
      startTimelineIndex,
      returned:
        table.returnTimelineIndex != null &&
        timelineIndex >= table.returnTimelineIndex,
    });
  }

  for (const group of groups.values()) {
    group.calls.sort(
      (a, b) => a.startTimelineIndex - b.startTimelineIndex,
    );
  }
  return groups;
}

function hideCallTooltip(): void {
  if (callTooltipHideTimer != null) {
    window.clearTimeout(callTooltipHideTimer);
    callTooltipHideTimer = null;
  }
  callTooltip.hidden = true;
  callTooltip.replaceChildren();
}

function scheduleCallTooltipHide(): void {
  if (callTooltipHideTimer != null) {
    window.clearTimeout(callTooltipHideTimer);
  }
  callTooltipHideTimer = window.setTimeout(hideCallTooltip, 120);
}

function goToTraceTable(tableId: string): void {
  const table = [...tablesEl.querySelectorAll<HTMLDetailsElement>(
    "details.trace-table",
  )].find((candidate) => candidate.dataset.tableId === tableId);
  if (!table) return;
  table.open = true;
  table.scrollIntoView({ block: "nearest", behavior: "smooth" });
  table.classList.remove("jump-target");
  window.requestAnimationFrame(() => table.classList.add("jump-target"));
}

function cancelCallTooltipHide(): void {
  if (callTooltipHideTimer != null) {
    window.clearTimeout(callTooltipHideTimer);
    callTooltipHideTimer = null;
  }
}

function positionCallTooltip(anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = callTooltip.getBoundingClientRect();
  const gap = 6;
  const maxLeft = Math.max(gap, window.innerWidth - tooltipRect.width - gap);
  const left = Math.min(Math.max(gap, anchorRect.left), maxLeft);
  let top = anchorRect.bottom + gap;
  if (top + tooltipRect.height > window.innerHeight - gap) {
    top = Math.max(gap, anchorRect.top - tooltipRect.height - gap);
  }
  callTooltip.style.left = `${left}px`;
  callTooltip.style.top = `${top}px`;
}

function showTooltipContent(anchor: HTMLElement, content: HTMLElement): void {
  cancelCallTooltipHide();
  callTooltip.replaceChildren(content);
  callTooltip.hidden = false;
  positionCallTooltip(anchor);
}

function showCallTooltip(
  anchor: HTMLElement,
  group: CallSiteGroup,
): void {
  const list = document.createElement("div");
  list.className = "call-site-tooltip-list";
  for (const occurrence of group.calls) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "call-site-tooltip-link";
    if (occurrence.returned) link.classList.add("returned");
    link.dataset.tableId = occurrence.table.id;
    link.textContent = formatTableTitle(occurrence.table, playbackIndex);
    list.appendChild(link);
  }
  showTooltipContent(anchor, list);
}

function showCallStackTooltip(anchor: HTMLElement, tableId: string): void {
  const frames = invocationStackFor(tableId);
  if (frames.length === 0) {
    hideCallTooltip();
    return;
  }

  const list = document.createElement("div");
  list.className = "call-stack-tooltip-list";
  for (const frame of frames) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "call-stack-frame";
    if (frame.current) row.classList.add("current");
    row.dataset.tableId = frame.tableId;

    const label = document.createElement("span");
    label.className = "call-stack-label";
    label.textContent = frame.label;
    row.appendChild(label);

    if (frame.line != null) {
      const line = document.createElement("span");
      line.className = "call-stack-line";
      line.textContent = `line ${frame.line}`;
      row.appendChild(line);
    }
    list.appendChild(row);
  }
  showTooltipContent(anchor, list);
}

/** Rebuild a table showing only state up through maxStepIndex (-1 = empty). */
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
      if (prev[name] !== value) {
        histories[name]!.push(value);
      }
    }
    prev = { ...step.locals };
  }

  return {
    ...table,
    variables,
    types,
    histories,
    steps,
    // Caller decides whether to show return via formatTableTitle + timelineIndex.
  };
}

function maxStepForTable(
  tableId: string,
  timeline: TimelineEntry[],
  upTo: number,
): number {
  let max = -1;
  for (let i = 0; i <= upTo; i++) {
    const entry = timeline[i];
    if (entry && entry.tableId === tableId) {
      max = Math.max(max, entry.stepIndex);
    }
  }
  return max;
}

type TableRole = "active" | "stack" | "idle";

function createTableShell(
  table: TraceTable,
  timelineIndex: number | null,
  role: TableRole,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "trace-table";
  if (role === "active") details.classList.add("active");
  if (role === "stack") details.classList.add("on-stack");
  details.dataset.tableId = table.id;
  details.dataset.style = tableStyle;
  // In line-by-line mode, only keep the live call stack expanded.
  details.open = role !== "idle";

  const summary = document.createElement("summary");
  summary.className = "call-title";
  summary.dataset.tableId = table.id;
  summary.textContent = formatTableTitle(table, timelineIndex);
  details.appendChild(summary);
  return details;
}

function appendVariableHeaders(
  headRow: HTMLTableRowElement,
  table: TraceTable,
): void {
  const params = new Set(table.parameters ?? []);
  for (const name of table.variables) {
    const th = document.createElement("th");
    const isParam = params.has(name);
    if (isParam) th.classList.add("is-param");
    const nameEl = document.createElement("span");
    nameEl.className = isParam ? "var-name var-param" : "var-name";
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
}

function buildTableFrame(table: TraceTable): {
  wrap: HTMLDivElement;
  tbody: HTMLTableSectionElement;
} {
  const wrap = document.createElement("div");
  wrap.className = "table-scroll";

  const htmlTable = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  appendVariableHeaders(headRow, table);
  thead.appendChild(headRow);
  htmlTable.appendChild(thead);

  const tbody = document.createElement("tbody");
  htmlTable.appendChild(tbody);
  wrap.appendChild(htmlTable);
  return { wrap, tbody };
}

/** Variables whose value changed on the given step (vs the previous step). */
function changedVarsAtStep(table: TraceTable, stepIndex: number): Set<string> {
  const steps = table.steps ?? [];
  const curr = steps[stepIndex]?.locals ?? {};
  const prev = stepIndex > 0 ? (steps[stepIndex - 1]?.locals ?? {}) : {};
  const changed = new Set<string>();
  for (const [name, value] of Object.entries(curr)) {
    if (prev[name] !== value) changed.add(name);
  }
  return changed;
}

function renderValueHistoryBody(
  tbody: HTMLTableSectionElement,
  table: TraceTable,
  changedVars: Set<string> | null,
): void {
  const maxRows = Math.max(
    0,
    ...table.variables.map((v) => table.histories[v]?.length ?? 0),
  );

  for (let row = 0; row < maxRows; row++) {
    const tr = document.createElement("tr");
    for (const name of table.variables) {
      const td = document.createElement("td");
      const history = table.histories[name] ?? [];
      td.textContent = row < history.length ? history[row]! : "";
      if (row >= history.length) {
        td.className = "blank";
      } else if (
        changedVars?.has(name) &&
        row === history.length - 1
      ) {
        td.classList.add("current-cell");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function changesOnlyRows(
  table: TraceTable,
): Array<Record<string, string | null>> {
  const steps = table.steps ?? [];
  const rows: Array<Record<string, string | null>> = [];
  const prev: Record<string, string> = {};

  for (const step of steps) {
    const cells: Record<string, string | null> = {};
    let anyChange = false;

    for (const name of table.variables) {
      if (!(name in step.locals)) {
        cells[name] = null;
        continue;
      }
      const value = step.locals[name]!;
      if (prev[name] !== value) {
        cells[name] = value;
        anyChange = true;
      } else {
        cells[name] = null;
      }
    }

    if (anyChange) {
      rows.push(cells);
      for (const name of table.variables) {
        if (name in step.locals) {
          prev[name] = step.locals[name]!;
        }
      }
    }
  }

  return rows;
}

function fullSnapshotRows(table: TraceTable): TraceStep[] {
  const steps = table.steps ?? [];
  const rows: TraceStep[] = [];
  let prevKey: string | null = null;

  for (const step of steps) {
    const key = table.variables
      .map((name) => `${name}=${step.locals[name] ?? ""}`)
      .join("\0");
    if (key === prevKey) continue;
    prevKey = key;
    rows.push(step);
  }

  return rows;
}

function renderChangesOnlyBody(
  tbody: HTMLTableSectionElement,
  table: TraceTable,
  highlightChanges: boolean,
): void {
  const rows = changesOnlyRows(table);
  rows.forEach((cells, index) => {
    const tr = document.createElement("tr");
    const isLast = highlightChanges && index === rows.length - 1;
    for (const name of table.variables) {
      const td = document.createElement("td");
      const value = cells[name];
      if (value == null) {
        td.className = "blank";
        td.textContent = "";
      } else {
        td.textContent = value;
        if (isLast) td.classList.add("current-cell");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}

function renderFullSnapshotBody(
  tbody: HTMLTableSectionElement,
  table: TraceTable,
  highlightChanges: boolean,
): void {
  const rows = fullSnapshotRows(table);
  rows.forEach((step, index) => {
    const tr = document.createElement("tr");
    const prev = index > 0 ? rows[index - 1]!.locals : {};
    const isLast = highlightChanges && index === rows.length - 1;
    for (const name of table.variables) {
      const td = document.createElement("td");
      if (name in step.locals) {
        td.textContent = step.locals[name]!;
        if (isLast && prev[name] !== step.locals[name]) {
          td.classList.add("current-cell");
        }
      } else {
        td.className = "blank";
        td.textContent = "";
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}

function renderTraceTable(
  table: TraceTable,
  timelineIndex: number | null,
  role: TableRole,
): HTMLElement {
  const details = createTableShell(table, timelineIndex, role);

  if (table.variables.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No local variables recorded.";
    details.appendChild(empty);
    return details;
  }

  const { wrap, tbody } = buildTableFrame(table);
  const highlight =
    role === "active" &&
    timelineIndex != null &&
    lastTimeline[timelineIndex]?.kind !== "callReturn";
  const stepIndex = highlight ? (table.steps?.length ?? 1) - 1 : -1;
  const changed = highlight ? changedVarsAtStep(table, stepIndex) : null;

  if (tableStyle === "valueHistory") {
    renderValueHistoryBody(tbody, table, changed);
  } else if (tableStyle === "changesOnly") {
    renderChangesOnlyBody(tbody, table, highlight);
  } else {
    renderFullSnapshotBody(tbody, table, highlight);
  }

  details.appendChild(wrap);
  return details;
}

function orderedTables(tables: TraceTable[]): TraceTable[] {
  return [...tables].sort((a, b) => {
    const aMod = a.functionName === "<module>" ? 1 : 0;
    const bMod = b.functionName === "<module>" ? 1 : 0;
    return aMod - bMod;
  });
}

function latestLineForTable(
  tableId: string,
  timeline: TimelineEntry[],
  upTo: number,
): number | null {
  let line: number | null = null;
  for (let i = 0; i <= upTo; i++) {
    const entry = timeline[i];
    if (entry && entry.tableId === tableId) {
      line = entry.line;
    }
  }
  return line;
}

/** Stack frame lines for code highlighting (current wins on duplicate lines). */
function stackHighlightLines(
  current: TimelineEntry,
  timeline: TimelineEntry[],
  upTo: number,
  tablesById: Map<string, TraceTable>,
): Array<{ line: number; current: boolean; callSite?: CallSite }> {
  const stack = current.stack?.length ? current.stack : [current.tableId];
  const returnedChild = current.callSiteTableId
    ? tablesById.get(current.callSiteTableId)
    : undefined;
  const byLine = new Map<
    number,
    { current: boolean; callSite?: CallSite }
  >();

  for (let i = 0; i < stack.length; i++) {
    const tableId = stack[i]!;
    const isCurrent = tableId === current.tableId;
    const childId = stack[i + 1];
    const child = childId ? tablesById.get(childId) : undefined;
    // Prefer the child's recorded call-site line for parent frames waiting in a call.
    const line =
      (isCurrent && returnedChild?.callSite?.line) ||
      (!isCurrent && child?.callSite?.line) ||
      latestLineForTable(tableId, timeline, upTo);
    if (line == null || line < 1) continue;

    const callSite =
      (isCurrent && returnedChild?.callSite) ||
      (!isCurrent && child?.callSite ? child.callSite : undefined);

    const prev = byLine.get(line);
    if (!prev) {
      byLine.set(line, { current: isCurrent, callSite });
    } else {
      byLine.set(line, {
        current: prev.current || isCurrent,
        callSite: callSite ?? prev.callSite,
      });
    }
  }

  return [...byLine.entries()].map(([line, info]) => ({
    line,
    current: info.current,
    callSite: info.callSite,
  }));
}

function renderTables(): void {
  hideCallTooltip();
  tablesEl.replaceChildren();

  if (lastTables.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No trace tables produced.";
    tablesEl.appendChild(empty);
    renderCodeView([], false);
    updateIoForMode();
    return;
  }

  if (playbackIndex < 0 || lastTimeline.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      lastTimeline.length === 0
        ? "No steps to play back."
        : "Press ▶ to begin stepping.";
    tablesEl.appendChild(empty);
    renderCodeView([], false);
    updateIoForMode();
    return;
  }

  const current = lastTimeline[playbackIndex]!;
  const stackSet = new Set(
    current.stack?.length ? current.stack : [current.tableId],
  );
  let activeEl: HTMLElement | null = null;

  for (const table of orderedTables(lastTables)) {
    const maxStep = maxStepForTable(table.id, lastTimeline, playbackIndex);
    const sliced = sliceTable(table, maxStep);
    if (!sliced) continue;

    let role: TableRole = "idle";
    if (table.id === current.tableId) role = "active";
    else if (stackSet.has(table.id)) role = "stack";

    const el = renderTraceTable(sliced, playbackIndex, role);
    tablesEl.appendChild(el);
    if (role === "active") activeEl = el;
  }

  renderCodeView(
    stackHighlightLines(
      current,
      lastTimeline,
      playbackIndex,
      new Map(lastTables.map((t) => [t.id, t])),
    ),
    followPlaybackScroll,
  );
  updateIoForMode();

  if (followPlaybackScroll) {
    activeEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const cell = activeEl?.querySelector("td.current-cell");
    cell?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function callSiteRangesForLine(
  line: number,
  textLength: number,
): CallSiteRange[] {
  const groups = [...visibleCallSiteGroups.values()]
    .filter((group) => group.site.line === line)
    .map((group) => ({
      group,
      start: Math.max(0, Math.min(textLength, group.site.colOffset)),
      end: Math.max(0, Math.min(textLength, group.site.endColOffset)),
      children: [],
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const roots: CallSiteRange[] = [];
  const stack: CallSiteRange[] = [];
  for (const range of groups) {
    while (stack.length > 0 && range.start >= stack.at(-1)!.end) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent && range.end <= parent.end) {
      parent.children.push(range);
    } else if (!parent) {
      roots.push(range);
    } else {
      // Python call spans should be nested or disjoint. Ignore a malformed
      // partial overlap rather than rendering the source text twice.
      continue;
    }
    stack.push(range);
  }
  return roots;
}

function appendDecoratedCode(
  parent: HTMLElement,
  text: string,
  start: number,
  end: number,
  ranges: CallSiteRange[],
  activeCallSite?: CallSite,
): void {
  let cursor = start;
  for (const range of ranges) {
    parent.append(text.slice(cursor, range.start));
    const callEl = document.createElement("span");
    callEl.className = "call-site-history";
    callEl.dataset.callSiteKey = range.group.key;
    callEl.tabIndex = 0;
    const allReturned = range.group.calls.every((call) => call.returned);
    callEl.classList.add(allReturned ? "returned" : "pending");
    if (
      activeCallSite &&
      callSiteKey(activeCallSite) === range.group.key
    ) {
      callEl.classList.add("active-call");
    }
    appendDecoratedCode(
      callEl,
      text,
      range.start,
      range.end,
      range.children,
      activeCallSite,
    );
    parent.appendChild(callEl);
    cursor = range.end;
  }
  parent.append(text.slice(cursor, end));
}

function renderCodeView(
  highlights: Array<{ line: number; current: boolean; callSite?: CallSite }>,
  followCurrentLine: boolean,
): void {
  const byLine = new Map(highlights.map((item) => [item.line, item]));
  visibleCallSiteGroups = callSiteGroupsAt(playbackIndex);
  const fragment = document.createDocumentFragment();
  const lines = sourceCode.split("\n");
  let currentLineNumber: number | null = null;

  lines.forEach((text, index) => {
    const lineNumber = index + 1;
    const highlight = byLine.get(lineNumber);
    const lineEl = document.createElement("div");
    lineEl.className = "code-line";
    lineEl.dataset.line = String(lineNumber);
    if (highlight?.current) {
      lineEl.classList.add("current-line");
      currentLineNumber = lineNumber;
    } else if (highlight) {
      lineEl.classList.add("stack-line");
    }

    const numberEl = document.createElement("span");
    numberEl.className = "code-line-number";
    numberEl.textContent = String(lineNumber);
    lineEl.appendChild(numberEl);

    const textEl = document.createElement("span");
    textEl.className = "code-line-text";
    const ranges = callSiteRangesForLine(lineNumber, text.length);
    appendDecoratedCode(
      textEl,
      text || " ",
      0,
      Math.max(text.length, 1),
      ranges,
      highlight?.callSite,
    );
    lineEl.appendChild(textEl);
    fragment.appendChild(lineEl);
  });

  codeViewContent.replaceChildren(fragment);

  const currentLineEl =
    currentLineNumber == null
      ? null
      : codeViewContent.querySelector<HTMLElement>(
          `[data-line="${currentLineNumber}"]`,
        );
  if (followCurrentLine && currentLineEl) {
    const lineTop = currentLineEl.offsetTop;
    const lineBottom = lineTop + currentLineEl.offsetHeight;
    if (lineTop < codeView.scrollTop) {
      codeView.scrollTop = lineTop;
    } else if (lineBottom > codeView.scrollTop + codeView.clientHeight) {
      codeView.scrollTop = lineBottom - codeView.clientHeight;
    }
  }
}

function updateIoForMode(): void {
  if (playbackIndex < 0 || lastTimeline.length === 0) {
    showIo("", undefined);
    return;
  }
  const len = lastTimeline[playbackIndex]?.stdoutLen ?? 0;
  const partial = lastStdout.slice(0, len);
  const atEnd = playbackIndex >= lastTimeline.length - 1;
  showIo(partial, atEnd ? lastError : undefined);
}

function updatePlaybackUi(): void {
  const stepping = appMode === "run" && lastTimeline.length > 0;
  playbackEl.hidden = !stepping;

  if (!stepping) {
    stopPlayback();
    return;
  }

  const total = lastTimeline.length;
  const display = playbackIndex < 0 ? 0 : playbackIndex + 1;
  playbackMeta.textContent = `Step ${display} / ${total}`;

  stepResetBtn.disabled = playbackIndex <= 0;
  stepPrevBtn.disabled = playbackIndex < 0;
  stepNextBtn.disabled = playbackIndex >= total - 1;
  stepEndBtn.disabled = playbackIndex >= total - 1 || total === 0;
  stepPlayBtn.disabled = total === 0;
}

function setPlaybackIndex(index: number): void {
  const max = lastTimeline.length - 1;
  playbackIndex = Math.max(-1, Math.min(max, index));
  if (playbackIndex >= max) stopPlayback();
  updatePlaybackUi();
  followPlaybackScroll = true;
  renderTables();
  followPlaybackScroll = false;
}

function showIo(stdout: string, error?: string): void {
  const hasStdout = stdout.trim().length > 0;
  const hasError = Boolean(error);
  ioEl.hidden = !hasStdout && !hasError;
  stdoutEl.textContent = stdout;
  stdoutEl.hidden = !hasStdout;
  if (hasError) {
    errorEl.hidden = false;
    errorEl.textContent = error!;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }
}

function setRunning(isRunning: boolean): void {
  running = isRunning;
  runBtn.disabled = !ready || running;
  runBtn.textContent = running ? "Running…" : "Run";
}

function renderEditorGutter(): void {
  const lineCount = codeEl.value.split("\n").length;
  const numbers = Array.from({ length: lineCount }, (_, i) => i + 1);
  codeGutter.textContent = numbers.join("\n");
  codeGutter.scrollTop = codeEl.scrollTop;
}

function setAppMode(mode: "edit" | "run"): void {
  appMode = mode;
  const editing = mode === "edit";
  codeEdit.hidden = !editing;
  codeView.hidden = editing;
  runBtn.hidden = !editing;
  editBtn.hidden = editing;
  outputPane.hidden = editing;
  workspace.classList.toggle("is-editing", editing);
  if (editing) {
    stopPlayback();
    playbackEl.hidden = true;
    setStatus(ready ? "Ready to edit" : "Loading Python…");
    renderEditorGutter();
    codeEl.focus();
  } else {
    sourceCode = codeEl.value;
    renderCodeView([], false);
  }
}

function isTableStyle(value: string): value is TableStyle {
  return (
    value === "valueHistory" ||
    value === "changesOnly" ||
    value === "fullSnapshot"
  );
}

styleSelect.addEventListener("change", () => {
  const value = styleSelect.value;
  if (!isTableStyle(value)) return;
  tableStyle = value;
  renderTables();
});

editBtn.addEventListener("click", () => {
  stopPlayback();
  playbackIndex = -1;
  setAppMode("edit");
});

stepResetBtn.addEventListener("click", () => {
  stopPlayback();
  setPlaybackIndex(0);
});

stepPrevBtn.addEventListener("click", () => {
  stopPlayback();
  setPlaybackIndex(playbackIndex - 1);
});

stepNextBtn.addEventListener("click", () => {
  stopPlayback();
  setPlaybackIndex(playbackIndex + 1);
});

stepEndBtn.addEventListener("click", () => {
  stopPlayback();
  setPlaybackIndex(lastTimeline.length - 1);
});

stepPlayBtn.addEventListener("click", () => {
  if (playTimer != null) {
    stopPlayback();
    return;
  }
  if (playbackIndex >= lastTimeline.length - 1) {
    setPlaybackIndex(0);
  }
  stepPlayBtn.textContent = "Pause";
  playTimer = window.setInterval(() => {
    if (playbackIndex >= lastTimeline.length - 1) {
      stopPlayback();
      updatePlaybackUi();
      return;
    }
    setPlaybackIndex(playbackIndex + 1);
  }, 450);
});

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const msg = event.data;
  if (msg.type === "ready") {
    ready = true;
    setStatus("Ready");
    setRunning(false);
    return;
  }
  if (msg.type === "error") {
    ready = false;
    setStatus("Failed to load");
    showIo("", msg.message);
    setRunning(false);
    return;
  }
  if (msg.type === "result") {
    setRunning(false);
    setStatus(msg.error ? "Finished with errors" : "Done");
    lastTables = msg.tables;
    lastTimeline = msg.timeline ?? [];
    lastStdout = msg.stdout ?? "";
    lastError = msg.error;
    stopPlayback();
    playbackIndex = lastTimeline.length > 0 ? 0 : -1;
    updatePlaybackUi();
    followPlaybackScroll = true;
    renderTables();
    followPlaybackScroll = false;
  }
};

worker.onerror = (event) => {
  setStatus("Worker error");
  showIo("", event.message || "Worker failed");
  setRunning(false);
};

runBtn.addEventListener("click", () => {
  if (!ready || running) return;
  stopPlayback();
  setAppMode("run");
  setRunning(true);
  setStatus("Tracing…");
  lastTables = [];
  lastTimeline = [];
  playbackIndex = -1;
  updatePlaybackUi();
  tablesEl.replaceChildren();
  lastStdout = "";
  lastError = undefined;
  showIo("", undefined);
  renderCodeView([], false);
  post({ type: "run", code: sourceCode });
});

codeEl.addEventListener("input", renderEditorGutter);
codeEl.addEventListener("scroll", () => {
  codeGutter.scrollTop = codeEl.scrollTop;
});

function callSiteAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>(".call-site-history");
  return anchor && codeViewContent.contains(anchor) ? anchor : null;
}

function callTitleAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest<HTMLElement>("summary.call-title");
  return anchor && tablesEl.contains(anchor) ? anchor : null;
}

codeViewContent.addEventListener("pointerover", (event) => {
  const anchor = callSiteAnchor(event.target);
  if (!anchor) return;
  const previous = callSiteAnchor(event.relatedTarget);
  if (previous === anchor) return;
  const group = visibleCallSiteGroups.get(anchor.dataset.callSiteKey ?? "");
  if (group) showCallTooltip(anchor, group);
});

codeViewContent.addEventListener("pointerout", (event) => {
  const anchor = callSiteAnchor(event.target);
  if (!anchor) return;
  const next = callSiteAnchor(event.relatedTarget);
  if (next === anchor) return;
  scheduleCallTooltipHide();
});

codeViewContent.addEventListener("focusin", (event) => {
  const anchor = callSiteAnchor(event.target);
  const group = anchor
    ? visibleCallSiteGroups.get(anchor.dataset.callSiteKey ?? "")
    : undefined;
  if (anchor && group) showCallTooltip(anchor, group);
});

codeViewContent.addEventListener("focusout", scheduleCallTooltipHide);

codeViewContent.addEventListener("click", (event) => {
  const anchor = callSiteAnchor(event.target);
  if (!anchor) return;
  const group = visibleCallSiteGroups.get(anchor.dataset.callSiteKey ?? "");
  if (!group) return;
  showCallTooltip(anchor, group);
  if (group.calls.length === 1) {
    goToTraceTable(group.calls[0]!.table.id);
  }
});

tablesEl.addEventListener("pointerover", (event) => {
  const anchor = callTitleAnchor(event.target);
  if (!anchor) return;
  const previous = callTitleAnchor(event.relatedTarget);
  if (previous === anchor) return;
  const tableId = anchor.dataset.tableId;
  if (tableId) showCallStackTooltip(anchor, tableId);
});

tablesEl.addEventListener("pointerout", (event) => {
  const anchor = callTitleAnchor(event.target);
  if (!anchor) return;
  const next = callTitleAnchor(event.relatedTarget);
  if (next === anchor) return;
  // Keep open when moving into the shared fixed tooltip.
  if (
    event.relatedTarget instanceof Node &&
    callTooltip.contains(event.relatedTarget)
  ) {
    return;
  }
  scheduleCallTooltipHide();
});

tablesEl.addEventListener("focusin", (event) => {
  const anchor = callTitleAnchor(event.target);
  const tableId = anchor?.dataset.tableId;
  if (anchor && tableId) showCallStackTooltip(anchor, tableId);
});

tablesEl.addEventListener("focusout", (event) => {
  if (
    event.relatedTarget instanceof Node &&
    (callTooltip.contains(event.relatedTarget) ||
      callTitleAnchor(event.relatedTarget))
  ) {
    return;
  }
  scheduleCallTooltipHide();
});

callTooltip.addEventListener("pointerenter", cancelCallTooltipHide);
callTooltip.addEventListener("pointerleave", scheduleCallTooltipHide);
callTooltip.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLElement>("[data-table-id]");
  if (!link?.dataset.tableId) return;
  goToTraceTable(link.dataset.tableId);
  hideCallTooltip();
});
codeView.addEventListener("scroll", hideCallTooltip);
tablesEl.closest(".tables-scroll")?.addEventListener("scroll", hideCallTooltip);

setAppMode("edit");
updatePlaybackUi();
post({ type: "init" });
