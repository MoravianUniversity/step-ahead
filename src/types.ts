/** How cells are laid out in a trace table. */
export type TableStyle = "valueHistory" | "changesOnly" | "fullSnapshot";

export type TraceStep = {
  line: number;
  locals: Record<string, string>;
};

/** One stop in global execution order (for line-by-line playback). */
export type TimelineEntry = {
  tableId: string;
  line: number;
  /** Index into that table's steps array at this stop. */
  stepIndex: number;
  /** Synthetic stop after a child returns, before the caller resumes. */
  kind?: "step" | "callReturn";
  /** Returned child whose call site should be emphasized at this stop. */
  callSiteTableId?: string;
  /** Open call table IDs from outermost to innermost (includes tableId). */
  stack: string[];
  /** Characters of stdout captured before this stop (progressive output). */
  stdoutLen: number;
};

export type CallSite = {
  line: number;
  /** Start column on that line (0-based, Python co_positions). */
  colOffset: number;
  /** End column (exclusive). */
  endColOffset: number;
};

export type TraceTable = {
  id: string;
  functionName: string;
  /** Argument value reprs in parameter order (for the header). */
  args: string[];
  /**
   * Repr of the return value once the call has returned.
   * null means the call has not returned yet (no arrow in the header).
   */
  returnValue: string | null;
  /**
   * Timeline index at which returnValue became available.
   * Used by line-by-line mode to defer the → arrow.
   */
  returnTimelineIndex?: number | null;
  /**
   * Where this call was invoked in the parent source (column span).
   * Derived from the caller's f_lasti + bytecode positions — not a pdb API.
   */
  callSite?: CallSite | null;
  /** Local names that are function parameters (incl. *args/**kwargs). */
  parameters: string[];
  callIndex: number;
  variables: string[];
  /** Python type name per variable (first seen), e.g. "int", "str". */
  types: Record<string, string>;
  histories: Record<string, string[]>;
  steps?: TraceStep[];
};

export type WorkerToMain =
  | { type: "ready" }
  | {
      type: "result";
      tables: TraceTable[];
      timeline: TimelineEntry[];
      stdout: string;
      error?: string;
    }
  | {
      type: "literalResult";
      id: string;
      ok: boolean;
      /** Canonical JSON encoding of the literal (for equality checks). */
      canonical?: string;
      error?: string;
    }
  | {
      type: "expanded";
      id: string;
      ok: true;
      /** Public setup locals as JSON-friendly slot values. */
      bindings: Record<string, string | number | boolean>;
    }
  | {
      type: "expanded";
      id: string;
      ok: false;
      error: string;
    }
  | { type: "error"; message: string };

export type MainToWorker =
  | { type: "init" }
  | { type: "run"; code: string }
  | { type: "validateLiteral"; id: string; text: string }
  | {
      type: "expand";
      id: string;
      seed: number;
      /** Declarative [random] bindings injected as setup locals. */
      bindings: Record<string, string | number | boolean>;
      setup: string;
    };
