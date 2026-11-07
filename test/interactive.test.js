import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import { analyzeSource, analyzeComponents } from "../src/analyze.js";
import { defaults } from "../src/config.js";
import { main, parseArgv } from "../src/cli.js";
import { exploreReport } from "../src/interactive.js";

const config = { ...defaults(), cwd: process.cwd(), color: false };
function entry(name = "App", source = "export function App() { useEffect(() => {}); return <div/>; }") {
  return analyzeSource(source, path.resolve(`${name}.jsx`), config);
}

async function explore(results, commands, extra = {}) {
  let stdout = "";
  let stderr = "";
  await exploreReport({ results }, config, {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    prompt: async () => commands.shift() ?? null,
    ...extra,
  });
  return { stdout, stderr };
}

test("explorer selects ranked entries and shows numbered source-linked findings", async () => {
  const result = await explore([entry()], ["1", "b", "q"]);
  assert.match(result.stdout, /React complexity explorer/);
  assert.match(result.stdout, /points\s+metric/);
  assert.match(result.stdout, /\[1\] App.jsx:1:25/);
  assert.match(result.stdout, /may be intentional/);
  assert.equal(result.stderr, "");
});

test("editor opens a specific finding, and opening an entry uses its component location", async () => {
  const units = analyzeComponents("\n\nexport const Child = () => { useEffect(() => {}); return <span/>; };", path.resolve("App.jsx"), config);
  const calls = [];
  const result = await explore(units, ["1", "o 1", "o", "q"], {
    editor: "nvim",
    openEditor: async (...args) => { calls.push(args); },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1], units[0].findings[0].location.start);
  assert.deepEqual(calls[1][1], units[0].location.start);
  assert.equal(calls[1][1].line, 3);
  assert.equal(calls[0][2].editor, "nvim");
  assert.match(result.stdout, /Editor launched: App.jsx:3:/);
});

test("file entries without findings open at line 1", async () => {
  let location;
  const result = await explore([entry("Tiny", "export const Tiny = () => <span/>;")], ["1", "o 1", "o", "q"], {
    openEditor: async (file, start) => { location = start; },
  });
  assert.match(result.stderr, /valid finding number/);
  assert.deepEqual(location, { line: 1, column: 1 });
});

test("pagination, filtering, clearing filters, and sorting navigate all entries", async () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ ...entry(`File${i}`), score: i }));
  const result = await explore(entries, ["n", "n", "p", "/File11", "/", "s file", "s notAMetric", "q"]);
  assert.match(result.stdout, /Page 1\/2/);
  assert.match(result.stdout, /Page 2\/2/);
  assert.match(result.stdout, /1 entries · sort score · filter "File11"/);
  assert.match(result.stdout, /12 entries · sort file/);
  assert.match(result.stderr, /Unknown sort/);
});

test("invalid selections and editor failures do not exit the explorer", async () => {
  const result = await explore([entry()], ["0", "999", "99999999999999999999", "?", "1", "o 0", "o 2", "o", "b", "q"], {
    openEditor: async () => { throw new Error("Editor not installed"); },
  });
  assert.match(result.stderr, /valid result number/);
  assert.match(result.stderr, /valid finding number/);
  assert.match(result.stderr, /Editor not installed/);
  assert.equal((result.stdout.match(/React complexity explorer/g) || []).length, 2);
});

test("empty or filtered-out results and EOF terminate cleanly", async () => {
  const empty = await explore([], ["q"]);
  assert.match(empty.stdout, /No matching entries/);
  const filtered = await explore([entry()], ["/missing"]);
  assert.match(filtered.stdout, /No matching entries/);
  assert.equal(filtered.stderr, "");
});

test("real readline input closes and restores raw mode after EOF", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const running = exploreReport({ results: [entry()] }, config, { stdin: input, stdout: output });
  input.end("1\nb\nq\n");
  await running;
  assert.match(text, /points\s+metric/);
  assert.equal(input.isRaw, false);
});

test("readline releases raw mode during editor launch and restores it on return", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  output.resume();
  let launched = false;
  const running = exploreReport({ results: [entry()] }, config, {
    stdin: input, stdout: output,
    openEditor: async () => {
      launched = true;
      assert.equal(input.isRaw, false);
    },
  });
  // Do not end the stream until readline has resumed after launching the editor.
  output.on("data", (chunk) => {
    if (chunk.toString().includes("Editor launched:")) queueMicrotask(() => input.end("q\n"));
  });
  input.write("1\no\n");
  await running;
  assert.equal(launched, true);
  assert.equal(input.isRaw, false);
});

test("Ctrl-C closes the explorer and restores terminal mode", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  output.resume();
  const running = exploreReport({ results: [entry()] }, config, { stdin: input, stdout: output });
  input.write("\x03");
  await running;
  assert.equal(input.isRaw, false);
});

test("readline restores terminal mode after editor failure", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  output.resume();
  errors.on("data", () => queueMicrotask(() => input.end("q\n")));
  const running = exploreReport({ results: [entry()] }, config, {
    stdin: input, stdout: output, stderr: errors,
    openEditor: async () => { throw new Error("Cannot launch editor"); },
  });
  input.write("1\no\n");
  await running;
  assert.equal(input.isRaw, false);
});

test("explorer ignores --top but respects minimum scores and reverse sorting", async () => {
  let output = "";
  await exploreReport({ results: [
    { ...entry("Small"), score: 1 },
    { ...entry("Medium"), score: 5 },
    { ...entry("Large"), score: 10 },
  ] }, { ...config, top: 1, minScore: 5, reverse: true }, {
    stdout: { write: (text) => { output += text; } }, prompt: async () => "q",
  });
  assert.match(output, /2 entries/);
  assert.doesNotMatch(output, /Small.jsx/);
  assert.ok(output.indexOf("Medium.jsx") < output.indexOf("Large.jsx"));
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "react-complexity-explore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "App.jsx"), "export function App() { useEffect(() => {}); return <div/>; }");
  return root;
}

async function run(root, args, extra = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd: root, stdin: { isTTY: true },
    stdout: { isTTY: true, write: (text) => { stdout += text; } },
    stderr: { isTTY: false, write: (text) => { stderr += text; } },
    ...extra,
  });
  return { code, stdout, stderr };
}

test("CLI supports explicit interactive mode without changing ordinary commands", async (t) => {
  const root = await fixture(t);
  const commands = ["1", "o 1", "q"];
  let opened = false;
  const interactive = await run(root, ["src", "-i", "--editor", "nvim"], {
    prompt: async () => commands.shift(), openEditor: async () => { opened = true; },
  });
  assert.equal(interactive.code, 0, interactive.stderr);
  assert.match(interactive.stdout, /explorer/);
  assert.equal(opened, true);
  const ordinary = await run(root, ["src"]);
  assert.doesNotMatch(ordinary.stdout, /explorer/);
  assert.equal(ordinary.code, 0);
  assert.equal(parseArgv(["-i"]).interactive, true);
});

test("CLI rejects non-TTY use, machine formats, and --editor without interaction", async (t) => {
  const root = await fixture(t);
  const pipe = await run(root, ["src", "--interactive"], { stdin: { isTTY: false } });
  assert.equal(pipe.code, 1);
  assert.match(pipe.stderr, /requires an interactive terminal/);
  const redirected = await run(root, ["src", "--interactive"], { stdout: { isTTY: false, write: () => {} } });
  assert.equal(redirected.code, 1);
  assert.match(redirected.stderr, /requires an interactive terminal/);
  for (const format of ["json", "csv", "md", "list"]) {
    const report = await run(root, ["src", "-i", "--format", format]);
    assert.equal(report.code, 1);
    assert.match(report.stderr, /requires --format table/);
  }
  const editor = await run(root, ["src", "--editor", "vim"]);
  assert.equal(editor.code, 1);
  assert.match(editor.stderr, /requires --interactive/);
});

test("interactive exploration preserves threshold exit codes", async (t) => {
  const root = await fixture(t);
  const result = await run(root, ["src", "--interactive", "--max-score", "0"], { prompt: async () => "q" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed/);
  assert.match(result.stdout, /explorer/);
});

test("interactive baseline comparisons show changes first and keep regression exit codes", async (t) => {
  const root = await fixture(t);
  await run(root, ["src", "--save-baseline", "baseline.json"]);
  await writeFile(path.join(root, "src", "App.jsx"), "export function App() { useEffect(() => {}); return <div><span/></div>; }");
  const result = await run(root, ["src", "--interactive", "--compare-baseline", "baseline.json"], { prompt: async () => "q" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /worsened/);
  assert.match(result.stdout, /explorer/);
  assert.ok(result.stdout.indexOf("Baseline:") < result.stdout.indexOf("React complexity explorer"));
  assert.equal((result.stderr.match(/Regression/g) || []).length, 1);
});
