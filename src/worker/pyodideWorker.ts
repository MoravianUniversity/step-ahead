/// <reference lib="webworker" />

import tracerSource from "./tracer.py?raw";
import type {
  MainToWorker,
  TimelineEntry,
  TraceTable,
  WorkerToMain,
} from "../types";

declare const self: DedicatedWorkerGlobalScope;

type PyodideInterface = {
  FS: { writeFile: (path: string, data: string) => void };
  globals: { set: (name: string, value: unknown) => void };
  runPythonAsync: (code: string) => Promise<unknown>;
};

type LoadPyodide = (config: { indexURL: string }) => Promise<PyodideInterface>;

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/";

let pyodide: PyodideInterface | null = null;
let initPromise: Promise<void> | null = null;

async function loadPyodideFromCdn(): Promise<LoadPyodide> {
  const mod = (await import(
    /* @vite-ignore */
    `${PYODIDE_INDEX}pyodide.mjs`
  )) as { loadPyodide: LoadPyodide };
  return mod.loadPyodide;
}

async function ensurePyodide(): Promise<PyodideInterface> {
  if (pyodide) return pyodide;
  if (!initPromise) {
    initPromise = (async () => {
      const loadPyodide = await loadPyodideFromCdn();
      const instance = await loadPyodide({ indexURL: PYODIDE_INDEX });
      instance.FS.writeFile("/home/pyodide/tracer.py", tracerSource);
      await instance.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
import tracer
`);
      pyodide = instance;
    })();
  }
  await initPromise;
  if (!pyodide) throw new Error("Pyodide failed to initialize");
  return pyodide;
}

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

async function handleInit(): Promise<void> {
  try {
    await ensurePyodide();
    post({ type: "ready" });
  } catch (err) {
    post({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    initPromise = null;
    pyodide = null;
  }
}

async function handleRun(code: string): Promise<void> {
  try {
    const py = await ensurePyodide();
    // Keep tracer source fresh across Vite HMR / edits without a full reload.
    py.FS.writeFile("/home/pyodide/tracer.py", tracerSource);
    py.globals.set("_user_source", code);
    const raw = await py.runPythonAsync(`
import importlib
import tracer
importlib.reload(tracer)
tracer.run_user_code_json(_user_source)
`);
    const parsed = JSON.parse(String(raw)) as {
      tables: TraceTable[];
      timeline: TimelineEntry[];
      stdout: string;
      error: string | null;
    };
    post({
      type: "result",
      tables: parsed.tables ?? [],
      timeline: parsed.timeline ?? [],
      stdout: parsed.stdout ?? "",
      error: parsed.error ?? undefined,
    });
  } catch (err) {
    post({
      type: "result",
      tables: [],
      timeline: [],
      stdout: "",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleValidateLiteral(id: string, text: string): Promise<void> {
  try {
    const py = await ensurePyodide();
    // Embed the text in the source so concurrent validations cannot clobber a
    // shared `_literal_text` global (Promise.all in valuesEqual does this).
    const literalSource = JSON.stringify(text);
    const raw = await py.runPythonAsync(`
import ast
import json
_result = None
try:
    value = ast.literal_eval(${literalSource})
    _result = {"ok": True, "canonical": json.dumps(value, separators=(",", ":"))}
except Exception as exc:
    _result = {"ok": False, "error": str(exc)}
json.dumps(_result)
`);
    const parsed = JSON.parse(String(raw)) as {
      ok: boolean;
      canonical?: string;
      error?: string;
    };
    post({
      type: "literalResult",
      id,
      ok: parsed.ok,
      canonical: parsed.canonical,
      error: parsed.error,
    });
  } catch (err) {
    post({
      type: "literalResult",
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleExpand(
  id: string,
  seed: number,
  bindings: Record<string, string | number | boolean>,
  setup: string,
): Promise<void> {
  try {
    const py = await ensurePyodide();
    py.globals.set("_expand_seed", seed);
    py.globals.set("_expand_bindings_json", JSON.stringify(bindings));
    py.globals.set("_expand_setup", setup);
    const raw = await py.runPythonAsync(`
import json
import random
import types

_seed = int(_expand_seed)
_injected = json.loads(_expand_bindings_json)
_setup_src = _expand_setup

random.seed(_seed)
_ns = {"random": random, "__builtins__": __builtins__}
_ns.update(_injected)
_result = None
try:
    exec(_setup_src, _ns, _ns)
except Exception as exc:
    _result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
else:
    _out = {}
    _error = None
    for _key, _val in list(_ns.items()):
        if _key.startswith("_"):
            continue
        if _key in ("random", "__builtins__"):
            continue
        if isinstance(_val, types.ModuleType):
            continue
        if callable(_val):
            continue
        if isinstance(_val, bool):
            _out[_key] = _val
        elif isinstance(_val, int):
            _out[_key] = _val
        elif isinstance(_val, float):
            if _val != _val or _val in (float("inf"), float("-inf")):
                _error = f'Setup binding "{_key}" must be a finite number'
                break
            _out[_key] = _val
        elif isinstance(_val, str):
            _out[_key] = _val
        else:
            _error = (
                f'Setup binding "{_key}" must be int, float, bool, or str '
                f"(got {type(_val).__name__})"
            )
            break
    if _error:
        _result = {"ok": False, "error": _error}
    else:
        _result = {"ok": True, "bindings": _out}
json.dumps(_result)
`);
    const parsed = JSON.parse(String(raw)) as {
      ok: boolean;
      bindings?: Record<string, string | number | boolean>;
      error?: string;
    };
    if (parsed.ok) {
      post({
        type: "expanded",
        id,
        ok: true,
        bindings: parsed.bindings ?? {},
      });
    } else {
      post({
        type: "expanded",
        id,
        ok: false,
        error: parsed.error ?? "Setup failed",
      });
    }
  } catch (err) {
    post({
      type: "expanded",
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  if (msg.type === "init") {
    void handleInit();
  } else if (msg.type === "run") {
    void handleRun(msg.code);
  } else if (msg.type === "validateLiteral") {
    void handleValidateLiteral(msg.id, msg.text);
  } else if (msg.type === "expand") {
    void handleExpand(msg.id, msg.seed, msg.bindings, msg.setup);
  }
};
