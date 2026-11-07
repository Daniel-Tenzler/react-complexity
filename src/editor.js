import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Commands are tokenized, never evaluated by a shell. Backslashes remain literal
// so quoted Windows executable paths work just like POSIX paths.
export function splitEditorCommand(command) {
  if (typeof command !== "string" || !command.trim()) throw new Error("Editor command must not be empty.");
  if (existsSync(command)) return [command];
  const tokens = [];
  let token = "";
  let quote = null;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
    } else token += char;
  }
  if (quote) throw new Error("Unclosed quote in editor command.");
  if (token) tokens.push(token);
  if (!tokens.length) throw new Error("Editor command must not be empty.");
  return tokens;
}

export function editorLaunch(file, location = {}, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const [command, ...extra] = splitEditorCommand(options.editor ?? (env.VISUAL?.trim() || env.EDITOR?.trim() || "code"));
  const name = path.win32.basename(command).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const line = Number.isInteger(location.line) && location.line > 0 ? location.line : 1;
  const column = Number.isInteger(location.column) && location.column > 0 ? location.column : 1;
  const target = path.resolve(options.cwd || process.cwd(), file);
  let args;
  let terminal = false;
  if (["code", "code-insiders", "cursor"].includes(name)) args = ["--reuse-window", "--goto", `${target}:${line}:${column}`];
  else if (["subl", "sublime_text", "zed"].includes(name)) args = [`${target}:${line}:${column}`];
  else if (["vim", "nvim", "vi"].includes(name)) {
    terminal = true;
    args = [`+call cursor(${line},${column})`, "--", target];
  } else if (name === "nano") {
    terminal = true;
    args = [`+${line},${column}`, "--", target];
  } else throw new Error(`Unsupported editor "${name}". Use code, code-insiders, cursor, zed, subl, vim, nvim, vi, or nano (or a path to one).`);

  let executable = command;
  if (platform === "win32" && ["code", "code-insiders", "cursor"].includes(name)) {
    // VS Code/Cursor expose .cmd shims on Windows. Invoke the real GUI executable
    // instead: shell execution would allow metacharacters in filenames to run.
    executable = windowsGuiExecutable(command, name, env, options.exists || existsSync);
  } else if (/\.(cmd|bat)$/i.test(command)) {
    throw new Error("Batch editor commands are not supported. Specify the editor executable instead.");
  }
  return { command: executable, args: [...extra, ...args], terminal, target, line, column };
}

function windowsGuiExecutable(command, name, env, exists) {
  if (/\.exe$/i.test(command)) return command;
  const binary = name === "cursor" ? "Cursor.exe" : name === "code-insiders" ? "Code - Insiders.exe" : "Code.exe";
  const folder = name === "cursor" ? "cursor" : name === "code-insiders" ? "Microsoft VS Code Insiders" : "Microsoft VS Code";
  const candidates = [];
  if (/[\\/]/.test(command)) candidates.push(path.win32.resolve(path.win32.dirname(command), "..", binary));
  for (const dir of (env.PATH || env.Path || "").split(";").filter(Boolean)) {
    const clean = dir.replace(/^"|"$/g, "");
    candidates.push(path.win32.join(clean, binary));
    if (exists(path.win32.join(clean, `${name}.cmd`))) candidates.push(path.win32.resolve(clean, "..", binary));
  }
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, "Programs", folder, binary));
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean)) candidates.push(path.win32.join(root, folder, binary));
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) throw new Error(`Cannot locate ${binary}. Pass --editor with its full .exe path, or choose another installed editor.`);
  return found;
}

export async function openInEditor(file, location, options = {}) {
  const launch = editorLaunch(file, location, options);
  const start = options.spawn || spawn;
  // A terminal editor shares our foreground process group. Let it handle Ctrl-C
  // without also terminating the explorer that should resume when it exits.
  const interrupt = () => {};
  if (launch.terminal) process.on("SIGINT", interrupt);
  try {
    await new Promise((resolve, reject) => {
      const child = start(launch.command, launch.args, {
        cwd: options.cwd,
        env: options.env || process.env,
        shell: false,
        stdio: launch.terminal ? "inherit" : "ignore",
        detached: !launch.terminal,
      });
      child.once("error", (error) => reject(new Error(`Could not launch editor: ${error.message}. Set --editor, VISUAL, or EDITOR.`)));
      if (launch.terminal) {
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Editor exited ${signal ? `with signal ${signal}` : `with code ${code}`}.`));
        });
      } else child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } finally {
    if (launch.terminal) process.off("SIGINT", interrupt);
  }
  return launch;
}
