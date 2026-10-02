import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  ALWAYS_IGNORE,
  DEFAULT_BASELINES,
  DEFAULT_COLUMNS,
  DEFAULT_EXTENSIONS,
  DEFAULT_NOTE_THRESHOLDS,
  DEFAULT_REACT_PACKAGES,
  DEFAULT_SKIP_DIRS,
  DEFAULT_WEIGHTS,
  COLUMN_LABELS,
  METRICS,
  METRIC_KEYS,
  STORY_IGNORE,
  TEST_IGNORE,
  normalizeSort,
  suggestMetric,
} from "./schema.js";

const require = createRequire(import.meta.url);

export const CONFIG_FILES = [
  "react-complexity.config.mjs",
  "react-complexity.config.js",
  "react-complexity.config.cjs",
  "react-complexity.config.json",
  ".react-complexity.json",
];

const DEFAULT_THRESHOLDS = { medium: 40, high: 80 };

export function defaults() {
  return {
    extensions: [...DEFAULT_EXTENSIONS],
    ignore: [],
    includeTests: false,
    includeStories: false,
    useGitignore: true,
    allFiles: false,
    skipDirs: [...DEFAULT_SKIP_DIRS],
    maxFileBytes: 1_000_000,
    countLogical: true,
    countNullish: true,
    hookPattern: "^use[A-Z]",
    reactPackages: [...DEFAULT_REACT_PACKAGES],
    babelPlugins: [],
    weights: { ...DEFAULT_WEIGHTS },
    baselines: { ...DEFAULT_BASELINES },
    replaceWeights: false,
    sort: "score",
    reverse: false,
    top: 25,
    minScore: 0,
    format: "table",
    columns: [...DEFAULT_COLUMNS],
    by: "file",
    color: process.stdout.isTTY && !process.env.NO_COLOR,
    quiet: false,
    verbose: false,
    compact: false,
    failOn: {},
    thresholds: { ...DEFAULT_THRESHOLDS },
    noteThresholds: { ...DEFAULT_NOTE_THRESHOLDS },
    strict: false,
  };
}

export async function resolveConfig({ cwd = process.cwd(), paths = [], cli = {}, configPath = null } = {}) {
  const found = configPath ? path.resolve(cwd, configPath) : findConfigFile(cwd, paths);
  const fileConfig = found ? await loadConfigFile(found) : {};
  assertKnownConfig(fileConfig);
  const merged = mergeConfig(defaults(), fileConfig);
  const resolved = applyCli(merged, cli, fileConfig);
  resolved.configPath = found;
  resolved.cwd = cwd;
  resolved.sort = normalizeSort(resolved.sort);
  validateNumbers(resolved.weights, "weight");
  validateNumbers(resolved.baselines, "baseline");
  if (!["table", "json", "csv", "md", "list"].includes(resolved.format)) {
    throw new Error(`Unknown format "${resolved.format}". Use table, json, csv, md, or list.`);
  }
  if (!["file", "component"].includes(resolved.by)) {
    throw new Error(`Unknown --by "${resolved.by}". Use file or component.`);
  }
  if (!Number.isInteger(resolved.top) || resolved.top < 0) {
    throw new Error("--top must be a non-negative integer (0 shows every file).");
  }
  try {
    RegExp(resolved.hookPattern);
  } catch (error) {
    throw new Error(`Invalid hookPattern: ${error.message}`);
  }
  const knownColumns = new Set([...Object.keys(COLUMN_LABELS), ...METRIC_KEYS]);
  for (const column of resolved.columns) {
    if (!knownColumns.has(column)) {
      const suggestion = suggestMetric(column);
      throw new Error(`Unknown column "${column}"${suggestion ? `. Did you mean "${suggestion}"?` : ""}.`);
    }
  }
  return resolved;
}

export function mergeConfig(base, override) {
  const next = {
    ...base,
    ...clean(override),
    weights: base.replaceWeights || override.replaceWeights
      ? zeroWeights()
      : { ...base.weights },
    baselines: { ...base.baselines },
    failOn: { ...(base.failOn || {}) },
    thresholds: { ...(base.thresholds || {}) },
    noteThresholds: { ...(base.noteThresholds || {}) },
  };
  if (override.weights) next.weights = { ...next.weights, ...normalizeMetricMap(override.weights, "weight") };
  if (override.baselines) next.baselines = { ...next.baselines, ...normalizeMetricMap(override.baselines, "baseline") };
  if (override.failOn) next.failOn = { ...next.failOn, ...normalizeFailOn(override.failOn) };
  if (override.thresholds) next.thresholds = { ...next.thresholds, ...override.thresholds };
  if (override.noteThresholds) next.noteThresholds = { ...next.noteThresholds, ...override.noteThresholds };
  if (override.extensions) next.extensions = normalizeExtensions(override.extensions);
  if (override.ignore) next.ignore = asArray(override.ignore);
  if (override.columns) next.columns = asArray(override.columns);
  if (override.skipDirs) next.skipDirs = asArray(override.skipDirs);
  if (override.reactPackages) next.reactPackages = asArray(override.reactPackages);
  if (override.babelPlugins) next.babelPlugins = asArray(override.babelPlugins);
  if (override.replaceWeights) next.replaceWeights = true;
  return next;
}

export function applyCli(config, cli, fileConfig = {}) {
  const next = {
    ...config,
    weights: { ...config.weights },
    baselines: { ...config.baselines },
    failOn: { ...(config.failOn || {}) },
    thresholds: { ...(config.thresholds || {}) },
    noteThresholds: { ...(config.noteThresholds || {}) },
    ignore: [...(config.ignore || [])],
    extensions: [...(config.extensions || [])],
    columns: [...(config.columns || [])],
    skipDirs: [...(config.skipDirs || [])],
  };
  if (cli.replaceWeights) {
    next.replaceWeights = true;
    next.weights = {
      ...zeroWeights(),
      ...normalizeMetricMap(fileConfig.weights || {}, "weight"),
    };
  }
  if (cli.weights) next.weights = { ...next.weights, ...normalizeMetricMap(cli.weights, "weight") };
  if (cli.baselines) next.baselines = { ...next.baselines, ...normalizeMetricMap(cli.baselines, "baseline") };
  if (cli.failOn) next.failOn = { ...next.failOn, ...normalizeFailOn(cli.failOn) };
  if (cli.ext?.length || cli.extensions) next.extensions = normalizeExtensions(cli.ext?.length ? cli.ext : cli.extensions);
  if (cli.ignore) next.ignore = [...next.ignore, ...asArray(cli.ignore)];
  if (cli.columns?.length) next.columns = asArray(cli.columns);
  if (cli.sort) next.sort = cli.sort;
  if (cli.top !== undefined) next.top = cli.top;
  if (cli.minScore !== undefined) next.minScore = cli.minScore;
  if (cli.maxScore !== undefined) next.failOn = { ...next.failOn, score: cli.maxScore };
  if (cli.format) next.format = cli.format;
  if (cli.by) next.by = cli.by;
  if (cli.includeTests) next.includeTests = true;
  if (cli.includeStories) next.includeStories = true;
  if (cli.allFiles) next.allFiles = true;
  if (cli.noGitignore || cli.useGitignore === false) next.useGitignore = false;
  if (cli.useGitignore === true) next.useGitignore = true;
  if (cli.reverse) next.reverse = true;
  if (cli.quiet) next.quiet = true;
  if (cli.verbose) next.verbose = true;
  if (cli.compact) next.compact = true;
  if (cli.strict) next.strict = true;
  if (cli.noColor || process.env.NO_COLOR !== undefined) next.color = false;
  if (cli.color) next.color = true;
  return next;
}

export function ignorePatterns(config) {
  const patterns = [...ALWAYS_IGNORE];
  if (!config.includeTests) patterns.push(...TEST_IGNORE);
  if (!config.includeStories) patterns.push(...STORY_IGNORE);
  patterns.push(...(config.ignore || []));
  return patterns;
}

export async function loadConfigFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`Config not found: ${filePath}`);
  const ext = path.extname(filePath);
  if (ext === ".json" || filePath.endsWith(".json")) {
    return parseJsonConfig(readFileSync(filePath, "utf8"), filePath);
  }
  if (ext === ".cjs") {
    const loaded = require(filePath);
    return loaded.default ?? loaded;
  }
  try {
    const loaded = await import(pathToFileURL(filePath).href);
    return loaded.default ?? loaded;
  } catch (error) {
    if (ext === ".js") {
      try {
        const loaded = require(filePath);
        return loaded.default ?? loaded;
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

export function findConfigFile(cwd, paths = []) {
  const dirs = [];
  for (const entry of paths) {
    const abs = path.resolve(cwd, entry);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    dirs.push(...ancestorsUntilGit(stat.isDirectory() ? abs : path.dirname(abs)));
  }
  dirs.push(...ancestorsUntilGit(cwd));
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of CONFIG_FILES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const pkgPath = path.join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(stripJsonComments(readFileSync(pkgPath, "utf8")));
      if (pkg.reactComplexity && typeof pkg.reactComplexity === "object") return pkgPath;
    } catch {
      continue;
    }
  }
  return null;
}

function ancestorsUntilGit(start) {
  const chain = [start];
  let dir = start;
  if (existsSync(path.join(dir, ".git"))) return chain;
  for (let i = 0; i < 16; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    chain.push(dir);
    if (existsSync(path.join(dir, ".git"))) return chain;
  }
  return [start];
}

const KNOWN_CONFIG_KEYS = new Set([
  "extensions",
  "ignore",
  "includeTests",
  "includeStories",
  "useGitignore",
  "allFiles",
  "skipDirs",
  "maxFileBytes",
  "countLogical",
  "countNullish",
  "hookPattern",
  "reactPackages",
  "babelPlugins",
  "weights",
  "baselines",
  "replaceWeights",
  "sort",
  "reverse",
  "top",
  "minScore",
  "format",
  "columns",
  "by",
  "color",
  "quiet",
  "verbose",
  "compact",
  "failOn",
  "thresholds",
  "noteThresholds",
  "strict",
  "$schema",
]);

function assertKnownConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) throw new Error(`Unknown config key "${key}". Run --help for options.`);
  }
}

export function renderConfigTemplate() {
  const weightLines = METRIC_KEYS.map((key) => {
    const meta = METRICS[key];
    return `    // ${meta.description}\n    ${key}: ${meta.weight},`;
  }).join("\n");
  const baselineLines = METRIC_KEYS.filter((key) => METRICS[key].baseline !== 0)
    .map((key) => `    ${key}: ${METRICS[key].baseline},`)
    .join("\n");
  return `// react-complexity configuration.
// score = sum of max(0, metric - baseline) * weight
// density = score / sloc * 100
// CLI flags override this file. Unknown metric names are errors.
// Set replaceWeights: true to start from zero instead of merging defaults.

export default {
  extensions: ${JSON.stringify(DEFAULT_EXTENSIONS)},
  ignore: [],
  includeTests: false,
  includeStories: false,
  useGitignore: true,
  allFiles: false,
  sort: "score",
  top: 25,
  format: "table",
  by: "file",
  minScore: 0,
  failOn: {},
  thresholds: { "medium": 40, "high": 80 },
  countLogical: true,
  countNullish: true,
  hookPattern: "^use[A-Z]",
  replaceWeights: false,
  weights: {
${weightLines}
  },
  baselines: {
${baselineLines}
  },
};
`;
}

function parseJsonConfig(text, filePath) {
  try {
    const value = JSON.parse(stripJsonComments(text));
    if (path.basename(filePath) === "package.json") return value.reactComplexity || {};
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function stripJsonComments(text) {
  return text.replace(/\\"|"(?:\\.|[^"\\])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => (comment ? "" : match));
}

function clean(override) {
  const next = {};
  for (const [key, value] of Object.entries(override || {})) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function zeroWeights() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
}

export function normalizeMetricMap(map, label) {
  const next = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (!METRICS[key]) {
      const suggestion = suggestMetric(key);
      throw new Error(
        `Unknown ${label} "${key}"${suggestion ? `. Did you mean "${suggestion}"?` : ""}. Run --help for metric names.`,
      );
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} ${key} must be a number`);
    next[key] = number;
  }
  return next;
}

function normalizeFailOn(map) {
  const next = {};
  for (const [key, value] of Object.entries(map || {})) {
    if (key !== "score" && key !== "density" && !METRICS[key]) {
      const suggestion = suggestMetric(key);
      throw new Error(`Unknown fail-on metric "${key}"${suggestion ? `. Did you mean "${suggestion}"?` : ""}.`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`fail-on ${key} must be a number`);
    next[key] = number;
  }
  return next;
}

function validateNumbers(map, label) {
  for (const [key, value] of Object.entries(map)) {
    if (!Number.isFinite(value)) throw new Error(`${label} ${key} must be a number`);
  }
}

export function normalizeExtensions(value) {
  return asArray(value).map((ext) => {
    const text = String(ext).trim();
    if (!text) return text;
    return text.startsWith(".") ? text : `.${text}`;
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAssignments(values) {
  const map = {};
  for (const value of values || []) {
    for (const part of String(value).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) throw new Error(`Expected name=value, got "${trimmed}"`);
      const name = trimmed.slice(0, index).trim();
      const raw = trimmed.slice(index + 1).trim();
      const number = Number(raw);
      if (raw === "" || !Number.isFinite(number)) throw new Error(`Expected a number for ${name}, got "${raw}"`);
      map[name] = number;
    }
  }
  return map;
}

export function renderConfigJson() {
  const baselines = Object.fromEntries(
    Object.entries(DEFAULT_BASELINES).filter(([, value]) => value !== 0),
  );
  return `${JSON.stringify({
    extensions: DEFAULT_EXTENSIONS,
    ignore: [],
    sort: "score",
    top: 25,
    format: "table",
    by: "file",
    weights: DEFAULT_WEIGHTS,
    baselines,
  }, null, 2)}\n`;
}
