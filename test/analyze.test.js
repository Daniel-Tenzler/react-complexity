import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeSource } from "../src/analyze.js";
import { resolveConfig } from "../src/config.js";
import { main, parseArgv } from "../src/cli.js";
import { analyzePaths } from "../src/scan.js";
import { DEFAULT_WEIGHTS } from "../src/schema.js";

const opts = {
  weights: DEFAULT_WEIGHTS,
  baselines: {
    jsxDepth: 1,
    components: 1,
    imports: 3,
    maxFunctionLength: 20,
    maxProps: 3,
    functions: 1,
  },
  countLogical: true,
  countNullish: true,
  hookPattern: "^use[A-Z]",
};

function analyze(code, filename = "Fixture.jsx") {
  return analyzeSource(code, filename, opts);
}

test("cognitive complexity matches Sonar control-flow examples", () => {
  assert.equal(analyze("function foo() { if (a) {} }").metrics.cognitive, 1);
  assert.equal(analyze("function foo() { if (a) {} else if (b) {} else {} }").metrics.cognitive, 3);
  assert.equal(analyze("function foo() { if (a) { if (b) { if (c) {} } } }").metrics.cognitive, 6);
  assert.equal(analyze("function foo() { if (a && b && c || d || e && f) {} }").metrics.cognitive, 4);
  assert.equal(analyze("function foo() { try {} catch (e) { if (a) {} } }").metrics.cognitive, 3);
  assert.equal(analyze("function foo() { bar(() => { if (a) {} }); }").metrics.cognitive, 2);
  assert.equal(analyze("function foo(n) { if (n) return foo(n - 1); }").metrics.cognitive, 2);
  assert.equal(analyze("function foo() { switch (n) { case 1: break; default: break; } }").metrics.cognitive, 1);
});

test("cyclomatic complexity counts decisions, not a per-function base", () => {
  const result = analyze("function foo() { if (a && b) {} else if (c) {} while (d) {} }");
  assert.equal(result.metrics.cyclomatic, 4);
  assert.equal(result.metrics.maxCyclomatic, 5);
});

test("JSX depth, hooks, and conditional renders are independent of cognitive nesting", () => {
  const result = analyze(`
    import React, { useState, useEffect, useMemo } from "react";
    export function Dashboard({ user, onSave }) {
      const [open, setOpen] = useState(false);
      const label = useMemo(() => user.name, [user]);
      useEffect(() => {
        if (open) setOpen(false);
      }, [open, label]);
      React.useLayoutEffect(() => {}, []);
      useThing();
      return (
        <main>
          <section>
            <article>{open && <span>{label}</span>}</article>
          </section>
          <button onClick={() => onSave(open)}>Save</button>
        </main>
      );
    }
  `);
  assert.equal(result.metrics.jsxDepth, 4);
  assert.equal(result.metrics.jsxElements, 5);
  assert.equal(result.metrics.hooks, 5);
  assert.equal(result.metrics.effects, 2);
  assert.equal(result.metrics.stateHooks, 1);
  assert.equal(result.metrics.memoHooks, 1);
  assert.equal(result.metrics.customHooks, 1);
  assert.equal(result.metrics.effectDeps, 2);
  assert.equal(result.metrics.inlineHandlers, 1);
  assert.equal(result.metrics.conditionals, 1);
  assert.equal(result.metrics.components, 1);
  assert.equal(result.react, true);
  assert.equal(result.metrics.cognitive, 3);
});

test("a complex component scores above a simple one", () => {
  const simple = analyze(`
    export function Button({ label }) {
      return <button>{label}</button>;
    }
  `);
  const complex = analyze(`
    import { useEffect, useState } from "react";
    export function Dashboard({ user, items, onSave, theme }) {
      const [open, setOpen] = useState(false);
      const [tab, setTab] = useState("home");
      const [query, setQuery] = useState("");
      useEffect(() => {
        if (user && items.length) {
          if (tab === "home") setOpen(true);
        }
      }, [user, items, tab]);
      useEffect(() => {
        if (query) setTab(query);
      });
      function Row() {
        return <li>{query}</li>;
      }
      return (
        <main>
          <section>
            <article>
              <div>
                <ul>
                  {items.map((item) => item.active ? <Row key={item.id} /> : null)}
                </ul>
              </div>
            </article>
          </section>
          <button onClick={() => onSave(open)}>Save</button>
          <button onClick={() => setTab("home")}>Home</button>
        </main>
      );
    }
  `);
  assert.ok(complex.score > simple.score);
  assert.ok(complex.metrics.nestedComponents >= 1);
  assert.ok(complex.metrics.effectsWithoutDeps >= 1);
});

test("unknown weights are rejected with a suggestion", async () => {
  await assert.rejects(
    () => resolveConfig({ cli: { weights: { cognative: 2 } }, paths: [], cwd: process.cwd() }),
    /cognitive/,
  );
});

test("CLI weight overrides merge into defaults", async () => {
  const config = await resolveConfig({
    cli: { weights: { jsxDepth: 9 } },
    paths: [],
    cwd: process.cwd(),
  });
  assert.equal(config.weights.jsxDepth, 9);
  assert.equal(config.weights.cognitive, DEFAULT_WEIGHTS.cognitive);
});

test("scan ranks react files and skips noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "Simple.jsx"), "export function Simple() { return <button>ok</button>; }\n");
  await writeFile(
    path.join(root, "src", "Busy.jsx"),
    `import { useEffect, useState } from "react";
    export function Busy({ value }) {
      const [n, setN] = useState(0);
      useEffect(() => { if (value) setN(value); }, [value]);
      if (n > 1) return <strong>{n}</strong>;
      return <div><span>{n}</span></div>;
    }`,
  );
  await writeFile(path.join(root, "src", "plain.js"), "export const n = 1;\n");
  await writeFile(path.join(root, "src", "Busy.test.jsx"), "export function T() { return <div/>; }\n");
  await writeFile(
    path.join(root, "node_modules", "pkg", "Huge.jsx"),
    "export function Huge() { return <div><div><div><div/></div></div></div>; }\n",
  );
  const config = await resolveConfig({ cwd: root, paths: [root] });
  const analyzed = await analyzePaths([root], config);
  const files = analyzed.results.map((item) => path.basename(item.file));
  assert.ok(files.includes("Busy.jsx"));
  assert.ok(files.includes("Simple.jsx"));
  assert.equal(files.includes("plain.js"), false);
  assert.equal(files.includes("Busy.test.jsx"), false);
  assert.equal(files.includes("Huge.jsx"), false);
  assert.ok(analyzed.results.find((item) => item.file.endsWith("Busy.jsx")).score >
    analyzed.results.find((item) => item.file.endsWith("Simple.jsx")).score);
});

test("CLI help and single-file explain", async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--weight/);
  assert.match(help.stdout, /cognitive/);

  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-cli-"));
  const file = path.join(root, "App.jsx");
  await writeFile(file, "export function App() { return <main><section>Hi</section></main>; }\n");
  const explained = await run([file], root);
  assert.equal(explained.code, 0);
  assert.match(explained.stdout, /jsxDepth/);
  assert.match(explained.stdout, /score/);
});

test("parenthesized logical sequences and nullish do not follow the old flatten rules", () => {
  assert.equal(analyze("const x = a && (b && c) && (d && e)").metrics.cognitive, 3);
  assert.equal(analyze("function foo() { if (a && (b || c) && d) {} }").metrics.cognitive, 3);
  assert.equal(analyze("const x = (a || b) && (c || d) && (e || f)").metrics.cognitive, 4);
  assert.equal(analyze("function foo(a, b) { return a ?? b ?? c; }").metrics.cognitive, 0);
  assert.equal(analyze("function foo(a, b) { return a ?? b ?? c; }").metrics.cyclomatic, 2);
});

test("useImperativeHandle reads the dependency argument", () => {
  const missing = analyze("function Foo() { useImperativeHandle(ref, () => ({})); return <div/>; }");
  const listed = analyze("function Foo() { useImperativeHandle(ref, () => ({}), [a, b]); return <div/>; }");
  assert.equal(missing.metrics.effectsWithoutDeps, 1);
  assert.equal(listed.metrics.effectDeps, 2);
  assert.equal(listed.metrics.effectsWithoutDeps, 0);
});

test("type imports and nested JSX helpers are not treated as component weight", () => {
  const typed = analyze("import type { A, B, C, D, E } from 'react';\nexport function Button() { return <i/>; }\n");
  assert.equal(typed.metrics.imports, 0);
  const helper = analyze("export function setup(items) { return items.map((item) => <li>{item}</li>); }\n");
  assert.equal(helper.metrics.components, 0);
  const wrapped = analyze("export default connect(mapState)(function Button() { return <div/>; });\n");
  assert.deepEqual(wrapped.components, ["Button"]);
});

test("comment-only lines are excluded from sloc", () => {
  const result = analyze("export function A() {\n  /* a */ /* b */\n  return <b/>;\n}\n");
  assert.equal(result.metrics.sloc, 3);
});

test("component mode keeps module-level complexity", async () => {
  const { analyzeComponents } = await import("../src/analyze.js");
  const units = analyzeComponents(
    `function heavy(x) { if (x && y) return x; }\nexport function Tiny() { return <i/>; }\n`,
    "Mix.jsx",
    opts,
  );
  assert.ok(units.some((item) => item.name === "(module)" && item.metrics.cognitive > 0));
  assert.ok(units.some((item) => item.name === "Tiny"));
});

test("gitignore negation, nested rules, and case", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-ignore-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), "*\n!*/\n!*.jsx\n");
  await writeFile(path.join(root, "src", ".gitignore"), "*.jsx\n!Keep.jsx\n");
  await writeFile(path.join(root, "src", "Keep.jsx"), "export function Keep() { return <b/>; }\n");
  await writeFile(path.join(root, "src", "Drop.jsx"), "export function Drop() { return <b/>; }\n");
  await writeFile(path.join(root, "src", "nested", "Deep.jsx"), "export function Deep() { return <b/>; }\n");
  await writeFile(path.join(root, "Button.jsx"), "export function Button() { return <b/>; }\n");
  const config = await resolveConfig({ cwd: root, paths: [root] });
  const analyzed = await analyzePaths([root], config);
  const names = analyzed.results.map((item) => path.basename(item.file)).sort();
  assert.deepEqual(names, ["Button.jsx", "Keep.jsx"]);
});

test("analyze accepts a path string", async () => {
  const { analyze } = await import("../src/index.js");
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-api-"));
  await writeFile(path.join(root, "A.jsx"), "export function A() { return <b/>; }\n");
  const result = await analyze(root, { cwd: root, top: 0 });
  assert.equal(result.shown.length, 1);
});

test("parseArgv accepts repeated weights", () => {
  const parsed = parseArgv(["src", "--weight", "cognitive=2", "--weight=jsxDepth=4", "--top", "5"]);
  assert.deepEqual(parsed.positionals, ["src"]);
  assert.deepEqual(parsed.weight, ["cognitive=2", "jsxDepth=4"]);
  assert.equal(parsed.top, 5);
});

async function run(args, cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; }, isTTY: false },
  });
  return { code, stdout, stderr };
}
