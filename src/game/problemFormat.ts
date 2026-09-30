/** Slot values before stringification into the code template. */
export type SlotValue = string | number | boolean;

export type RandomBinding =
  | { kind: "fixed"; names: string[]; value: SlotValue }
  | { kind: "range"; names: string[]; min: number; max: number }
  | { kind: "choose"; names: string[]; pool: string[] };

export type ProblemTemplate = {
  id: string;
  title: string;
  description: string;
  random: RandomBinding[];
  /** Python source for optional [setup], or null. */
  setup: string | null;
  codeTemplate: string;
};

export type Bindings = Record<string, SlotValue>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mulberry32 — deterministic [0, 1) floats from a 32-bit seed. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`Invalid integer range ${min}..${max}`);
  }
  return min + Math.floor(rng() * (max - min + 1));
}

/** Fisher–Yates sample of `count` distinct items (order randomized). */
export function sampleWithoutReplacement<T>(
  rng: () => number,
  pool: readonly T[],
  count: number,
): T[] {
  if (count > pool.length) {
    throw new Error(
      `Cannot sample ${count} distinct values from a pool of ${pool.length}`,
    );
  }
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, count);
}

export function stringifySlot(value: SlotValue): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  return String(value);
}

export function stringifyBindings(
  bindings: Bindings,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bindings)) {
    out[key] = stringifySlot(value);
  }
  return out;
}

function parseSlotLiteral(raw: string): SlotValue {
  const text = raw.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === "True" || text === "true") return true;
  if (text === "False" || text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  // Bare identifier / token used as a fixed string (e.g. a default name).
  return text;
}

function parseLhsNames(lhs: string): string[] {
  const names = lhs
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error("Random binding is missing names before = or ~");
  }
  for (const name of names) {
    if (!IDENT.test(name)) {
      throw new Error(`Invalid slot name "${name}"`);
    }
  }
  return names;
}

function parseRandomLine(line: string, lineNo: number): RandomBinding {
  const chooseIdx = line.indexOf("~");
  const eqIdx = line.indexOf("=");
  const isChoose =
    chooseIdx >= 0 && (eqIdx < 0 || chooseIdx < eqIdx);
  if (isChoose) {
    const names = parseLhsNames(line.slice(0, chooseIdx));
    const pool = line
      .slice(chooseIdx + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (pool.length === 0) {
      throw new Error(`Line ${lineNo}: empty choice pool`);
    }
    return { kind: "choose", names, pool };
  }
  if (eqIdx < 0) {
    throw new Error(
      `Line ${lineNo}: expected "name = value" or "name ~ a b c"`,
    );
  }
  const names = parseLhsNames(line.slice(0, eqIdx));
  if (names.length !== 1) {
    throw new Error(
      `Line ${lineNo}: fixed/range bindings allow only one name (use ~ for multiple)`,
    );
  }
  const rhs = line.slice(eqIdx + 1).trim();
  const rangeMatch = /^(-?\d+)\.\.(-?\d+)$/.exec(rhs);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (max < min) {
      throw new Error(`Line ${lineNo}: range ${min}..${max} is empty`);
    }
    return { kind: "range", names, min, max };
  }
  return { kind: "fixed", names, value: parseSlotLiteral(rhs) };
}

function splitSections(source: string): {
  meta: string;
  random: string | null;
  setup: string | null;
  code: string;
} {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let mode: "meta" | "random" | "setup" | "code" = "meta";
  const buckets: Record<"meta" | "random" | "setup" | "code", string[]> = {
    meta: [],
    random: [],
    setup: [],
    code: [],
  };
  let sawCode = false;

  for (const line of lines) {
    const header = line.trim();
    if (header === "[random]") {
      mode = "random";
      continue;
    }
    if (header === "[setup]") {
      mode = "setup";
      continue;
    }
    if (header === "[code]") {
      mode = "code";
      sawCode = true;
      continue;
    }
    buckets[mode].push(line);
  }

  if (!sawCode) {
    throw new Error('Problem file must contain a [code] section');
  }

  const trimJoin = (parts: string[]) =>
    parts.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");

  return {
    meta: trimJoin(buckets.meta),
    random: buckets.random.length ? trimJoin(buckets.random) : null,
    setup: buckets.setup.length ? trimJoin(buckets.setup) : null,
    code: buckets.code.join("\n").replace(/^\n+/, "").replace(/\n+$/, "") +
      (buckets.code.length ? "\n" : ""),
  };
}

function parseMetadata(
  meta: string,
  filenameStem?: string,
): { id: string; title: string; description: string } {
  let id: string | undefined;
  let title: string | undefined;
  let description = "";

  for (const rawLine of meta.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      throw new Error(`Invalid metadata line: ${rawLine}`);
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === "id") id = value;
    else if (key === "title") title = value;
    else if (key === "description") description = value;
    else throw new Error(`Unknown metadata key "${key}"`);
  }

  if (!title) {
    throw new Error('Problem metadata must include "title"');
  }
  if (!id) {
    if (!filenameStem) {
      throw new Error(
        'Problem metadata must include "id" (or pass a filename stem)',
      );
    }
    id = filenameStem;
  }
  if (!IDENT.test(id) && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid problem id "${id}"`);
  }

  return { id, title, description };
}

export function parseProblemFile(
  source: string,
  filenameStem?: string,
): ProblemTemplate {
  const sections = splitSections(source);
  const meta = parseMetadata(sections.meta, filenameStem);
  const random: RandomBinding[] = [];
  if (sections.random) {
    const lines = sections.random.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line || line.startsWith("#")) continue;
      random.push(parseRandomLine(line, i + 1));
    }
  }
  return {
    id: meta.id,
    title: meta.title,
    description: meta.description,
    random,
    setup: sections.setup && sections.setup.trim() ? sections.setup : null,
    codeTemplate: sections.code,
  };
}

export function expandRandom(
  specs: readonly RandomBinding[],
  rng: () => number,
): Bindings {
  const bindings: Bindings = {};
  const assign = (name: string, value: SlotValue) => {
    if (Object.prototype.hasOwnProperty.call(bindings, name)) {
      throw new Error(`Duplicate random binding for "${name}"`);
    }
    bindings[name] = value;
  };

  for (const spec of specs) {
    if (spec.kind === "fixed") {
      assign(spec.names[0]!, spec.value);
    } else if (spec.kind === "range") {
      assign(spec.names[0]!, randomInt(rng, spec.min, spec.max));
    } else {
      const picks = sampleWithoutReplacement(rng, spec.pool, spec.names.length);
      for (let i = 0; i < spec.names.length; i++) {
        assign(spec.names[i]!, picks[i]!);
      }
    }
  }
  return bindings;
}

/**
 * Replace `$name` slots. `$$` becomes a literal `$`.
 * Unknown `$name` throws.
 */
export function substituteSlots(
  template: string,
  bindings: Bindings,
): string {
  return template.replace(/\$(\$|[A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
    if (name === "$") return "$";
    if (!Object.prototype.hasOwnProperty.call(bindings, name)) {
      throw new Error(`Unbound slot $${name}`);
    }
    return stringifySlot(bindings[name]!);
  });
}

/** Resolve [random] and substitute into [code] (no [setup]). */
export function expandDeclarative(
  template: ProblemTemplate,
  seed: number,
): { bindings: Bindings; code: string } {
  const bindings = expandRandom(template.random, createRng(seed));
  const code = substituteSlots(template.codeTemplate, bindings);
  return { bindings, code };
}

export function mergeSetupBindings(
  base: Bindings,
  fromSetup: Bindings,
): Bindings {
  return { ...base, ...fromSetup };
}

/** Validate / coerce a value returned from [setup] into a slot value. */
export function coerceSetupValue(name: string, value: unknown): SlotValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Setup binding "${name}" must be a finite number`);
    }
    return value;
  }
  throw new Error(
    `Setup binding "${name}" must be int, float, bool, or str (got ${describeType(value)})`,
  );
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}
