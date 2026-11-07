import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { analyzeSource, analyzeComponents } from "../src/analyze.js";
import { defaults } from "../src/config.js";
import { formatExplanation, formatReport, metricSourceEntries } from "../src/format.js";
import { exploreReport } from "../src/interactive.js";
import { METRIC_KEYS } from "../src/schema.js";

const config = { ...defaults(), cwd: process.cwd(), color: false };
const maximums = new Set(["maxCyclomatic", "jsxDepth", "maxNesting", "maxFunctionLength", "maxProps"]);
const fixture = `import React, { useEffect as effect, useState, useMemo } from "react";
import type { Ignored } from "react";
import "./styles.css";
const dependency = require("./dependency");
export function Dashboard({ a, b, c, d }) {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => a, [a, b]);
  effect(() => { if (open && a || b) setOpen(false); }, [open, a]);
  React.useLayoutEffect(() => {});
  useFeature();
  function Child() { return <span/>; }
  return <><main {...d} title={a ? <b/> : null}>
    {open && <Child/>}
    <button onClick={() => setOpen(true)}>{label}</button>
  </main></>;
}
`;

function assertSources(result, code) {
  const lines = code.split(/\r?\n/);
  for (const metric of METRIC_KEYS) {
    const entries = result.metricSources[metric] || [];
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    assert.equal(total, result.metrics[metric], `${result.name || "file"}: ${metric} sources reconcile with raw metric`);
    if (maximums.has(metric)) assert.ok(entries.length <= 1, metric);
    for (const entry of entries) {
      assert.equal(entry.metric, metric);
      assert.equal(entry.evidence, lines[entry.location.start.line - 1].trim().slice(0, 200));
      const { start, end } = entry.location;
      assert.ok(start.line >= 1 && start.column >= 1);
      assert.ok(end.line > start.line || (end.line === start.line && end.column >= start.column));
      assert.ok(end.column <= lines[end.line - 1].length + 1);
      assert.equal("suggestion" in entry, false);
    }
  }
}

test("every positive metric has factual source references, including zero-weight metrics", () => {
  const result = analyzeSource(fixture, "Dashboard.tsx", config);
  assert.equal(result.parseError, null);
  assertSources(result, fixture);
  for (const metric of METRIC_KEYS) assert.ok(result.metrics[metric] > 0, `fixture covers ${metric}`);
  assert.equal(result.metricSources.effects.length, 2);
  assert.equal(result.metricSources.hooks.length, 5);
  assert.equal(result.metricSources.imports.length, 6);
  assert.equal(result.metricSources.maxProps[0].location.start.line, 5);
});

test("control-flow source values reconcile across branching, loops, recursion and logical sequences", () => {
  const code = `function work(a) {
    outer: for (;;) {
      if (a && (b || c) && d) continue outer;
      else if (b) break outer;
      else a ||= b;
      while (a) a--;
      do { a--; } while (a);
      for (const key in a) work(key);
      for (const item of a) work(item);
      switch (a) { case 1: break; default: break; }
      try { a ??= b; } catch (error) { a = b ?? c; }
      a = b ? c : d;
      return work(a);
    }
  }`;
  assertSources(analyzeSource(code, "Flow.js", config), code);
  const disabled = { ...config, countLogical: false, countNullish: false };
  assertSources(analyzeSource(code, "Flow.js", disabled), code);
});

test("max metrics link to the first highest location, not every previous record", () => {
  const code = `function Small({ a }) { return <i/>; }
function Large({ a, b, c }) { return <main><div><span/></div></main>; }
function Equal({ a, b, c }) { return <main><div><span/></div></main>; }`;
  const result = analyzeSource(code, "Max.jsx", config);
  assertSources(result, code);
  assert.equal(result.metricSources.jsxDepth[0].location.start.line, 2);
  assert.equal(result.metricSources.maxProps[0].location.start.line, 2);
});

test("component and module sources remain within their own scope", () => {
  const code = `// module comment
useEffect(() => {});
/* another comment */
export function First() {
  useState(0);
  return <div {...props}/>;
}
export function Second() {
  useEffect(() => {}, []);
  return <span/>;
}
`;
  const units = analyzeComponents(code, "Scope.jsx", config);
  for (const unit of units) assertSources(unit, code);
  const first = units.find((unit) => unit.name === "First");
  const second = units.find((unit) => unit.name === "Second");
  const module = units.find((unit) => unit.kind === "module");
  assert.equal(first.metricSources.hooks[0].location.start.line, 5);
  assert.equal(second.metricSources.hooks[0].location.start.line, 9);
  assert.equal(module.metricSources.effects[0].location.start.line, 2);
  assert.equal(first.metricSources.effects, undefined);
  assert.equal(module.metricSources.spreads, undefined);
});

test("sources survive recovery, but fatal parse failures do not fabricate references", () => {
  const recovered = "const n = 1; const n = 2; export const App = () => { useEffect(() => {}); return <div/>; };";
  for (const unit of analyzeComponents(recovered, "App.jsx", config)) {
    assert.equal(unit.partial, true);
    assert.ok(unit.metricSources.effects.length);
  }
  assert.deepEqual(analyzeSource("function {", "Broken.jsx", config).metricSources, {});
});

test("module size references retain existing counts when components share a line", () => {
  const code = `export const A = () => <i/>; export const B = () => <b/>;
useEffect(() => {});
// module comment
`;
  const units = analyzeComponents(code, "Shared.jsx", config);
  for (const unit of units) assertSources(unit, code);
  const module = units.find((unit) => unit.kind === "module");
  assert.equal(module.metrics.sloc, 0);
  assert.equal(module.metricSources.sloc, undefined);
  assert.equal(module.metricSources.loc[0].value, module.metrics.loc);
  assert.equal(module.metricSources.loc[0].ranges[0].start.line, 2);
});

test("reports include sources below finding thresholds and JSON retains all metrics", () => {
  const code = "export function App() {\r\n  useEffect(() => {}, []);\r\n  return <div {...props}/>;\r\n}";
  const result = analyzeSource(code, path.resolve("App.jsx"), config);
  assertSources(result, code);
  assert.equal(result.findings.length, 0);
  const text = formatExplanation(result, config);
  assert.match(text, /App.jsx:2:3 — effects: 1/);
  assert.match(text, /App.jsx:3:15 — spreads: 1/);
  assert.doesNotMatch(text, /— functions:/);
  assert.match(formatExplanation(result, { ...config, verbose: true }), /— functions: 1/);
  const report = { shown: [result], errors: [], total: 1, filesScanned: 1 };
  const json = JSON.parse(formatReport(report, { ...config, format: "json" }));
  assert.deepEqual(json.results[0].metricSources, result.metricSources);
});

test("interactive metric source IDs open exact locations without changing finding IDs", async () => {
  const result = analyzeSource(fixture, path.resolve("Dashboard.tsx"), config);
  const sources = metricSourceEntries(result, config);
  const index = sources.findIndex((source) => source.metric === "spreads");
  const commands = ["1", "o s0", "o s9999", `o s${index + 1}`, "o 1", "q"];
  const calls = [];
  let stdout = "";
  let stderr = "";
  await exploreReport({ results: [result] }, config, {
    prompt: async () => commands.shift() ?? null,
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    openEditor: async (file, location) => calls.push({ file, location }),
  });
  assert.match(stdout, new RegExp(`\\[s${index + 1}\\].*spreads: 1`));
  assert.match(stderr, /valid metric source number/);
  assert.deepEqual(calls, [
    { file: result.file, location: sources[index].location.start },
    { file: result.file, location: result.findings[0].location.start },
  ]);
});
