import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSource, analyzeComponents } from "../src/analyze.js";
import { defaults } from "../src/config.js";
import { main } from "../src/cli.js";
import { formatExplanation, formatReport } from "../src/format.js";

const options = defaults();
const analyze = (code, extra = {}) => analyzeSource(code, "App.tsx", { ...options, ...extra });

test("nested arrow, function-expression, and wrapped components are detected", () => {
  const result = analyze(`
    export function Parent() {
      const Arrow = () => <span/>;
      const Expression = function () { return <span/>; };
      const Wrapped = memo(() => <span/>);
      const Typed = (() => <span/>) satisfies React.FC;
      function Named() { return <span/>; }
      function Utility() { return 1; }
      return <Arrow/>;
    }
  `);
  assert.equal(result.metrics.nestedComponents, 5);
  assert.equal(result.findings.filter((item) => item.metric === "nestedComponents").length, 5);
  assert.ok(result.findings.some((item) => item.message.includes("Arrow")));
  assert.ok(result.findings.every((item) => !item.message.includes("Utility")));
});

test("a JSX function inside a non-component helper is not a nested component", () => {
  const result = analyze(`function setup() { const Child = () => <span/>; return Child; }`);
  assert.equal(result.metrics.nestedComponents, 0);
});

test("component binding names take precedence over inner function names", () => {
  const result = analyze(`function Parent() {
    const Child = function renderChild() { return <span/>; };
    return <Child/>;
  }`);
  assert.equal(result.metrics.nestedComponents, 1);
  assert.match(result.findings[0].message, /Component Child/);
});

test("nested components in class render methods are detected", () => {
  const result = analyze(`class App extends React.Component {
    render() { const Child = () => <span/>; return <Child/>; }
  }`);
  assert.equal(result.metrics.nestedComponents, 1);
});

test("aliased React hooks retain their original classification and dependency positions", () => {
  const source = `import { useEffect as effect, useState as state, useMemo as memoize,
    useImperativeHandle as handle } from "react";
    export function App() {
      state(0);
      effect(() => {}, [a]);
      memoize(() => 1, [a, b]);
      handle(ref, () => ({}));
      return <div/>;
    }`;
  for (const result of [analyze(source), analyzeComponents(source, "App.tsx", options)[0]]) {
    assert.equal(result.metrics.hooks, 4);
    assert.equal(result.metrics.effects, 2);
    assert.equal(result.metrics.stateHooks, 1);
    assert.equal(result.metrics.memoHooks, 1);
    assert.equal(result.metrics.effectDeps, 1);
    assert.equal(result.metrics.memoDeps, 2);
    assert.equal(result.metrics.effectsWithoutDeps, 1);
    assert.equal(result.findings.filter((item) => item.metric === "effectsWithoutDeps").length, 1);
  }
});

test("React namespace aliases are recognized, unrelated method names are not", () => {
  const result = analyze(`import R from "react";
    import * as Hooks from "react";
    import Other from "other";
    R.useState(0);
    Hooks.useEffect(() => {}, []);
    Other.useEffect(() => {});
    service.useState(0);
    service.useThing();`);
  assert.equal(result.metrics.hooks, 2);
  assert.equal(result.metrics.effects, 1);
  assert.equal(result.metrics.effectsWithoutDeps, 0);
});

test("parameters, destructuring, blocks, catch bindings and loops shadow React imports", () => {
  const result = analyze(`import React, { useEffect, useEffect as effect } from "react";
    function a(React, effect) { React.useEffect(() => {}); effect(() => {}); }
    function b({ effect }) { effect(() => {}); }
    function c() { { const effect = () => {}; effect(() => {}); } effect(() => {}, []); }
    try {} catch (React) { React.useEffect(() => {}); }
    for (const React of things) React.useEffect(() => {});
    function d() { useEffect(() => {}); if (ok) { var useEffect = other; } }
    function e() { effect(() => {}); const effect = other; }
    React.useEffect(() => {}, []);`);
  assert.equal(result.metrics.hooks, 2);
  assert.equal(result.metrics.effects, 2);
  assert.equal(result.metrics.effectsWithoutDeps, 0);
});

test("non-React imports and local functions with built-in hook names do not count as React hooks", () => {
  const result = analyze(`import { useEffect } from "other";
    function useState() {}
    useEffect(() => {}); useState();`);
  assert.equal(result.metrics.hooks, 0);
});

test("other built-in hook names and switch-local bindings respect shadowing", () => {
  const result = analyze(`import React from "react";
    function useRef() {}
    useRef();
    switch (value) { case 1: const React = service; React.useEffect(() => {}); }
    React.useEffect(() => {}, []);`);
  assert.equal(result.metrics.hooks, 1);
  assert.equal(result.metrics.effects, 1);
});

test("standalone hook snippets and external custom hooks remain supported", () => {
  const result = analyze(`import { useQuery } from "query-library";
    useQuery(); useEffect(() => {}); React.useState(0); useLocalThing();`);
  assert.equal(result.metrics.hooks, 4);
  assert.equal(result.metrics.customHooks, 2);
});

test("configured React packages and hook patterns apply to aliases", () => {
  const result = analyze(`import { useEffect as effect } from "my-react/hooks";
    effect(() => {});`, { reactPackages: ["my-react"], hookPattern: "^use" });
  assert.equal(result.metrics.effects, 1);
});

test("props metric counts only known, explicitly destructured props", () => {
  assert.equal(analyze(`const A = (props: Props) => <div/>;`).metrics.maxProps, 0);
  assert.equal(analyze(`const A = ({ a, b, ...rest }) => <div/>;`).metrics.maxProps, 2);
  assert.equal(analyze(`const A = ({ a, b = 1 } = {}) => <div/>;`).metrics.maxProps, 2);
  assert.equal(analyze(`function helper({ a, b, c }) { return a; }`).metrics.maxProps, 0);
});

const recoveredSource = `export const n = 1; export const n = 2;
function helper(x) { if (x) return x; }
export function App() { return <div/>; }
export function Other() { return <span/>; }`;

test("component and module rows preserve parse-recovery warnings", () => {
  const units = analyzeComponents(recoveredSource, "App.tsx", options);
  assert.equal(units.length, 3);
  assert.ok(units.some((item) => item.kind === "module"));
  for (const unit of units) {
    assert.equal(unit.partial, true);
    assert.match(unit.parseError, /already been declared/);
    assert.match(unit.notes[0], /score may be incomplete/);
  }
});

test("parse failure returns no fabricated findings", () => {
  const result = analyze("export function App( {");
  assert.ok(result.parseError);
  assert.deepEqual(result.findings, []);
});

test("findings have one-based source ranges, evidence and contextual suggestions", () => {
  const result = analyze(`export function App() {
  const Child = () => <span/>;
  useEffect(() => {});
  return <main><section><Child onClick={() => save()}/></section></main>;
}`, { noteThresholds: { ...options.noteThresholds, jsxDepth: 3 } });
  const nested = result.findings.find((item) => item.metric === "nestedComponents");
  assert.deepEqual(nested.location.start, { line: 2, column: 17 });
  assert.match(nested.evidence, /const Child/);
  const depth = result.findings.find((item) => item.metric === "jsxDepth");
  assert.equal(depth.location.start.line, 4);
  assert.match(depth.message, /3 levels/);
  const effect = result.findings.find((item) => item.metric === "effectsWithoutDeps");
  assert.equal(effect.location.start.line, 3);
  assert.match(effect.suggestion, /may be intentional/);
  assert.match(effect.suggestion, /do not add an empty array/);
  const inline = result.findings.find((item) => item.metric === "inlineHandlers");
  assert.match(inline.message, /onClick/);
  assert.match(inline.suggestion, /profiling/);
  assert.ok(result.findings.every((item) => item.location.end.line >= item.location.start.line));
});

test("cognitive and function-length findings respect configured thresholds", () => {
  const source = `function App() {
  if (a) { if (b) return <span/>; }
  return <div/>;
}`;
  const result = analyze(source, { noteThresholds: { cognitive: 3, maxFunctionLength: 4 } });
  assert.match(result.findings.find((item) => item.metric === "cognitive").message, /complexity 3/);
  assert.match(result.findings.find((item) => item.metric === "maxFunctionLength").message, /4 lines/);
  assert.equal(analyze(source).findings.length, 0);
});

test("component findings stay with their own row; module findings stay in the module", () => {
  const units = analyzeComponents(`useEffect(() => {});
    export function A() { useEffect(() => {}); return <div/>; }
    export function B() { return <span/>; }`, "App.tsx", options);
  assert.deepEqual(units.find((item) => item.name === "A").findings.map((item) => item.location.start.line), [2]);
  assert.deepEqual(units.find((item) => item.name === "B").findings, []);
  assert.deepEqual(units.find((item) => item.kind === "module").findings.map((item) => item.location.start.line), [1]);
});

test("explanations and JSON expose findings without changing scores", () => {
  const file = path.resolve("App.tsx");
  const result = analyzeSource(`function App() { useEffect(() => {}); return <div/>; }`, file, options);
  const config = { ...options, cwd: process.cwd(), color: false };
  const explanation = formatExplanation(result, config);
  assert.match(explanation, /App.tsx:1:18/);
  assert.match(explanation, /review signals, not confirmed defects/);
  assert.match(explanation, /> function App/);
  const json = JSON.parse(formatReport({
    shown: [result], total: 1, filesScanned: 1, errors: [],
  }, { ...config, format: "json" }));
  assert.deepEqual(json.results[0].findings, result.findings);
  assert.equal(json.results[0].score, result.score);
  assert.equal(json.results[0].partial, false);
});

test("strict CLI fails recovered component scans and JSON reports one file error", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "App.tsx"), recoveredSource);
  for (const strict of [false, true]) {
    let stdout = "";
    let stderr = "";
    const code = await main([".", "--by", "component", "--format", "json", ...(strict ? ["--strict"] : [])], {
      cwd: root,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; }, isTTY: false },
    });
    assert.equal(code, strict ? 1 : 0);
    const report = JSON.parse(stdout);
    assert.equal(report.errors.length, 1);
    assert.equal(report.results.length, 3);
    assert.ok(report.results.every((item) => item.partial && item.parseError));
    assert.match(stderr, /already been declared/);
  }
});
