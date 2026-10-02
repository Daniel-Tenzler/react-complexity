import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, renderConfigJson, renderConfigTemplate, parseAssignments } from "./config.js";
import { analyzePaths, failures, rankResults } from "./scan.js";
import { formatExplanation, formatReport, helpText, relativeName } from "./format.js";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

const ALIASES = {
  c: "config",
  t: "top",
  s: "sort",
  f: "format",
  e: "explain",
  r: "reverse",
  q: "quiet",
  v: "verbose",
  h: "help",
};

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const cwd = io.cwd || process.cwd();
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
  if (parsed.help) {
    stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (parsed.version) {
    stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (parsed.init) {
    const target = path.resolve(cwd, parsed.initPath || parsed.positionals[0] || "react-complexity.config.mjs");
    if (existsSync(target) && !parsed.force) {
      stderr.write(`Refusing to overwrite ${target}. Pass --force to replace it.\n`);
      return 1;
    }
    const body = target.endsWith(".json") ? renderConfigJson() : renderConfigTemplate();
    writeFileSync(target, body);
    stdout.write(`Wrote ${target}\n`);
    return 0;
  }

  try {
    const cli = toCli(parsed);
    const config = await resolveConfig({
      cwd,
      paths: parsed.positionals,
      cli,
      configPath: parsed.config || null,
    });
    const machine = ["json", "csv", "md", "list"].includes(config.format);
    const tty = Boolean(stdout.isTTY);
    if (machine || parsed.noColor || process.env.NO_COLOR !== undefined || (!parsed.color && !tty)) config.color = false;
    if (parsed.color && !machine) config.color = true;
    config.displayRoot = displayRootFor(parsed.positionals.length ? parsed.positionals : ["."], cwd);
    if (parsed.showConfig) {
      stdout.write(`${JSON.stringify(publicConfig(config), null, 2)}\n`);
      return 0;
    }

    const paths = parsed.positionals.length ? parsed.positionals : ["."];
    const oneFile = paths.length === 1 && isFile(path.resolve(cwd, paths[0]));
    const explain = parsed.explain || (oneFile && !parsed.format && config.format === "table");
    const progress =
      !config.quiet && stderr.isTTY && config.format !== "json"
        ? (index, total) => stderr.write(`\rScanning ${index}/${total}`)
        : null;
    const analyzed = await analyzePaths(paths, config, progress);
    if (progress) stderr.write("\r\x1b[K");
    const ranked = rankResults(analyzed.results, config);
    const failed = failures(analyzed.results, config.failOn);
    const report = {
      ...analyzed,
      ...ranked,
      failures: failed,
      explain,
    };
    if (explain && config.format === "table") {
      if (ranked.shown.length === 0 && analyzed.errors.length === 0) stdout.write("No matching React files.\n");
      else stdout.write(`${ranked.shown.map((result) => formatExplanation(result, config)).join("\n")}\n`);
      if (!config.quiet && !(ranked.shown.length === 0 && analyzed.errors.length)) {
        stdout.write(`${ranked.total} match${ranked.total === 1 ? "" : "es"} · ${analyzed.filesScanned} scanned\n`);
      }
    } else {
      const text = formatReport(report, config);
      if (text) stdout.write(`${text}\n`);
    }
    printProblems(stderr, report, config);
    if (oneFile && analyzed.errors.length && ranked.shown.length === 0) return 1;
    if ((analyzed.errors.length && config.strict) || failed.length) return 1;
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function printProblems(stderr, analyzed, config) {
  for (const item of analyzed.skipped || []) {
    stderr.write(`Skipped ${item.file}: ${item.reason}\n`);
  }
  for (const error of analyzed.errors || []) {
    stderr.write(`${relativeName(error, config)}: ${error.parseError}\n`);
  }
  for (const item of analyzed.failures || []) {
    stderr.write(`Failed ${item.failedValue} ${item.failedOn} > ${item.failedLimit}  ${relativeName(item, config)}\n`);
  }
}

function toCli(parsed) {
  return {
    weights: parseAssignments(parsed.weight),
    baselines: parseAssignments(parsed.baseline),
    failOn: parseAssignments(parsed.failOn),
    ext: parsed.ext,
    ignore: parsed.ignore,
    columns: parsed.columns,
    sort: parsed.sort,
    top: parsed.top,
    minScore: parsed.minScore,
    maxScore: parsed.maxScore,
    format: parsed.format,
    by: parsed.by,
    includeTests: parsed.includeTests,
    includeStories: parsed.includeStories,
    allFiles: parsed.allFiles,
    noGitignore: parsed.noGitignore,
    reverse: parsed.reverse,
    quiet: parsed.quiet,
    verbose: parsed.verbose,
    compact: parsed.compact,
    strict: parsed.strict,
    noColor: parsed.noColor,
    color: parsed.color,
    replaceWeights: parsed.replaceWeights,
  };
}

function publicConfig(config) {
  return {
    configPath: config.configPath,
    extensions: config.extensions,
    ignore: config.ignore,
    includeTests: config.includeTests,
    includeStories: config.includeStories,
    useGitignore: config.useGitignore,
    allFiles: config.allFiles,
    skipDirs: config.skipDirs,
    sort: config.sort,
    reverse: config.reverse,
    top: config.top,
    minScore: config.minScore,
    format: config.format,
    columns: config.columns,
    by: config.by,
    failOn: config.failOn,
    thresholds: config.thresholds,
    countLogical: config.countLogical,
    countNullish: config.countNullish,
    hookPattern: config.hookPattern,
    replaceWeights: config.replaceWeights,
    weights: config.weights,
    baselines: config.baselines,
  };
}

function displayRootFor(paths, cwd) {
  const abs = paths.map((entry) => path.resolve(cwd, entry));
  const inside = abs.every((entry) => entry === cwd || entry.startsWith(`${cwd}${path.sep}`));
  if (inside) return cwd;
  if (abs.length === 1) {
    try {
      return statSync(abs[0]).isDirectory() ? abs[0] : path.dirname(abs[0]);
    } catch {
      return cwd;
    }
  }
  return cwd;
}

function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

export function parseArgv(argv) {
  const parsed = {
    positionals: [],
    ignore: [],
    weight: [],
    baseline: [],
    failOn: [],
    ext: [],
    columns: [],
  };
  const multi = new Set(["ignore", "weight", "baseline", "failOn", "ext", "columns"]);
  const numbers = new Set(["top", "minScore", "maxScore"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      parsed.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const name = ALIASES[rawName] || kebab(rawName);
    if (!isKnown(name)) throw new Error(`Unknown option --${rawName}. Run --help for options.`);
    if (isBoolean(name)) {
      if (name === "init" && inline !== undefined) {
        parsed.init = true;
        parsed.initPath = inline;
        continue;
      }
      if (inline === "false" || inline === "0") parsed[name] = false;
      else parsed[name] = true;
      continue;
    }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`Option --${rawName} needs a value`);
    }
    if (numbers.has(name)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Option --${rawName} must be a number`);
      parsed[name] = number;
      continue;
    }
    if (multi.has(name)) parsed[name].push(value);
    else parsed[name] = value;
  }
  return parsed;
}

function isBoolean(name) {
  return new Set([
    "help",
    "version",
    "explain",
    "reverse",
    "quiet",
    "verbose",
    "init",
    "force",
    "showConfig",
    "includeTests",
    "includeStories",
    "allFiles",
    "noGitignore",
    "replaceWeights",
    "compact",
    "strict",
    "noColor",
    "color",
  ]).has(name);
}

function isKnown(name) {
  return (
    isBoolean(name) ||
    new Set([
      "config",
      "top",
      "sort",
      "format",
      "ext",
      "ignore",
      "weight",
      "baseline",
      "columns",
      "by",
      "minScore",
      "maxScore",
      "failOn",
    ]).has(name)
  );
}

function kebab(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
