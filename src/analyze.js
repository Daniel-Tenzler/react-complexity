import { parse } from "@babel/parser";
import { measure, calleeName, containsJSX, isFunctionNode, unwrapExpression } from "./complexity.js";
import { emptyMetrics, DEFAULT_NOTE_THRESHOLDS, DEFAULT_REACT_PACKAGES } from "./schema.js";
import { scoreMetrics } from "./score.js";

const WRAPPERS = new Set(["memo", "forwardRef", "lazy", "observer", "connect"]);
const BASE_PLUGINS = ["jsx", "typescript"];

export function analyzeSource(code, filename = "input.jsx", options = {}) {
  const parsed = parseSource(code, filename, options);
  if (parsed.error) {
    return resultFrom(filename, emptyMetrics(), options, {
      parseError: parsed.error,
      components: [],
      react: false,
      notes: [],
    });
  }

  let metrics;
  const findings = [];
  const sources = {};
  try {
    metrics = measure(parsed.ast.program, analysisOptions(options, parsed.ast.program, findings, sources));
  } catch (error) {
    const message = error instanceof RangeError ? "File is too deeply nested to analyze" : error.message;
    return resultFrom(filename, emptyMetrics(), options, {
      parseError: message,
      components: [],
      react: false,
      notes: [],
    });
  }

  const size = countSloc(code, parsed.ast.comments, 1, lineCount(code));
  metrics.loc = size.loc;
  metrics.sloc = size.sloc;
  const components = findComponents(parsed.ast);
  metrics.components = components.length;
  for (const component of components) recordSource(sources, "components", 1, component.node);
  recordSizeSources(sources, code, parsed.ast.comments, 1, lineCount(code));
  const react = isReact(parsed.ast, metrics, options);
  const notes = buildNotes(metrics, options.noteThresholds);
  const parseError = parsed.recovered ? parsed.recovered : null;
  if (parseError) notes.unshift("Parse recovered with errors; score may be incomplete");
  return resultFrom(filename, metrics, options, {
    parseError,
    components: components.map((item) => item.name),
    react,
    notes,
    partial: Boolean(parsed.recovered),
    findings: sourceFindings(findings, code),
    metricSources: sourceMetrics(sources, code),
  });
}

export function analyzeComponents(code, filename = "input.jsx", options = {}) {
  const fileResult = analyzeSource(code, filename, options);
  if (fileResult.parseError && !fileResult.partial) return [fileResult];
  const parsed = parseSource(code, filename, options);
  if (parsed.error) return [fileResult];
  const units = findComponents(parsed.ast);
  if (units.length === 0) return [{ ...fileResult, name: null, kind: "file" }];

  const componentResults = units.map((unit) => {
    let metrics;
    const findings = [];
    const sources = {};
    try {
      metrics = measure(unit.node, analysisOptions(options, parsed.ast.program, findings, sources));
    } catch (error) {
      return {
        ...fileResult,
        name: unit.name,
        kind: "component",
        parseError: error.message,
        partial: false,
        findings: [],
        metricSources: {},
      };
    }
    const start = unit.node.loc?.start.line ?? 1;
    const end = unit.node.loc?.end.line ?? start;
    const size = countSloc(code, parsed.ast.comments, start, end);
    metrics.loc = size.loc;
    metrics.sloc = size.sloc;
    metrics.components = 1;
    recordSource(sources, "components", 1, unit.node);
    recordSizeSources(sources, code, parsed.ast.comments, start, end);
    const notes = buildNotes(metrics, options.noteThresholds);
    if (parsed.recovered) notes.unshift("Parse recovered with errors; score may be incomplete");
    return {
      ...resultFrom(filename, metrics, options, {
        parseError: parsed.recovered || null,
        partial: Boolean(parsed.recovered),
        components: [unit.name],
        react: true,
        notes,
        findings: sourceFindings(findings, code),
        metricSources: sourceMetrics(sources, code),
        location: {
          start: { line: unit.node.loc.start.line, column: unit.node.loc.start.column + 1 },
          end: { line: unit.node.loc.end.line, column: unit.node.loc.end.column + 1 },
        },
      }),
      name: unit.name,
      kind: "component",
    };
  });
  const moduleRow = moduleRemainder(parsed.ast.program, units, fileResult, componentResults, code, options);
  if (moduleRow) componentResults.push(moduleRow);
  return componentResults;
}

function moduleRemainder(program, units, fileResult, componentResults, code, options) {
  let metrics;
  const findings = [];
  const sources = {};
  try {
    metrics = measure(program, analysisOptions(options, program, findings, sources), new Set(units.map((unit) => unit.node)));
  } catch {
    return null;
  }
  if (metrics.cognitive === 0 && metrics.cyclomatic === 0 && metrics.hooks === 0 && metrics.jsxElements === 0) return null;
  const coveredSloc = componentResults.reduce((sum, item) => sum + (item.metrics?.sloc || 0), 0);
  const coveredLoc = componentResults.reduce((sum, item) => sum + (item.metrics?.loc || 0), 0);
  metrics.sloc = Math.max(0, fileResult.metrics.sloc - coveredSloc);
  metrics.loc = Math.max(0, fileResult.metrics.loc - coveredLoc);
  metrics.components = 0;
  const coveredLines = new Set();
  for (const unit of units) {
    for (let line = unit.node.loc.start.line; line <= unit.node.loc.end.line; line++) coveredLines.add(line);
  }
  const lastLine = lineCount(code);
  const ranges = [];
  const lines = code.split(/\r?\n/);
  for (let line = 1; line <= lastLine; line++) {
    if (coveredLines.has(line)) continue;
    const start = line;
    while (line < lastLine && !coveredLines.has(line + 1)) line++;
    ranges.push({ start: { line: start, column: 1 }, end: { line, column: lines[line - 1].length + 1 } });
  }
  for (const metric of ["loc", "sloc"]) {
    if (metrics[metric] <= 0 || !ranges.length) continue;
    sources[metric] = [{ metric, value: metrics[metric], location: ranges[0], ranges }];
  }
  const notes = buildNotes(metrics, options.noteThresholds);
  if (fileResult.partial) notes.unshift("Parse recovered with errors; score may be incomplete");
  return {
    ...resultFrom(fileResult.file, metrics, options, {
      parseError: fileResult.parseError,
      partial: Boolean(fileResult.partial),
      components: [],
      react: true,
      notes,
      findings: sourceFindings(findings, code),
      metricSources: sourceMetrics(sources, code),
    }),
    name: "(module)",
    kind: "module",
  };
}

function resultFrom(filename, metrics, options, extra) {
  const scored = scoreMetrics(metrics, options.weights, options.baselines);
  return {
    file: filename,
    name: null,
    kind: "file",
    findings: [],
    metricSources: {},
    metrics,
    ...scored,
    ...extra,
  };
}

function analysisOptions(options, program, findings, sources) {
  return {
    countLogical: options.countLogical !== false,
    countNullish: options.countNullish !== false,
    hookPattern: options.hookPattern || "^use[A-Z]",
    program,
    reactPackages: options.reactPackages,
    noteThresholds: options.noteThresholds,
    onFinding: (item) => findings.push(item),
    onMetricSource: (metric, value, node, maximum) => recordSource(sources, metric, value, node, maximum),
  };
}

function recordSource(sources, metric, value, node, maximum = false) {
  if (!node?.loc || value <= 0) return;
  const entry = {
    metric,
    value,
    location: {
      start: { line: node.loc.start.line, column: node.loc.start.column + 1 },
      end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
    },
  };
  if (maximum) sources[metric] = [entry];
  else (sources[metric] ||= []).push(entry);
}

function recordSizeSources(sources, code, comments, start, end) {
  const lines = code.split(/\r?\n/);
  const node = { loc: { start: { line: start, column: 0 }, end: { line: end, column: (lines[end - 1] || "").length } } };
  const size = countSloc(code, comments, start, end);
  recordSource(sources, "loc", size.loc, node);
  recordSource(sources, "sloc", size.sloc, node);
}

function sourceMetrics(sources, code) {
  return Object.fromEntries(Object.entries(sources).map(([metric, entries]) => [metric, sourceFindings(entries, code)]));
}

function sourceFindings(findings, code) {
  const lines = code.split(/\r?\n/);
  return findings
    .sort((a, b) => a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column || a.metric.localeCompare(b.metric))
    .map((item) => ({ ...item, evidence: (lines[item.location.start.line - 1] || "").trim().slice(0, 200) }));
}

export function parseSource(code, filename, options = {}) {
  const extra = Array.isArray(options.babelPlugins) ? options.babelPlugins : [];
  const attempts = [
    [...BASE_PLUGINS, ...extra, "importAttributes", "exportDefaultFrom", "decorators-legacy", "decoratorAutoAccessors"],
    [...BASE_PLUGINS, ...extra, "importAttributes", "deprecatedImportAssert", "exportDefaultFrom", "decorators-legacy", "decoratorAutoAccessors"],
    [...BASE_PLUGINS, ...extra, ["decorators", { decoratorsBeforeExport: false }], "decoratorAutoAccessors"],
    [...BASE_PLUGINS, ...extra, ["decorators", { decoratorsBeforeExport: true }], "decoratorAutoAccessors"],
    [...BASE_PLUGINS, ...extra, "decorators-legacy"],
    [...BASE_PLUGINS, ...extra],
  ];
  let lastError = null;
  let best = null;
  for (const plugins of attempts) {
    try {
      const ast = parse(code, {
        sourceType: "unambiguous",
        sourceFilename: filename,
        plugins,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowUndeclaredExports: true,
        tokens: false,
      });
      const errors = ast.errors || [];
      if (!errors.length) return { ast, error: null, recovered: null };
      if (!best || errors.length < best.errors.length) best = { ast, errors };
    } catch (error) {
      lastError = error;
    }
  }
  if (best) return { ast: best.ast, error: null, recovered: best.errors[0].message };
  return { ast: null, error: lastError ? lastError.message : "Parse failed", recovered: null };
}

export function findComponents(ast) {
  const found = [];
  for (const stmt of ast.program?.body || []) collectStatement(stmt, found);
  return found;
}

function collectStatement(stmt, found) {
  if (!stmt) return;
  if (stmt.type === "ExportNamedDeclaration") {
    if (stmt.declaration) collectStatement(stmt.declaration, found);
    return;
  }
  if (stmt.type === "ExportDefaultDeclaration") {
    addComponent(stmt.declaration, "default", found);
    return;
  }
  if (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") {
    addComponent(stmt, stmt.id?.name || "default", found);
    return;
  }
  if (stmt.type === "VariableDeclaration") {
    for (const declarator of stmt.declarations) {
      const name = declarator.id?.type === "Identifier" ? declarator.id.name : "anonymous";
      addComponent(declarator.init, name, found);
    }
  }
}

function addComponent(node, fallbackName, found) {
  if (!node) return;
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    if (isClassComponent(node)) found.push({ name: pickName(node, fallbackName), node });
    return;
  }
  if (isFunctionNode(node)) {
    if (containsJSX(node, true)) found.push({ name: pickName(node, fallbackName), node });
    return;
  }
  const fn = unwrapComponentInit(node);
  if (fn && containsJSX(fn, true)) found.push({ name: pickName(fn, fallbackName), node: fn });
}

function pickName(node, fallback) {
  if (fallback && fallback !== "default" && fallback !== "anonymous") return fallback;
  return node?.id?.name || fallback || "anonymous";
}

function unwrapComponentInit(node) {
  let current = unwrapExpression(node);
  while (current && (current.type === "CallExpression" || current.type === "OptionalCallExpression")) {
    const name = wrapperName(current.callee);
    if (!name || !WRAPPERS.has(name)) break;
    current = unwrapExpression(current.arguments?.[0]);
  }
  return isFunctionNode(current) ? current : null;
}

function wrapperName(callee) {
  const direct = calleeName(callee);
  if (direct) return direct;
  if (!callee) return null;
  if (callee.type === "CallExpression" || callee.type === "OptionalCallExpression") return calleeName(callee.callee);
  if (callee.type === "SequenceExpression") return calleeName(callee.expressions?.at(-1));
  return null;
}

function isClassComponent(node) {
  const superName = calleeName(node.superClass);
  if (superName === "Component" || superName === "PureComponent") return true;
  const body = node.body?.body || [];
  return body.some(
    (member) =>
      (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") &&
      member.key?.name === "render" &&
      containsJSX(member),
  );
}

function isReact(ast, metrics, options) {
  if (metrics.jsxElements > 0 || metrics.hooks > 0 || metrics.components > 0) return true;
  const packages = options.reactPackages || DEFAULT_REACT_PACKAGES;
  for (const stmt of ast.program?.body || []) {
    if (stmt.type !== "ImportDeclaration") continue;
    const source = String(stmt.source.value);
    if (packages.some((name) => source === name || source.startsWith(`${name}/`))) return true;
  }
  return false;
}

export function countSloc(source, comments, startLine, endLine) {
  const lines = source.split(/\r?\n/);
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const masks = new Map();
  for (const comment of comments || []) {
    if (!comment.loc?.end) continue;
    for (let line = comment.loc.start.line; line <= comment.loc.end.line; line++) {
      if (line < from || line > to) continue;
      const text = lines[line - 1] ?? "";
      const chars = masks.get(line) || [...text];
      const left = line === comment.loc.start.line ? comment.loc.start.column : 0;
      const right = line === comment.loc.end.line ? comment.loc.end.column : chars.length;
      for (let i = left; i < Math.min(right, chars.length); i++) chars[i] = " ";
      masks.set(line, chars);
    }
  }
  let sloc = 0;
  for (let line = from; line <= to; line++) {
    const text = masks.has(line) ? masks.get(line).join("") : (lines[line - 1] ?? "");
    const trimmed = text.trim();
    if (trimmed === "" || trimmed === "{}") continue;
    sloc += 1;
  }
  return { loc: Math.max(0, to - from + 1), sloc };
}

function lineCount(source) {
  if (source.length === 0) return 1;
  return source.split(/\r?\n/).length;
}

function buildNotes(metrics, thresholds = {}) {
  const limits = { ...DEFAULT_NOTE_THRESHOLDS, ...thresholds };
  const notes = [];
  if (metrics.cognitive >= limits.cognitive) notes.push(`cognitive complexity ${metrics.cognitive}`);
  if (metrics.jsxDepth >= limits.jsxDepth) notes.push(`JSX nesting is ${metrics.jsxDepth}`);
  if (metrics.hooks >= limits.hooks) notes.push(`${metrics.hooks} hook calls`);
  if (metrics.effects >= limits.effects) notes.push(`${metrics.effects} effect hooks`);
  if (metrics.effectsWithoutDeps >= limits.effectsWithoutDeps) {
    notes.push(`${metrics.effectsWithoutDeps} effect${metrics.effectsWithoutDeps === 1 ? "" : "s"} with no dependency array`);
  }
  if (metrics.conditionals >= limits.conditionals) notes.push(`${metrics.conditionals} conditional renders`);
  if (metrics.inlineHandlers >= limits.inlineHandlers) notes.push(`${metrics.inlineHandlers} inline JSX handlers`);
  if (metrics.nestedComponents >= limits.nestedComponents) {
    notes.push(`${metrics.nestedComponents} nested component${metrics.nestedComponents === 1 ? "" : "s"}`);
  }
  if (metrics.maxFunctionLength >= limits.maxFunctionLength) {
    notes.push(`longest function is ${metrics.maxFunctionLength} lines`);
  }
  if (metrics.components >= limits.components) notes.push(`${metrics.components} components in one file`);
  if (metrics.spreads >= limits.spreads) notes.push(`${metrics.spreads} JSX prop spreads`);
  return notes;
}
