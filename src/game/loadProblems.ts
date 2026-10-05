import {
  expandDeclarative,
  expandRandom,
  createRng,
  mergeSetupBindings,
  coerceSetupValue,
  substituteSlots,
  parseProblemFile,
  compareProblemOrder,
  type Bindings,
  type ProblemTemplate,
  type SlotValue,
} from "./problemFormat";

export type { ProblemTemplate };

const problemModules = import.meta.glob("../../problems/*.problem", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function stemFromPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.problem$/i, "");
}

function loadTemplates(): ProblemTemplate[] {
  const templates: ProblemTemplate[] = [];
  for (const [path, source] of Object.entries(problemModules)) {
    const template = parseProblemFile(source, stemFromPath(path));
    if (!template.enable) continue;
    templates.push(template);
  }
  templates.sort(compareProblemOrder);
  return templates;
}

export const PROBLEM_TEMPLATES: ProblemTemplate[] = loadTemplates();

export function getProblemTemplate(
  id: string,
): ProblemTemplate | undefined {
  return PROBLEM_TEMPLATES.find((problem) => problem.id === id);
}

export type ExpandSetupFn = (
  seed: number,
  bindings: Bindings,
  setup: string,
) => Promise<Bindings>;

export type ExpandedProblem = {
  id: string;
  title: string;
  description: string;
  code: string;
  seed: number;
  bindings: Bindings;
};

/** Expand a template to concrete Python. Uses `runSetup` when [setup] is present. */
export async function expandProblemTemplate(
  template: ProblemTemplate,
  seed: number,
  runSetup?: ExpandSetupFn,
): Promise<ExpandedProblem> {
  let bindings = expandRandom(template.random, createRng(seed));

  if (template.setup) {
    if (!runSetup) {
      throw new Error(
        `Problem "${template.id}" has [setup] but no setup runner was provided`,
      );
    }
    const fromSetup = await runSetup(seed, bindings, template.setup);
    const coerced: Bindings = {};
    for (const [name, value] of Object.entries(fromSetup)) {
      coerced[name] = coerceSetupValue(name, value);
    }
    bindings = mergeSetupBindings(bindings, coerced);
  }

  const code = substituteSlots(template.codeTemplate, bindings);
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    code,
    seed,
    bindings,
  };
}

/** Sync expand when the template has no [setup]. */
export function expandProblemTemplateSync(
  template: ProblemTemplate,
  seed: number,
): ExpandedProblem {
  if (template.setup) {
    throw new Error(
      `Problem "${template.id}" has [setup]; use expandProblemTemplate`,
    );
  }
  const { bindings, code } = expandDeclarative(template, seed);
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    code,
    seed,
    bindings,
  };
}

export function newInstanceSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

export type { SlotValue, Bindings };
