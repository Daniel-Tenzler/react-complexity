import path from "node:path";
import { COLUMN_LABELS, DEFAULT_WEIGHTS, METRICS, METRIC_KEYS } from "./schema.js";
import { round } from "./score.js";

export function formatReport(report, config) {
  if (config.format === "json") return formatJson(report, config);
  if (config.format === "csv") return formatCsv(report, config);
  if (config.format === "md") return formatMarkdown(report, config);
  if (config.format === "list") return formatList(report, config);
  if (report.explain) return formatExplanations(report, config);
  return formatTable(report, config);
}

export function formatExplanation(result, config) {
  const color = config.color;
  const name = relativeName(result, config);
  const lines = [];
  lines.push(paint(name, color, "\x1b[1m"));
  lines.push(
    `  score ${paint(formatNumber(result.score), color, scoreColor(result.score, config))}   density ${formatNumber(result.density)} / 100 lines   ${result.metrics.sloc} sloc   ${result.metrics.loc} loc`,
  );
  if (result.components?.length) lines.push(`  components: ${result.components.join(", ")}`);
  lines.push("");
  lines.push("  points    metric                raw   base   weight");
  const rows = Object.entries(result.breakdown)
    .filter(([, item]) => config.verbose || item.points > 0 || item.raw > 0)
    .sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]));
  for (const [key, item] of rows) {
    if (!config.verbose && item.points === 0 && item.weight === 0) continue;
    lines.push(
      `  ${formatPrecise(item.points).padStart(7)}   ${key.padEnd(20)} ${String(item.raw).padStart(4)} ${String(item.baseline).padStart(6)}   ${formatPrecise(item.weight).padStart(6)}   ${METRICS[key].description}`,
    );
  }
  if (result.metrics.hooks > 0) {
    lines.push("");
    lines.push(
      `  hooks ${result.metrics.hooks}: state ${result.metrics.stateHooks}, effect ${result.metrics.effects}, memo ${result.metrics.memoHooks}, custom ${result.metrics.customHooks}`,
    );
  }
  if (result.notes?.length) {
    lines.push("");
    lines.push("  notes:");
    for (const note of result.notes) lines.push(`    - ${note}`);
  }
  if (result.parseError) {
    lines.push("");
    lines.push(`  parse: ${result.parseError}`);
  }
  lines.push("");
  lines.push("  score = Σ max(0, raw - base) × weight");
  return lines.join("\n");
}

function formatExplanations(report, config) {
  const parts = report.shown.map((result) => formatExplanation(result, config));
  parts.push(footer(report, config));
  return parts.filter(Boolean).join("\n");
}

function formatTable(report, config) {
  const columns = tableColumns(config);
  const rows = report.shown.map((result, index) => rowValues(result, index + 1, columns, config));
  const header = columns.map((column) => COLUMN_LABELS[column] || column);
  const widths = header.map((label, index) => {
    const cellWidths = rows.map((row) => visibleLength(row[index]));
    return Math.max(label.length, ...cellWidths, 1);
  });
  const lines = [];
  lines.push(paintRow(header, widths, columns, null, config, true));
  if (rows.length === 0) {
    lines.push("No matching React files.");
    lines.push("Looks for .jsx .tsx .js .ts, and skips tests, stories, node_modules, and .gitignore.");
    lines.push("Pass a project path, or try --all-files, --include-tests, or --ext jsx,tsx.");
  } else {
    report.shown.forEach((result, index) => {
      lines.push(paintRow(rows[index], widths, columns, result, config, false));
    });
  }
  const foot = footer(report, config);
  if (foot) lines.push("", foot);
  if (report.errors?.length) {
    lines.push("", `Parse issues (${report.errors.length}):`);
    for (const error of report.errors) {
      lines.push(`  ${relativeName(error, config)}: ${error.parseError}`);
    }
  }
  return lines.join("\n");
}

function formatList(report, config) {
  return report.shown
    .map((result) => `${formatNumber(result.score)}\t${relativeName(result, config)}`)
    .join("\n");
}

function formatCsv(report, config) {
  const columns = outputColumns(config);
  const lines = [columns.join(",")];
  report.shown.forEach((result, index) => {
    lines.push(rowValues(result, index + 1, columns, config).map(csvEscape).join(","));
  });
  return lines.join("\n");
}

function formatMarkdown(report, config) {
  const columns = outputColumns(config);
  const header = columns.map((column) => COLUMN_LABELS[column] || column);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
    report.shown.forEach((result, index) => {
      lines.push(`| ${rowValues(result, index + 1, columns, config).map(mdEscape).join(" | ")} |`);
    });
  return lines.join("\n");
}

function formatJson(report, config) {
  const payload = {
    summary: {
      scanned: report.filesScanned,
      matched: report.total,
      shown: report.shown.length,
      errors: report.errors.length,
      sort: config.sort,
      by: config.by,
      config: config.configPath,
    },
    results: report.shown.map((result) => ({
      file: relativeName(result, config),
      absolutePath: result.file,
      name: result.name,
      kind: result.kind,
      score: result.score,
      density: result.density,
      drivers: result.drivers,
      metrics: result.metrics,
      breakdown: result.breakdown,
      components: result.components,
      notes: result.notes,
      parseError: result.parseError,
    })),
    errors: report.errors.map((error) => ({
      file: relativeName(error, config),
      parseError: error.parseError,
    })),
    failures: (report.failures || []).map((item) => ({
      file: relativeName(item, config),
      metric: item.failedOn,
      value: item.failedValue,
      limit: item.failedLimit,
    })),
    skipped: report.skipped || [],
  };
  return JSON.stringify(payload, null, config.compact ? 0 : 2);
}

function tableColumns(config) {
  const columns = config.columns?.length ? [...config.columns] : ["rank", "score", "density", "file"];
  if (!columns.includes("file")) columns.push("file");
  return columns;
}

function outputColumns(config) {
  const columns = config.columns?.length ? [...config.columns] : ["rank", "score", "density", "file"];
  if (!columns.includes("file")) columns.push("file");
  return columns;
}

function rowValues(result, rank, columns, config) {
  return columns.map((column) => {
    if (column === "rank") return String(rank);
    if (column === "file") return relativeName(result, config);
    if (column === "name") return result.name || "";
    if (column === "score") return formatNumber(result.score);
    if (column === "density") return formatNumber(result.density);
    if (METRIC_KEYS.includes(column)) return String(result.metrics?.[column] ?? 0);
    return "";
  });
}

function paintRow(cells, widths, columns, result, config, header) {
  const rendered = cells.map((cell, index) => {
    const width = widths[index];
    const text = columns[index] === "file" || header ? padEnd(cell, width) : padStart(cell, width);
    if (!header && columns[index] === "score" && config.color) {
      return paint(text, true, scoreColor(result.score, config));
    }
    if (header && config.color) return paint(text, true, "\x1b[2m");
    return text;
  });
  return rendered.join("  ");
}

function weightLabel(config) {
  const custom = METRIC_KEYS.some((key) => config.weights?.[key] !== DEFAULT_WEIGHTS[key]);
  return custom ? "custom weights" : "default weights";
}

function footer(report, config) {
  if (config.quiet) return "";
  const bits = [
    `${report.total} match${report.total === 1 ? "" : "es"}`,
    `${report.filesScanned} scanned`,
    `sort ${config.sort}`,
    config.by === "component" ? "by component" : null,
    config.configPath ? `config ${path.relative(config.cwd, config.configPath) || config.configPath}` : weightLabel(config),
  ].filter(Boolean);
  return bits.join(" · ");
}

export function relativeName(result, cwdOrConfig) {
  const cwd = typeof cwdOrConfig === "string" ? cwdOrConfig : cwdOrConfig.cwd;
  const base = typeof cwdOrConfig === "string" ? cwd : cwdOrConfig.displayRoot || cwd;
  const file = result.file ? path.relative(base, result.file) || path.basename(result.file) : result.file;
  const shown = file.startsWith("..") ? result.file : file;
  return result.name ? `${shown}:${result.name}` : shown;
}

export function formatNumber(value) {
  const number = round(Number(value) || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function formatPrecise(value) {
  return String(round(Number(value) || 0, 3));
}

function scoreColor(score, config) {
  if (score >= (config.thresholds?.high ?? 80)) return "\x1b[31m";
  if (score >= (config.thresholds?.medium ?? 40)) return "\x1b[33m";
  return "\x1b[32m";
}

function paint(text, enabled, code) {
  if (!enabled) return text;
  return `${code}${text}\x1b[0m`;
}

function padStart(text, width) {
  const value = String(text);
  return " ".repeat(Math.max(0, width - visibleLength(value))) + value;
}

function padEnd(text, width) {
  const value = String(text);
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function mdEscape(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function helpText() {
  const metricLines = METRIC_KEYS.map((key) => {
    const meta = METRICS[key];
    return `  ${key.padEnd(22)} weight ${String(meta.weight).padStart(4)}   base ${String(meta.baseline).padStart(2)}   ${meta.description}`;
  });
  return `react-complexity — rank JSX/React files by complexity

Usage:
  node bin/react-complexity.js [paths...]
  npm start -- [paths...]
  react-complexity [paths...] [options]

Score:
  Parses each file with Babel and scores an AST, not a text heuristic.
  score   = Σ max(0, metric - baseline) × weight
  density = score / sloc × 100

  cognitive follows SonarSource: control-flow breaks add 1, plus the nesting
  level. else / else-if add 1 with no nesting bonus. Nested functions increase
  nesting. A run of the same &&, ||, or ?? operator adds 1, not 1 per operator.
  effects are an extra penalty on top of hooks.

  A single file prints a breakdown. A directory prints a ranked table.
  Pass a path to scan a repo other than the current directory.

Examples:
  react-complexity
  react-complexity src --top 10
  react-complexity src --sort density
  react-complexity src/App.tsx
  react-complexity src --weight jsxDepth=4 --weight sloc=0
  react-complexity src --replace-weights --weight cognitive=1
  react-complexity src --format json > report.json
  react-complexity --init
  react-complexity src --max-score 80 --quiet

Options:
  -c, --config <file>       Config file (mjs, js, cjs, json)
  -t, --top <n>             Rows to show (default 25, 0 = all)
  -s, --sort <metric>       score, density, file, or any metric
  -r, --reverse             Low to high
  -f, --format <fmt>        table, json, csv, md, list
  -e, --explain             Breakdown for each shown row
      --ext <list>          Extensions, comma-separated (default jsx,tsx,js,ts)
      --ignore <pattern>    Extra gitignore-style pattern (repeatable)
      --include-tests       Include test and spec files
      --include-stories     Include story files
      --all-files           Include files with no JSX, hooks, or React import
      --no-gitignore        Do not read .gitignore
      --weight <k=v>        Override a weight (repeatable or comma-separated)
      --baseline <k=v>      Override a baseline
      --replace-weights     Start weights at 0, then apply --weight
      --columns <list>      Table columns
      --by <file|component> Rank files, or top-level components (nested ones count toward the parent)
      --min-score <n>       Hide rows below this score
      --max-score <n>       Exit 1 if any file's score is higher
      --fail-on <k=v>       Exit 1 if a metric exceeds a value
      --init [file]         Write a config template (default react-complexity.config.mjs)
      --show-config         Print the resolved config and exit
      --strict              Exit 1 on parse errors
      --compact             Minified JSON
      --no-color            Disable color
  -q, --quiet               Hide the summary footer
  -v, --verbose             Show zero-weight metrics in breakdowns
  -h, --help                Show this help

Metrics:
${metricLines.join("\n")}

Config:
  Searches the scan target, then the current directory, for
  react-complexity.config.mjs/.js/.cjs/.json, .react-complexity.json,
  or package.json "reactComplexity".
  Partial weights merge into the defaults. --replace-weights disables that.
  node_modules and .git are never descended into.
`;
}
