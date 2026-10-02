import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { analyzeComponents, analyzeSource } from "./analyze.js";
import { ignorePatterns } from "./config.js";

const HARD_SKIP = new Set(["node_modules", ".git"]);

export async function collectFiles(paths, config) {
  const roots = paths.length ? paths : [config.cwd];
  const base = ignore({ ignorecase: false }).add(ignorePatterns(config));
  const files = [];
  const skipped = [];
  const seen = new Set();
  for (const root of roots) {
    const abs = path.resolve(config.cwd, root);
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new Error(`Path not found: ${root}`);
    }
    if (info.isFile()) {
      if (roots.length > 1 && (await explicitFileIgnored(abs, config, base))) continue;
      files.push(abs);
      continue;
    }
    if (!info.isDirectory()) continue;
    if (!(await markSeen(abs, seen))) continue;
    const layers = config.useGitignore ? await loadParentGitignores(abs) : [];
    await walk(abs, abs, config, base, layers, files, skipped, seen);
  }
  return { files: unique(files), skipped };
}

async function walk(dir, root, config, base, layers, files, skipped, seen) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ file: dir, reason: error.message });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = await stat(full);
      } catch (error) {
        skipped.push({ file: full, reason: error.message });
        continue;
      }
      if (!(await markSeen(full, seen))) continue;
      if (target.isDirectory()) {
        if (shouldSkipDir(entry.name, config)) continue;
        if (pathIgnored(full, root, true, base, layers)) continue;
        const nextLayers = layers.slice();
        await addGitignore(full, nextLayers);
        await walk(full, root, config, base, nextLayers, files, skipped, seen);
      } else if (target.isFile()) {
        considerFile(full, root, config, base, layers, files);
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, config)) continue;
      if (pathIgnored(full, root, true, base, layers)) continue;
      if (!(await markSeen(full, seen))) continue;
      const nextLayers = layers.slice();
      await addGitignore(full, nextLayers);
      await walk(full, root, config, base, nextLayers, files, skipped, seen);
      continue;
    }
    if (!entry.isFile()) continue;
    considerFile(full, root, config, base, layers, files);
  }
}

function considerFile(full, root, config, base, layers, files) {
  if (!hasExtension(path.basename(full), config.extensions)) return;
  if (pathIgnored(full, root, false, base, layers)) return;
  files.push(full);
}

function shouldSkipDir(name, config) {
  if (HARD_SKIP.has(name)) return true;
  return config.skipDirs.includes(name);
}

function pathIgnored(abs, root, isDir, base, layers) {
  const rel = toPosix(path.relative(root, abs));
  if (rel && base.ignores(isDir ? `${rel}/` : rel)) return true;
  return ignoredByLayers(abs, isDir, layers);
}

async function explicitFileIgnored(abs, config, base) {
  const layers = config.useGitignore ? await loadParentGitignores(path.dirname(abs)) : [];
  const name = path.basename(abs);
  if (!hasExtension(name, config.extensions) && !config.extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()))) {
    return false;
  }
  return pathIgnored(abs, path.dirname(abs), false, base, layers);
}

async function loadParentGitignores(startDir) {
  const layers = [];
  const dirs = [];
  let dir = startDir;
  for (let i = 0; i < 16; i++) {
    dirs.push(dir);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.reverse();
  for (const item of dirs) await addGitignore(item, layers);
  return layers;
}

async function addGitignore(dir, layers) {
  if (layers.some((layer) => layer.dir === dir)) return;
  try {
    const text = await readFile(path.join(dir, ".gitignore"), "utf8");
    layers.push({ dir, matcher: ignore({ ignorecase: false }).add(text) });
  } catch {
    // no gitignore here
  }
}

function ignoredByLayers(abs, isDir, layers) {
  let matched = null;
  for (const layer of layers) {
    const rel = toPosix(path.relative(layer.dir, abs));
    if (!rel || rel.startsWith("..")) continue;
    const result = layer.matcher.test(isDir ? `${rel}/` : rel);
    if (result.ignored || result.unignored) matched = result;
  }
  return Boolean(matched?.ignored);
}

export async function analyzePaths(paths, config, onProgress) {
  const list = normalizePaths(paths);
  const { files, skipped } = await collectFiles(list, config);
  const results = [];
  const errors = [];
  let index = 0;
  for (const file of files) {
    index += 1;
    if (onProgress) onProgress(index, files.length, file);
    let code;
    try {
      const info = await stat(file);
      if (info.size > config.maxFileBytes) {
        errors.push({
          file,
          parseError: `File exceeds maxFileBytes (${info.size} > ${config.maxFileBytes})`,
          kind: "file",
        });
        continue;
      }
      code = await readFile(file, "utf8");
    } catch (error) {
      errors.push({ file, parseError: error.message, kind: "file" });
      continue;
    }
    if (config.by === "component") {
      const units = analyzeComponents(code, file, config);
      for (const unit of units) {
        if (unit.parseError && !unit.partial) {
          errors.push(unit);
          continue;
        }
        if (!config.allFiles && !unit.react) continue;
        results.push(unit);
      }
      continue;
    }
    const result = analyzeSource(code, file, config);
    if (result.parseError && !result.partial) {
      errors.push(result);
      continue;
    }
    if (result.parseError) errors.push(result);
    if (!config.allFiles && !result.react) continue;
    if (!result.parseError || result.partial) results.push(result);
  }
  return { results, errors, filesScanned: files.length, skipped };
}

export function rankResults(results, config) {
  const minScore = config.minScore || 0;
  const filtered = results.filter((item) => item.score >= minScore);
  const sortKey = config.sort;
  const stringSort = sortKey === "file" || sortKey === "name";
  const direction = stringSort ? (config.reverse ? -1 : 1) : config.reverse ? 1 : -1;
  filtered.sort((a, b) => {
    const delta = compareValue(valueOf(a, sortKey), valueOf(b, sortKey));
    if (delta !== 0) return delta * direction;
    return displayName(a).localeCompare(displayName(b));
  });
  const total = filtered.length;
  const shown = config.top === 0 ? filtered : filtered.slice(0, config.top);
  return { shown, total };
}

export function failures(results, failOn = {}) {
  const failed = [];
  for (const result of results) {
    for (const [key, limit] of Object.entries(failOn)) {
      const value = key === "score" || key === "density" ? result[key] : result.metrics?.[key];
      if (typeof value === "number" && value > limit) {
        failed.push({ ...result, failedOn: key, failedValue: value, failedLimit: limit });
        break;
      }
    }
  }
  return failed;
}

function valueOf(result, key) {
  if (key === "score" || key === "density") return result[key];
  if (key === "file" || key === "name") return displayName(result);
  return result.metrics?.[key] ?? 0;
}

function compareValue(a, b) {
  if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b));
  return a - b;
}

function displayName(result) {
  return result.name ? `${result.file}:${result.name}` : result.file;
}

function hasExtension(name, extensions) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".d.ts") && !extensions.some((ext) => ext.toLowerCase() === ".d.ts")) return false;
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function unique(items) {
  return [...new Set(items)];
}

function normalizePaths(paths) {
  if (paths == null) return ["."];
  return Array.isArray(paths) ? paths : [paths];
}

async function markSeen(target, seen) {
  let real = target;
  try {
    real = await realpath(target);
  } catch {
    real = target;
  }
  if (seen.has(real)) return false;
  seen.add(real);
  return true;
}
