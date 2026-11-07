import { analyzeComponents, analyzeSource } from "./analyze.js";
import { resolveConfig } from "./config.js";
import { analyzePaths, failures, rankResults } from "./scan.js";
import { METRICS, METRIC_KEYS, DEFAULT_WEIGHTS, DEFAULT_BASELINES } from "./schema.js";
import { baselineReport } from "./baseline.js";

export { analyzeSource, analyzeComponents, resolveConfig, analyzePaths, rankResults, failures };
export { METRICS, METRIC_KEYS, DEFAULT_WEIGHTS, DEFAULT_BASELINES };
export { createBaseline, compareBaseline, readBaseline, writeBaseline, BASELINE_VERSION } from "./baseline.js";

export async function analyze(paths, options = {}) {
  const list = paths == null ? ["."] : Array.isArray(paths) ? paths : [paths];
  const config = await resolveConfig({
    cwd: options.cwd || process.cwd(),
    paths: list,
    cli: options,
    configPath: options.config || null,
  });
  const analyzed = await analyzePaths(list, config);
  const ranked = rankResults(analyzed.results, config);
  const failed = failures(analyzed.results, config.failOn);
  const baseline = await baselineReport(analyzed, config, list, options);
  return { ...analyzed, ...ranked, failed, config, ...baseline };
}
