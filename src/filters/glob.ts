// Matches repository and branch names against configured glob rules.
import { minimatch } from "minimatch";

export type GlobRules = {
  include: string[];
  exclude: string[];
};

const matchesPattern = (value: string, pattern: string): boolean =>
  pattern === "*" || minimatch(value, pattern, { dot: true });

export const matchesGlobRules = (value: string, rules: GlobRules): boolean => {
  const include = rules.include.length === 0 ? ["*"] : rules.include;
  const included = include.some((pattern) => matchesPattern(value, pattern));

  if (!included) {
    return false;
  }

  return !rules.exclude.some((pattern) => matchesPattern(value, pattern));
};
