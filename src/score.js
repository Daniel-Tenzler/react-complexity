import { METRIC_KEYS } from "./schema.js";

export function scoreMetrics(metrics, weights, baselines) {
  const breakdown = {};
  let score = 0;
  for (const key of METRIC_KEYS) {
    const weight = Number(weights?.[key] ?? 0);
    const baseline = Number(baselines?.[key] ?? 0);
    const raw = Number(metrics?.[key] ?? 0);
    const excess = Math.max(0, raw - baseline);
    const points = excess * weight;
    breakdown[key] = { raw, baseline, excess, weight, points };
    score += points;
  }
  const sloc = Number(metrics?.sloc ?? 0);
  const density = sloc > 0 ? (score / sloc) * 100 : 0;
  return {
    score: round(score),
    density: round(density),
    breakdown,
    drivers: topDrivers(breakdown, 3),
  };
}

export function topDrivers(breakdown, count = 3) {
  return Object.entries(breakdown)
    .filter(([, item]) => item.points > 0)
    .sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([key, item]) => ({ metric: key, points: round(item.points) }));
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
