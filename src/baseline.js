import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ignorePatterns } from "./config.js";
import { round } from "./score.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const parserVersion = require("@babel/parser/package.json").version;
const typesVersion = require("@babel/types/package.json").version;
export const BASELINE_VERSION = 1;
// Bump when measurement/scoring semantics change, even without a package release.
const ANALYSIS_VERSION = 1;
const SETTINGS = [
  "by", "weights", "baselines", "countLogical", "countNullish", "hookPattern",
  "reactPackages", "babelPlugins", "extensions", "includeTests", "includeStories",
  "useGitignore", "allFiles", "skipDirs", "maxFileBytes",
];

function relativePath(file, cwd) {
  return (path.relative(cwd, path.resolve(cwd, file)) || ".").split(path.sep).join("/");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function key(entry) {
  return JSON.stringify([entry.file, entry.kind, entry.name]);
}

function assertComplete(report) {
  if (report.errors?.length || report.skipped?.length || report.results.some((item) => item.parseError || item.partial)) {
    const issue = report.errors?.[0] || report.skipped?.[0] || report.results.find((item) => item.parseError || item.partial);
    const detail = issue ? ` ${issue.file || "Input"}: ${issue.parseError || issue.reason || "partial analysis"}.` : "";
    throw new Error(`Cannot save or compare a baseline from an incomplete scan.${detail} Fix parse/read errors and skipped paths first.`);
  }
}

export function createBaseline(report, config, paths = ["."]) {
  assertComplete(report);
  const baseline = {
    schemaVersion: BASELINE_VERSION,
    tool: { name: pkg.name, version: pkg.version, analysisVersion: ANALYSIS_VERSION, parserVersion, typesVersion },
    settings: canonical({
      ...Object.fromEntries(SETTINGS.map((name) => [name, config[name]])),
      ignore: ignorePatterns(config),
      paths: [...new Set((paths.length ? paths : ["."]).map((file) => relativePath(file, config.cwd)))].sort(),
    }),
    entries: report.results.map((item) => ({
      file: relativePath(item.file, config.cwd),
      name: item.name ?? null,
      kind: item.kind,
      score: item.score,
    })).sort((a, b) => key(a).localeCompare(key(b))),
  };
  validateBaseline(baseline);
  return baseline;
}

export function validateBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== BASELINE_VERSION) {
    throw new Error(`Unsupported baseline schema version. Expected ${BASELINE_VERSION}; regenerate the baseline.`);
  }
  if (baseline.tool?.name !== pkg.name || typeof baseline.tool.version !== "string" ||
      typeof baseline.tool.parserVersion !== "string" || typeof baseline.tool.typesVersion !== "string" ||
      !Number.isInteger(baseline.tool.analysisVersion) || !baseline.settings ||
      typeof baseline.settings !== "object" || Array.isArray(baseline.settings) || !Array.isArray(baseline.entries)) {
    throw new Error("Invalid baseline: expected tool metadata, settings, and entries.");
  }
  const seen = new Set();
  for (const entry of baseline.entries) {
    if (!entry || typeof entry.file !== "string" || !entry.file || entry.file.includes("\\") ||
        path.posix.isAbsolute(entry.file) || /^[a-z]:/i.test(entry.file) ||
        path.posix.normalize(entry.file) !== entry.file ||
        !["file", "component", "module"].includes(entry.kind) ||
        !(entry.name === null || (typeof entry.name === "string" && entry.name.length > 0)) ||
        !Number.isFinite(entry.score)) {
      throw new Error("Invalid baseline entry: expected a relative POSIX path, kind, name, and finite score.");
    }
    if (seen.has(key(entry))) throw new Error(`Duplicate baseline entry: ${entry.file}${entry.name ? `:${entry.name}` : ""}`);
    seen.add(key(entry));
  }
  return baseline;
}

export async function readBaseline(filename) {
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    throw new Error(`Cannot read baseline ${filename}: ${error.message}`);
  }
  let baseline;
  try {
    baseline = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid baseline JSON in ${filename}: ${error.message}`);
  }
  return validateBaseline(baseline);
}

export async function writeBaseline(filename, baseline, { force = false } = {}) {
  validateBaseline(baseline);
  try {
    await writeFile(filename, `${JSON.stringify(baseline, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Refusing to overwrite baseline ${filename}. Pass --force to replace it.`);
    throw new Error(`Cannot write baseline ${filename}: ${error.message}`);
  }
}

export function compareBaseline(baseline, current, tolerance = 0) {
  validateBaseline(baseline);
  validateBaseline(current);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("baselineTolerance must be a non-negative finite number.");
  if (JSON.stringify(canonical(baseline.tool)) !== JSON.stringify(canonical(current.tool))) {
    throw new Error("Baseline analyzer version differs. Review the tool upgrade and regenerate the baseline.");
  }
  const settings = new Set([...Object.keys(baseline.settings), ...Object.keys(current.settings)]);
  const changed = [...settings].filter((name) => JSON.stringify(canonical(baseline.settings[name])) !== JSON.stringify(canonical(current.settings[name])));
  if (changed.length) {
    throw new Error(`Baseline settings differ: ${changed.join(", ")}. Use the same scoring/scan settings or regenerate the baseline.`);
  }
  const previous = new Map(baseline.entries.map((item) => [key(item), item]));
  const changes = [];
  const summary = { new: 0, worsened: 0, improved: 0, removed: 0, unchanged: 0, regressions: 0 };
  for (const entry of current.entries) {
    const before = previous.get(key(entry));
    previous.delete(key(entry));
    const delta = round(entry.score - (before?.score ?? 0));
    const status = !before ? "new" : delta > 0 ? "worsened" : delta < 0 ? "improved" : "unchanged";
    summary[status] += 1;
    if (status === "unchanged") continue;
    const regression = delta > tolerance;
    if (regression) summary.regressions += 1;
    changes.push({ ...entry, status, previousScore: before?.score ?? null, currentScore: entry.score, delta, regression });
  }
  for (const entry of previous.values()) {
    summary.removed += 1;
    changes.push({ ...entry, status: "removed", previousScore: entry.score, currentScore: null, delta: round(-entry.score), regression: false });
  }
  changes.sort((a, b) => Number(b.regression) - Number(a.regression) || b.delta - a.delta || key(a).localeCompare(key(b)));
  return { tolerance, summary, changes };
}

// Shared CLI/library workflow: baseline comparisons always use unfiltered results.
export async function baselineReport(report, config, paths, options = {}) {
  for (const name of ["saveBaseline", "compareBaseline"]) {
    if (options[name] !== undefined && (typeof options[name] !== "string" || !options[name].trim())) {
      throw new Error(`${name} must be a non-empty file path.`);
    }
  }
  if (options.saveBaseline && options.compareBaseline) throw new Error("Use --save-baseline or --compare-baseline, not both.");
  if (options.baselineTolerance !== undefined && !options.compareBaseline) throw new Error("--baseline-tolerance requires --compare-baseline.");
  if (!options.saveBaseline && !options.compareBaseline) return {};
  const current = createBaseline(report, config, paths);
  if (options.compareBaseline) {
    const filename = path.resolve(config.cwd, options.compareBaseline);
    return { comparison: { file: relativePath(filename, config.cwd), ...compareBaseline(await readBaseline(filename), current, options.baselineTolerance ?? 0) } };
  }
  const filename = path.resolve(config.cwd, options.saveBaseline);
  if (report.results.some((item) => path.resolve(item.file) === filename)) {
    throw new Error("Refusing to overwrite an analyzed source file with a baseline.");
  }
  await writeBaseline(filename, current, { force: options.force });
  return { baselineSaved: relativePath(filename, config.cwd) };
}
