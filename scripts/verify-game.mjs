/**
 * Offline verification for the game prediction engine against the Python tracer.
 * Run: node scripts/verify-game.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const code = `def double(n):
    result = n * 2
    return result


x = 1
y = double(x)
if y > 1:
    z = y + 1
else:
    z = 0
print(z)
`;

const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(root, "src/worker"))})
import tracer
result = tracer.run_user_code(${JSON.stringify(code)})
print(json.dumps(result))
`;

const traced = spawnSync("python3", ["-c", py], {
  encoding: "utf8",
  cwd: root,
});
if (traced.status !== 0) {
  console.error(traced.stderr || traced.stdout);
  process.exit(1);
}

const payload = JSON.parse(traced.stdout);
const tables = new Map(payload.tables.map((t) => [t.id, t]));
const sourceLines = code.replace(/\n$/, "").split("\n");
const playable = payload.timeline.filter((entry) => {
  if (entry.line < 1) return false;
  return !/^\s*(?:async\s+)?def\b/.test(sourceLines[entry.line - 1] ?? "");
});
const timeline = [];
for (let i = 0; i < playable.length; i++) {
  const current = playable[i];
  timeline.push(current);
  const next = playable[i + 1];
  const outputEnd = next?.stdoutLen ?? payload.stdout.length;
  if (outputEnd > current.stdoutLen) {
    timeline.push({
      ...current,
      gameEvent: "output",
      outputText: payload.stdout.slice(current.stdoutLen, outputEnd),
      stdoutLen: outputEnd,
    });
  }
}

function classify(current, next) {
  if (next.gameEvent === "output") return "output";
  if (next.kind === "callReturn") return "return";
  if (next.stack.length > current.stack.length) return "call";
  return "advance";
}

function localsAt(table, stepIndex) {
  return table?.steps?.[stepIndex]?.locals ?? {};
}

function changedLocals(previous, next) {
  const changes = {};
  for (const [name, value] of Object.entries(next)) {
    if (previous[name] !== value) changes[name] = value;
  }
  return changes;
}

function expected(current, next) {
  const kind = classify(current, next);
  if (kind === "output") {
    return { kind, output: next.outputText ?? "" };
  }
  if (kind === "call") {
    const table = tables.get(next.tableId);
    const params = {};
    (table.parameters ?? []).forEach((name, index) => {
      params[name] = table.args[index] ?? localsAt(table, next.stepIndex)[name];
    });
    return {
      kind,
      functionName: table.functionName,
      acceptedLines: [...new Set([table.steps?.[0]?.line, next.line])],
      params,
    };
  }
  if (kind === "return") {
    const child = tables.get(next.callSiteTableId ?? current.tableId);
    return { kind, line: next.line, returnValue: child.returnValue ?? "None" };
  }
  const table = tables.get(next.tableId);
  const baseline =
    current.kind === "callReturn" && next.tableId === current.tableId
      ? localsAt(tables.get(current.tableId), current.stepIndex)
      : next.tableId === current.tableId
        ? localsAt(tables.get(current.tableId), current.stepIndex)
        : localsAt(table, Math.max(0, next.stepIndex - 1));
  return {
    kind,
    line: next.line,
    changes: changedLocals(baseline, localsAt(table, next.stepIndex)),
  };
}

const failures = [];
const kinds = [];
for (let i = 0; i < timeline.length - 1; i++) {
  const exp = expected(timeline[i], timeline[i + 1]);
  kinds.push(exp.kind);
}

if (!kinds.includes("call")) failures.push("expected a call transition");
if (!kinds.includes("return")) failures.push("expected a return transition");
if (!kinds.includes("advance")) failures.push("expected an advance transition");
if (!kinds.includes("output")) failures.push("expected an output transition");
if (
  timeline.some(
    (entry) =>
      entry.line > 0 &&
      /^\s*(?:async\s+)?def\b/.test(sourceLines[entry.line - 1] ?? ""),
  )
) {
  failures.push("definition lines should be skipped");
}

const callIdx = kinds.indexOf("call");
const callExp = expected(timeline[callIdx], timeline[callIdx + 1]);
if (callExp.functionName !== "double" || callExp.params.n !== "1") {
  failures.push(`bad call expected: ${JSON.stringify(callExp)}`);
}
if (
  !callExp.acceptedLines.includes(1) ||
  !callExp.acceptedLines.includes(2) ||
  timeline[callIdx + 1].line !== 2
) {
  failures.push(`call should accept def/body lines and land on body: ${JSON.stringify(callExp)}`);
}

const retIdx = kinds.indexOf("return");
const retExp = expected(timeline[retIdx], timeline[retIdx + 1]);
if (retExp.line == null || retExp.returnValue !== "2") {
  failures.push(`bad return expected: ${JSON.stringify(retExp)}`);
}

// Branch should assign z = y + 1 (=3), not the else path.
const zAdvance = [];
for (let i = 0; i < timeline.length - 1; i++) {
  const exp = expected(timeline[i], timeline[i + 1]);
  if (exp.kind === "advance" && exp.changes?.z === "3") zAdvance.push(exp);
}
if (zAdvance.length === 0) {
  failures.push("expected advance that sets z to 3 on the taken branch");
}

const outputIdx = kinds.indexOf("output");
const outputExp = expected(timeline[outputIdx], timeline[outputIdx + 1]);
if (outputExp.output !== "3\n" || outputIdx !== kinds.length - 1) {
  failures.push(`final output should be the final prediction: ${JSON.stringify(outputExp)}`);
}

console.log("Transitions:", kinds.join(" → "));
console.log(
  "Tables:",
  payload.tables.map((t) => `${t.id}:${t.functionName}(${t.args})→${t.returnValue}`).join(", "),
);

if (failures.length) {
  console.error("FAIL");
  for (const failure of failures) console.error("-", failure);
  process.exit(1);
}
console.log("OK");
