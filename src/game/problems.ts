import {
  PROBLEM_TEMPLATES,
  getProblemTemplate,
  type ProblemTemplate,
} from "./loadProblems";

export type GameFunctionDef = {
  name: string;
  parameters: string[];
};

export type GameProblem = {
  id: string;
  title: string;
  description: string;
  code: string;
  /** Optional; call targets are discovered from defs in `code`. */
  functions?: GameFunctionDef[];
  /** Seed used to expand this instance (when loaded from a .problem file). */
  seed?: number;
};

/** Catalog entries for the picker (unexpanded templates). */
export const GAME_PROBLEMS: ProblemTemplate[] = PROBLEM_TEMPLATES;

if (GAME_PROBLEMS.length === 0) {
  throw new Error(
    "No problems loaded — add .problem files under problems/",
  );
}

export function getProblem(id: string): ProblemTemplate | undefined {
  return getProblemTemplate(id);
}

export type { ProblemTemplate };
