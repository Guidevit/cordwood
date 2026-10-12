// What the counts of an experiment say: whether the split came out as planned, and how an arm compares
// with the control.

/** The standard normal's CDF, by Abramowitz and Stegun's 7.1.26 (error below 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** ln Γ(x), by Lanczos. */
function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let series = 1.000000000190015;
  for (let i = 0; i < coefficients.length; i++) series += coefficients[i]! / (x + 1 + i);
  const t = x + 5.5;
  return (x + 0.5) * Math.log(t) - t + Math.log((2.5066282746310005 * series) / x);
}

/** Q(a, x), the upper regularized incomplete gamma: a series below a + 1, a continued fraction above. */
function upperGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  const scale = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 500 && Math.abs(term) > Math.abs(sum) * 1e-14; n++) {
      term *= x / (a + n);
      sum += term;
    }
    return Math.max(0, 1 - sum * scale);
  }
  const TINY = 1e-300;
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.min(1, h * scale);
}

export type SplitCheck = {
  /** How likely a split this far from the weights is when the assignment works. */
  pValue: number;
  /** True below 0.001: the arms did not receive what the weights say, and no comparison can be trusted. */
  mismatch: boolean;
};

/**
 * Sample ratio mismatch: a chi-square test of the units each arm received against its weight. A
 * mismatch means something other than the hash decided who was counted (a redirect that loses one
 * arm's visitors, a robot filter that fits one page), and it biases every rate.
 */
export function splitCheck(observed: readonly number[], weights: readonly number[]): SplitCheck {
  const total = observed.reduce((sum, n) => sum + n, 0);
  const weight = weights.reduce((sum, w) => sum + w, 0);
  if (observed.length < 2 || total === 0) return { pValue: 1, mismatch: false };
  let chi = 0;
  for (let i = 0; i < observed.length; i++) {
    const expected = (total * weights[i]!) / weight;
    chi += (observed[i]! - expected) ** 2 / expected;
  }
  const pValue = upperGamma((observed.length - 1) / 2, chi / 2);
  return { pValue, mismatch: pValue < 0.001 };
}

export type Counted = { exposed: number; converted: number };

export type Comparison = {
  /** The arm's rate minus the control's, in absolute points of a rate: 0.02 is two points. */
  difference: number;
  /** The 95% interval of that difference. */
  interval: [number, number];
  /** Two-sided, from a two-proportion z-test. It means what it says only when read once. */
  pValue: number;
};

const Z_95 = 1.959963984540054;
const Z_POWER_80 = 0.8416212335729143;

/** An arm against the control for one goal. Null while either has nobody. */
export function compare(control: Counted, arm: Counted): Comparison | null {
  if (control.exposed <= 0 || arm.exposed <= 0) return null;
  const pc = control.converted / control.exposed;
  const pa = arm.converted / arm.exposed;
  const difference = pa - pc;
  const pooled = (control.converted + arm.converted) / (control.exposed + arm.exposed);
  const pooledError = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposed + 1 / arm.exposed));
  const pValue = pooledError === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(difference) / pooledError));
  const error = Math.sqrt((pc * (1 - pc)) / control.exposed + (pa * (1 - pa)) / arm.exposed);
  return {
    difference,
    interval: [difference - Z_95 * error, difference + Z_95 * error],
    pValue: Math.min(1, Math.max(0, pValue)),
  };
}

/**
 * The units each arm needs to find a difference of `detectable` over a control rate of `baseline`,
 * both as rates (0.1 is 10%), at 5% two-sided significance and 80% power. Decide it before the first
 * visitor and write it as `perArm`.
 */
export function sampleSize(baseline: number, detectable: number): number {
  const other = baseline + detectable;
  if (!(baseline > 0 && baseline < 1) || !(other > 0 && other < 1) || detectable === 0)
    throw new Error("baseline and baseline + detectable must be rates between 0 and 1, and differ");
  const mean = (baseline + other) / 2;
  const n =
    (Z_95 * Math.sqrt(2 * mean * (1 - mean)) +
      Z_POWER_80 * Math.sqrt(baseline * (1 - baseline) + other * (1 - other))) **
      2 /
    detectable ** 2;
  return Math.ceil(n);
}
