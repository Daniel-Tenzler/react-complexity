import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBaseline, compareBaseline, readBaseline, writeBaseline } from "../src/baseline.js";
import { defaults } from "../src/config.js";
import { main, parseArgv } from "../src/cli.js";
import { analyze } from "../src/index.js";
import { formatReport } from "../src/format.js";

function config(extra = {}) {
  return { ...defaults(), cwd: process.cwd(), ...extra };
}

function result(file, score, extra = {}) {
  return { file: path.resolve(file), kind: "file", name: null, score, ...extra };
}

function snapshot(entries, settings = config()) {
  return createBaseline({ results: entries, errors: [], skipped: [] }, settings, ["src"]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "App.jsx"), "export function App() { return <div/>; }\n");
  return root;
}

async function run(root, args) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd: root,
    stdout: { write: (chunk) => { stdout += chunk; }, isTTY: false },
    stderr: { write: (chunk) => { stderr += chunk; }, isTTY: false },
  });
  return { code, stdout, stderr };
}

test("snapshots are deterministic, versioned, and independent of display limits", () => {
  const report = {
    results: [result("src/B.jsx", 3), result("src/A.jsx", 1)], errors: [], skipped: [],
    shown: [], total: 0,
  };
  const baseline = createBaseline(report, config({ top: 1, minScore: 100 }), ["./src", "src"]);
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.tool.name, "react-complexity");
  assert.deepEqual(baseline.settings.paths, ["src"]);
  assert.deepEqual(baseline.entries.map((item) => item.file), ["src/A.jsx", "src/B.jsx"]);
  assert.equal(baseline.settings.top, undefined);
  assert.equal(baseline.settings.minScore, undefined);
  assert.deepEqual(baseline, createBaseline({ ...report, results: [...report.results].reverse() }, config(), ["src"]));
});

test("comparison categorizes every change and does not net improvements against regressions", () => {
  const previous = snapshot([result("src/Worse.jsx", 10), result("src/Better.jsx", 20), result("src/Gone.jsx", 4), result("src/Same.jsx", 2)]);
  const current = snapshot([result("src/Worse.jsx", 11), result("src/Better.jsx", 5), result("src/New.jsx", 3), result("src/Zero.jsx", 0), result("src/Same.jsx", 2)]);
  const report = compareBaseline(previous, current);
  assert.deepEqual(report.summary, { new: 2, worsened: 1, improved: 1, removed: 1, unchanged: 1, regressions: 2 });
  assert.equal(report.changes.length, 5);
  assert.equal(report.changes.find((item) => item.file.endsWith("Gone.jsx")).currentScore, null);
  assert.equal(report.changes.find((item) => item.file.endsWith("New.jsx")).previousScore, null);
  assert.equal(report.changes.find((item) => item.file.endsWith("Zero.jsx")).regression, false);
});

test("tolerance is per entry, inclusive, and uses rounded score deltas", () => {
  const before = snapshot([result("src/A.jsx", 0.1), result("src/B.jsx", 2)]);
  const after = snapshot([result("src/A.jsx", 0.3), result("src/B.jsx", 2.21)]);
  const compared = compareBaseline(before, after, 0.2);
  assert.equal(compared.summary.regressions, 1);
  assert.equal(compared.changes.find((item) => item.file.endsWith("A.jsx")).delta, 0.2);
  for (const tolerance of [-1, Infinity, NaN, "2"]) {
    assert.throws(() => compareBaseline(before, after, tolerance), /non-negative finite/);
  }
});

test("component identities include file, kind and name", () => {
  const before = snapshot([
    result("src/App.jsx", 5, { kind: "component", name: "A" }),
    result("src/App.jsx", 2, { kind: "component", name: "B" }),
    result("src/App.jsx", 1, { kind: "module", name: "(module)" }),
  ], config({ by: "component" }));
  const after = structuredClone(before);
  after.entries.find((item) => item.name === "B").score = 3;
  const report = compareBaseline(before, after);
  assert.equal(report.summary.unchanged, 2);
  assert.equal(report.changes[0].name, "B");
});

test("baseline paths are portable between checkout locations", () => {
  const first = path.resolve("checkout-one");
  const second = path.resolve("checkout-two");
  const before = createBaseline({ results: [result(path.join(first, "src", "App.jsx"), 1)] }, config({ cwd: first }), ["src"]);
  const after = createBaseline({ results: [result(path.join(second, "src", "App.jsx"), 1)] }, config({ cwd: second }), ["./src"]);
  assert.equal(compareBaseline(before, after).summary.unchanged, 1);
});

test("scoring, analyzer, and scan-scope changes require a new baseline", () => {
  const before = snapshot([]);
  for (const [setting, value] of [
    ["by", "component"], ["weights", { cognitive: 99 }], ["baselines", {}],
    ["countLogical", false], ["countNullish", false], ["hookPattern", "^use"],
    ["reactPackages", ["preact"]], ["babelPlugins", ["flow"]], ["ignore", ["foo"]],
    ["extensions", [".jsx"]], ["includeTests", true], ["includeStories", true],
    ["useGitignore", false], ["allFiles", true], ["skipDirs", []], ["maxFileBytes", 1],
    ["paths", ["other"]],
  ]) {
    const after = structuredClone(before);
    after.settings[setting] = value;
    assert.throws(() => compareBaseline(before, after), new RegExp(`settings differ: ${setting}`));
  }
  for (const property of ["version", "analysisVersion", "parserVersion", "typesVersion"]) {
    const after = structuredClone(before);
    after.tool[property] = property === "analysisVersion" ? 2 : "99.0.0";
    assert.throws(() => compareBaseline(before, after), /analyzer version differs/);
  }
});

test("cosmetic/report settings and object-key ordering do not invalidate comparisons", () => {
  const before = snapshot([]);
  const after = snapshot([], config({ top: 1, minScore: 100, sort: "density", color: true, noteThresholds: { hooks: 1 }, failOn: { score: 0 } }));
  after.settings.weights = Object.fromEntries(Object.entries(after.settings.weights).reverse());
  assert.equal(compareBaseline(before, after).summary.regressions, 0);
});

test("incomplete scans are never saved or compared", () => {
  for (const report of [
    { results: [], errors: [{ parseError: "bad syntax" }] },
    { results: [], skipped: [{ reason: "permission denied" }] },
    { results: [result("src/A.jsx", 1, { partial: true })] },
  ]) assert.throws(() => createBaseline(report, config()), /incomplete scan/);
});

test("malformed, unsupported, or duplicate baseline entries are rejected", () => {
  const good = snapshot([result("src/A.jsx", 1)]);
  for (const bad of [null, {}, { ...good, schemaVersion: 99 }, { ...good, entries: {} }, { ...good, tool: null },
    { ...good, entries: [good.entries[0], good.entries[0]] }]) {
    assert.throws(() => compareBaseline(bad, good), /baseline/i);
  }
  for (const fields of [{ file: "/absolute.jsx" }, { file: "C:/absolute.jsx" }, { file: "src\\A.jsx" },
    { file: "src/../A.jsx" }, { score: "1" }, { score: Infinity }, { kind: "unknown" }, { name: 3 }]) {
    const bad = structuredClone(good);
    Object.assign(bad.entries[0], fields);
    assert.throws(() => compareBaseline(bad, good), /Invalid baseline entry/);
  }
});

test("baseline IO refuses overwrites unless explicitly forced", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "baseline.json");
  const before = snapshot([result("src/A.jsx", 1)]);
  const after = snapshot([result("src/A.jsx", 2)]);
  await writeBaseline(file, before);
  await assert.rejects(() => writeBaseline(file, after), /Refusing to overwrite/);
  assert.deepEqual(await readBaseline(file), before);
  await writeBaseline(file, after, { force: true });
  assert.deepEqual(await readBaseline(file), after);
  await writeFile(file, "{bad json");
  await assert.rejects(() => readBaseline(file), /Invalid baseline JSON/);
  await assert.rejects(() => readBaseline(path.join(root, "missing.json")), /Cannot read baseline/);
});

test("CLI saves every row regardless of --top and --min-score, without polluting JSON", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "Other.jsx"), "export const Other = () => <span/>;\n");
  const saved = await run(root, ["src", "--save-baseline", "baseline.json", "--top", "1", "--min-score", "999", "--format", "json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const baseline = await readBaseline(path.join(root, "baseline.json"));
  assert.equal(baseline.entries.length, 2);
  assert.equal(JSON.parse(saved.stdout).results.length, 0);
  assert.equal(JSON.parse(saved.stdout).baselineSaved, "baseline.json");
  assert.match(saved.stderr, /Saved baseline/);
  const repeated = await run(root, ["src", "--save-baseline", "baseline.json"]);
  assert.equal(repeated.code, 1);
  assert.match(repeated.stderr, /Refusing to overwrite/);
  assert.equal((await run(root, ["src", "--save-baseline", "baseline.json", "--force"])).code, 0);
});

test("CLI comparison catches hidden regressions, supports tolerance, and never rewrites its baseline", async (t) => {
  const root = await fixture(t);
  await run(root, ["src", "--save-baseline", "baseline.json"]);
  const file = path.join(root, "baseline.json");
  const original = await readFile(file, "utf8");
  const unchanged = await run(root, ["src", "--compare-baseline", "baseline.json"]);
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /No complexity changes/);
  await writeFile(path.join(root, "src", "App.jsx"), "export function App() { if (a) return <span/>; return <div/>; }\n");
  const args = ["src", "--compare-baseline", "baseline.json", "--format", "json", "--min-score", "999"];
  const worse = await run(root, args);
  assert.equal(worse.code, 1);
  const compared = JSON.parse(worse.stdout);
  assert.equal(compared.results.length, 0);
  assert.equal(compared.comparison.summary.worsened, 1);
  assert.equal(compared.comparison.summary.regressions, 1);
  assert.match(worse.stderr, /Regression \+/);
  const tolerated = await run(root, [...args, "--baseline-tolerance", "2"]);
  assert.equal(tolerated.code, 0, tolerated.stderr);
  assert.equal(JSON.parse(tolerated.stdout).comparison.summary.regressions, 0);
  assert.equal(await readFile(file, "utf8"), original);
});

test("CLI comparison reports new, improved and removed files", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "Gone.jsx"), "export const Gone = () => <span/>;\n");
  await writeFile(path.join(root, "src", "App.jsx"), "export function App() { if (a) return <span/>; return <div/>; }\n");
  await run(root, ["src", "--save-baseline", "baseline.json"]);
  await rm(path.join(root, "src", "Gone.jsx"));
  await writeFile(path.join(root, "src", "App.jsx"), "export const App = () => <div/>;\n");
  await writeFile(path.join(root, "src", "New.jsx"), "export const New = () => <span/>;\n");
  const compared = await run(root, ["src", "--compare-baseline", "baseline.json", "--format", "json"]);
  assert.equal(compared.code, 1);
  const summary = JSON.parse(compared.stdout).comparison.summary;
  assert.equal(summary.new, 1);
  assert.equal(summary.improved, 1);
  assert.equal(summary.removed, 1);
});

test("CLI component baseline reports named component changes and module rows", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "App.jsx"), "useEffect(() => {}); export const A = () => <div/>; export const B = () => <span/>;\n");
  const saved = await run(root, ["src", "--by", "component", "--save-baseline", "baseline.json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const entries = (await readBaseline(path.join(root, "baseline.json"))).entries;
  assert.deepEqual(entries.map((item) => item.name).sort(), ["(module)", "A", "B"]);
  await writeFile(path.join(root, "src", "App.jsx"), "useEffect(() => {}); export const A = () => <div/>; export const B = () => <span><i/></span>;\n");
  const compared = await run(root, ["src", "--by", "component", "--compare-baseline", "baseline.json"]);
  assert.equal(compared.code, 1);
  assert.match(compared.stdout, /App.jsx:B/);
});

test("CLI refuses incomplete snapshots, incompatible comparisons, and unsafe writes", async (t) => {
  const root = await fixture(t);
  await run(root, ["src", "--save-baseline", "baseline.json"]);
  const mismatch = await run(root, ["src", "--compare-baseline", "baseline.json", "--weight", "cognitive=2"]);
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /settings differ: weights/);
  const unsafe = await run(root, ["src", "--save-baseline", "src/App.jsx", "--force"]);
  assert.equal(unsafe.code, 1);
  assert.match(unsafe.stderr, /analyzed source file/);
  await writeFile(path.join(root, "src", "App.jsx"), "export function App( {");
  for (const action of ["--save-baseline", "--compare-baseline"]) {
    const incomplete = await run(root, ["src", action, "baseline.json", "--force"]);
    assert.equal(incomplete.code, 1);
    assert.match(incomplete.stderr, /incomplete scan/);
  }
  assert.equal((await readBaseline(path.join(root, "baseline.json"))).entries.length, 1);
});

test("CLI rejects conflicting actions, tolerance without comparison, and invalid tolerance", async (t) => {
  const root = await fixture(t);
  await run(root, ["src", "--save-baseline", "baseline.json"]);
  for (const args of [
    ["--save-baseline", "new.json", "--compare-baseline", "baseline.json"],
    ["--baseline-tolerance", "1"],
    ["--compare-baseline", "baseline.json", "--baseline-tolerance", "NaN"],
    ["--compare-baseline", "baseline.json", "--baseline-tolerance=-1"],
    ["--save-baseline="],
    ["--compare-baseline="],
  ]) assert.equal((await run(root, ["src", ...args])).code, 1);
  assert.deepEqual(parseArgv(["--save-baseline", "baseline.json"]).saveBaseline, "baseline.json");
});

test("CLI rejects recovered component scans even without --strict", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "src", "App.jsx"), "const n = 1; const n = 2; export function App() { return <div/>; }");
  const saved = await run(root, ["src", "--by", "component", "--save-baseline", "baseline.json"]);
  assert.equal(saved.code, 1);
  assert.match(saved.stderr, /incomplete scan/);
  assert.match(saved.stderr, /already been declared/);
  await assert.rejects(() => readFile(path.join(root, "baseline.json")), { code: "ENOENT" });
});

test("ordinary metric baselines and existing CI limits still work with reports", async (t) => {
  const root = await fixture(t);
  const saved = await run(root, ["src", "--baseline", "jsxDepth=2", "--save-baseline", "baseline.json"]);
  assert.equal(saved.code, 0, saved.stderr);
  const compared = await run(root, ["src", "--baseline", "jsxDepth=2", "--compare-baseline", "baseline.json", "--max-score", "0", "--format", "json"]);
  assert.equal(compared.code, 1);
  assert.equal(JSON.parse(compared.stdout).comparison.summary.regressions, 0);
  assert.equal(JSON.parse(compared.stdout).failures.length, 1);
});

test("comparison output supports JSON, CSV, Markdown, list, and single-file explain", async (t) => {
  const root = await fixture(t);
  const source = "src/App.jsx";
  await run(root, [source, "--save-baseline", "baseline.json"]);
  await writeFile(path.join(root, source), "export const App = () => <div><span/></div>;\n");
  for (const format of ["json", "csv", "md", "list", "table"]) {
    const compared = await run(root, [source, "--compare-baseline", "baseline.json", "--format", format, "--explain"]);
    assert.equal(compared.code, 1);
    assert.match(compared.stdout, /worsened/);
    if (format === "json") assert.equal(JSON.parse(compared.stdout).comparison.summary.regressions, 1);
    else assert.doesNotMatch(compared.stdout, /score = Σ/);
  }
});

test("library API supports saving and comparing baselines", async (t) => {
  const root = await fixture(t);
  const saved = await analyze("src", { cwd: root, saveBaseline: "baseline.json" });
  assert.equal(saved.baselineSaved, "baseline.json");
  const compared = await analyze("src", { cwd: root, compareBaseline: "baseline.json", baselineTolerance: 1 });
  assert.equal(compared.comparison.summary.unchanged, 1);
  assert.equal(compared.comparison.tolerance, 1);
});

test("empty scans compare successfully and removed last entries are visible", () => {
  const empty = snapshot([]);
  assert.equal(compareBaseline(empty, empty).summary.regressions, 0);
  const removed = compareBaseline(snapshot([result("src/A.jsx", 2)]), empty);
  const output = formatReport({ comparison: removed }, config({ format: "table" }));
  assert.match(output, /removed/);
  assert.equal(removed.summary.regressions, 0);
});
