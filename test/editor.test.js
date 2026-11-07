import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import { editorLaunch, openInEditor, splitEditorCommand } from "../src/editor.js";

test("editor commands preserve quoted paths and literal Windows backslashes", () => {
  assert.deepEqual(splitEditorCommand('"C:\\Program Files\\Microsoft VS Code\\Code.exe" --wait'), ["C:\\Program Files\\Microsoft VS Code\\Code.exe", "--wait"]);
  assert.deepEqual(splitEditorCommand("'/usr/local/bin/code' --new-window"), ["/usr/local/bin/code", "--new-window"]);
  assert.throws(() => splitEditorCommand('"unfinished'), /Unclosed quote/);
  assert.throws(() => splitEditorCommand(" "), /must not be empty/);
});

test("editor choice prioritizes --editor, then VISUAL, EDITOR, and code", () => {
  const options = { platform: "linux", env: { VISUAL: "cursor", EDITOR: "vim" } };
  assert.equal(editorLaunch("App.jsx", {}, { ...options, editor: "zed" }).command, "zed");
  assert.equal(editorLaunch("App.jsx", {}, options).command, "cursor");
  assert.equal(editorLaunch("App.jsx", {}, { ...options, env: { EDITOR: "vim" } }).command, "vim");
  assert.equal(editorLaunch("App.jsx", {}, { ...options, env: {} }).command, "code");
  assert.equal(editorLaunch("App.jsx", {}, { ...options, env: { VISUAL: "", EDITOR: "nvim" } }).command, "nvim");
});

test("supported editors receive exact locations as argument arrays", () => {
  const target = path.resolve("src", "App with spaces.jsx");
  for (const name of ["code", "code-insiders", "cursor", "zed", "subl", "sublime_text", "vim", "nvim", "vi", "nano"]) {
    const launch = editorLaunch(target, { line: 42, column: 7 }, { editor: name, platform: "linux", env: {} });
    assert.equal(launch.line, 42);
    assert.equal(launch.column, 7);
    if (["vim", "nvim", "vi"].includes(name)) assert.deepEqual(launch.args, ["+call cursor(42,7)", "--", target]);
    else if (name === "nano") assert.deepEqual(launch.args, ["+42,7", "--", target]);
    else assert.equal(launch.args.at(-1), `${target}:42:7`);
  }
  assert.deepEqual(editorLaunch(target, {}, { editor: "code --wait", platform: "linux", env: {} }).args, ["--wait", "--reuse-window", "--goto", `${target}:1:1`]);
  assert.throws(() => editorLaunch(target, {}, { editor: "unknown-editor" }), /Unsupported editor/);
});

test("invalid locations fall back to line and column 1", () => {
  for (const value of [0, -1, NaN, 1.5, "2"]) {
    const launch = editorLaunch("App.jsx", { line: value, column: value }, { editor: "nvim" });
    assert.equal(launch.line, 1);
    assert.equal(launch.column, 1);
  }
});

test("Windows code shims resolve to a real executable without a command shell", () => {
  const executable = "C:\\Apps\\VS Code\\Code.exe";
  const shim = "C:\\Apps\\VS Code\\bin\\code.cmd";
  const options = { platform: "win32", env: { PATH: "C:\\Apps\\VS Code\\bin" }, exists: (file) => [shim, executable].includes(file) };
  assert.equal(editorLaunch("App.jsx", {}, { ...options, editor: "code" }).command, executable);
  assert.equal(editorLaunch("App.jsx", {}, { ...options, editor: `"${shim}"` }).command, executable);
  assert.equal(editorLaunch("App.jsx", {}, { ...options, editor: `"${executable}"` }).command, executable);
  assert.throws(() => editorLaunch("App.jsx", {}, { ...options, exists: () => false, editor: "code" }), /Cannot locate Code.exe/);
  assert.throws(() => editorLaunch("App.jsx", {}, { editor: "vim.cmd" }), /Batch editor commands/);
});

test("Windows per-user Cursor installation is detected", () => {
  const executable = "C:\\Users\\User\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
  const launch = editorLaunch("App.jsx", {}, {
    editor: "cursor", platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local" },
    exists: (file) => file === executable,
  });
  assert.equal(launch.command, executable);
});

function fakeSpawn(event, value, onStart) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    onStart?.({ command, args, options, child });
    queueMicrotask(() => child.emit(event, value));
    return child;
  };
}

test("GUI launch is detached, shell-free, and preserves metacharacters in filenames", async () => {
  let invocation;
  const filename = path.resolve("App & $(echo nope) %PATH%.jsx");
  await openInEditor(filename, { line: 8, column: 3 }, {
    editor: "code", platform: "linux", env: {},
    spawn: fakeSpawn("spawn", undefined, (call) => { invocation = call; }),
  });
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.stdio, "ignore");
  assert.equal(invocation.args.at(-1), `${filename}:8:3`);
  assert.equal(invocation.child.unreferenced, true);
});

test("terminal editors inherit the terminal and release interrupt handlers", async () => {
  const before = process.listenerCount("SIGINT");
  let invocation;
  await openInEditor("App.jsx", {}, { editor: "vim", spawn: fakeSpawn("exit", 0, (call) => { invocation = call; }) });
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.detached, false);
  assert.equal(invocation.child.unreferenced, undefined);
  assert.equal(process.listenerCount("SIGINT"), before);
  await assert.rejects(() => openInEditor("App.jsx", {}, { editor: "vim", spawn: fakeSpawn("exit", 1) }), /with code 1/);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("spawn failures produce actionable errors", async () => {
  await assert.rejects(() => openInEditor("App.jsx", {}, {
    editor: "code", platform: "linux", env: {}, spawn: fakeSpawn("error", new Error("ENOENT")),
  }), /Set --editor, VISUAL, or EDITOR/);
});
