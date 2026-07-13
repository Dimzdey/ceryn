export const PERCENTILE_MIN_SAMPLES = Object.freeze({
  p90: 100,
  p95: 200,
  p99: 1_000,
  p999: 10_000,
});

function sortedCopy(samples) {
  return [...samples].sort((left, right) => left - right);
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((sorted.length * percentile) / 100) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function calculatePercentiles(samples) {
  if (samples.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      p999: 0,
      stddev: 0,
      samples: 0,
    };
  }

  const sorted = sortedCopy(samples);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance =
    sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length;

  return {
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    p999: nearestRank(sorted, 99.9),
    stddev: Math.sqrt(variance),
    samples: sorted.length,
  };
}

export function percentileEligibility(samples) {
  return {
    p90: samples >= PERCENTILE_MIN_SAMPLES.p90,
    p95: samples >= PERCENTILE_MIN_SAMPLES.p95,
    p99: samples >= PERCENTILE_MIN_SAMPLES.p99,
    p999: samples >= PERCENTILE_MIN_SAMPLES.p999,
  };
}

export function summarizeDistribution(samples) {
  if (samples.length === 0) {
    return { samples: 0, min: 0, q1: 0, median: 0, q3: 0, iqr: 0, max: 0 };
  }

  const sorted = sortedCopy(samples);
  const q1 = nearestRank(sorted, 25);
  const q3 = nearestRank(sorted, 75);
  return {
    samples: sorted.length,
    min: sorted[0],
    q1,
    median: nearestRank(sorted, 50),
    q3,
    iqr: q3 - q1,
    max: sorted.at(-1),
  };
}

export function deterministicShuffle(values, seed) {
  const shuffled = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };

  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function logarithmicHistogram(samples) {
  const counts = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample <= 0) continue;
    const exponent = Math.floor(Math.log2(sample));
    counts.set(exponent, (counts.get(exponent) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([exponent, count]) => ({
      lowerBound: 2 ** exponent,
      upperBound: 2 ** (exponent + 1) - 1,
      count,
    }));
}
