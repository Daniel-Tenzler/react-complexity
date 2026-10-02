export const METRICS = {
  cognitive: {
    weight: 1,
    baseline: 0,
    label: "Cogn",
    column: true,
    description: "Sonar cognitive complexity (nested flow costs more than flat branches)",
  },
  cyclomatic: {
    weight: 0.35,
    baseline: 0,
    label: "Cyc",
    column: true,
    description: "Decision points: if, loop, case, catch, ternary, &&, ||, ??",
  },
  maxCyclomatic: {
    weight: 0,
    baseline: 0,
    label: "MaxCyc",
    column: false,
    description: "Highest function McCabe (1 + decision points inside that function)",
  },
  jsxDepth: {
    weight: 1.5,
    baseline: 1,
    label: "JSX",
    column: true,
    description: "Deepest JSX element/fragment nesting",
  },
  jsxElements: {
    weight: 0.04,
    baseline: 0,
    label: "Els",
    column: false,
    description: "Number of JSX elements",
  },
  jsxExpressions: {
    weight: 0,
    baseline: 0,
    label: "Expr",
    column: false,
    description: "Dynamic {...} slots in JSX",
  },
  hooks: {
    weight: 1.25,
    baseline: 0,
    label: "Hooks",
    column: true,
    description: "use* calls, including effects (effects also have their own weight)",
  },
  effects: {
    weight: 2.5,
    baseline: 0,
    label: "Eff",
    column: true,
    description: "Extra penalty for useEffect, useLayoutEffect, useInsertionEffect, useImperativeHandle",
  },
  stateHooks: {
    weight: 0,
    baseline: 0,
    label: "State",
    column: false,
    description: "useState + useReducer (already included in hooks)",
  },
  memoHooks: {
    weight: 0,
    baseline: 0,
    label: "Memo",
    column: false,
    description: "useMemo + useCallback (already included in hooks)",
  },
  customHooks: {
    weight: 0,
    baseline: 0,
    label: "Cust",
    column: false,
    description: "Other use* calls (already included in hooks)",
  },
  effectDeps: {
    weight: 0,
    baseline: 0,
    label: "Deps",
    column: false,
    description: "Effect dependency entries (off by default so a long list cannot outrank a missing array)",
  },
  memoDeps: {
    weight: 0,
    baseline: 0,
    label: "MDeps",
    column: false,
    description: "Total entries in useMemo/useCallback dependency arrays",
  },
  effectsWithoutDeps: {
    weight: 1,
    baseline: 0,
    label: "NoDeps",
    column: false,
    description: "Effects called with no dependency array",
  },
  conditionals: {
    weight: 0.4,
    baseline: 0,
    label: "Cond",
    column: false,
    description: "Conditional renders in JSX (ternary or &&/|| that produce elements)",
  },
  inlineHandlers: {
    weight: 0.8,
    baseline: 0,
    label: "Inline",
    column: false,
    description: "Function expressions passed as JSX props",
  },
  spreads: {
    weight: 0.3,
    baseline: 0,
    label: "Spread",
    column: false,
    description: "JSX prop spreads",
  },
  nestedComponents: {
    weight: 2,
    baseline: 0,
    label: "NestC",
    column: false,
    description: "Components defined inside another component",
  },
  maxNesting: {
    weight: 0,
    baseline: 0,
    label: "Nest",
    column: false,
    description: "Deepest control-flow or nested-function level",
  },
  maxFunctionLength: {
    weight: 0.05,
    baseline: 20,
    label: "FnLen",
    column: false,
    description: "Longest function, in lines",
  },
  maxProps: {
    weight: 0.15,
    baseline: 3,
    label: "Props",
    column: false,
    description: "Most props on a single component",
  },
  sloc: {
    weight: 0.015,
    baseline: 0,
    label: "SLOC",
    column: true,
    description: "Non-blank, non-comment lines",
  },
  loc: {
    weight: 0,
    baseline: 0,
    label: "LOC",
    column: false,
    description: "Physical lines",
  },
  imports: {
    weight: 0.2,
    baseline: 3,
    label: "Imp",
    column: false,
    description: "Imported bindings",
  },
  components: {
    weight: 0.75,
    baseline: 1,
    label: "Comp",
    column: false,
    description: "Components in the file (the first is free)",
  },
  functions: {
    weight: 0,
    baseline: 1,
    label: "Fns",
    column: false,
    description: "Function and method count",
  },
};

export const METRIC_KEYS = Object.keys(METRICS);

export const DEFAULT_WEIGHTS = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, METRICS[key].weight]),
);

export const DEFAULT_BASELINES = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, METRICS[key].baseline]),
);

export const DEFAULT_COLUMNS = [
  "rank",
  "score",
  "density",
  ...METRIC_KEYS.filter((key) => METRICS[key].column),
  "file",
];

export const COLUMN_LABELS = {
  rank: "#",
  score: "Score",
  density: "/100",
  file: "File",
  name: "Name",
  ...Object.fromEntries(METRIC_KEYS.map((key) => [key, METRICS[key].label])),
};

export const SORT_ALIASES = {
  complexity: "score",
  dens: "density",
  cogn: "cognitive",
  cyc: "cyclomatic",
  jsx: "jsxDepth",
  lines: "sloc",
  hook: "hooks",
  effect: "effects",
};

export const SPECIAL_SORTS = new Set(["score", "density", "file"]);

export const DEFAULT_NOTE_THRESHOLDS = {
  jsxDepth: 8,
  effects: 3,
  hooks: 8,
  cognitive: 20,
  maxFunctionLength: 80,
  nestedComponents: 1,
  inlineHandlers: 4,
  effectsWithoutDeps: 1,
  components: 4,
  conditionals: 6,
  spreads: 5,
};

export const DEFAULT_SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
  ".turbo",
  ".cache",
  "storybook-static",
];

export const DEFAULT_EXTENSIONS = [".jsx", ".tsx", ".js", ".ts"];

export const DEFAULT_REACT_PACKAGES = ["react", "react-dom", "preact"];

export const TEST_IGNORE = [
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/__tests__/**",
  "**/__mocks__/**",
];

export const STORY_IGNORE = [
  "**/*.stories.js",
  "**/*.stories.jsx",
  "**/*.stories.ts",
  "**/*.stories.tsx",
  "**/*.story.js",
  "**/*.story.jsx",
  "**/*.story.ts",
  "**/*.story.tsx",
];

export const ALWAYS_IGNORE = ["**/*.min.js"];

export function emptyMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
}

export function normalizeSort(sort) {
  if (!sort) return "score";
  const key = SORT_ALIASES[sort] || sort;
  if (!SPECIAL_SORTS.has(key) && !METRICS[key]) {
    throw new Error(`Unknown sort "${sort}". Use score, density, file, or a metric name.`);
  }
  return key;
}

export function suggestMetric(name) {
  const lower = String(name).toLowerCase();
  const exact = METRIC_KEYS.find((key) => key.toLowerCase() === lower);
  if (exact) return exact;
  const prefix = METRIC_KEYS.find((key) => key.toLowerCase().startsWith(lower));
  if (prefix) return prefix;
  let best = null;
  let bestScore = 3;
  for (const key of METRIC_KEYS) {
    const distance = levenshtein(lower, key.toLowerCase());
    if (distance < bestScore) {
      best = key;
      bestScore = distance;
    }
  }
  return bestScore <= 2 ? best : null;
}

function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}
