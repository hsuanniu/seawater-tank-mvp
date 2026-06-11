export const DEFAULT_TANK = {
  name: "我的海水缸",
  volume: 200,
  targets: {
    kh: { min: 7.5, max: 8.5 },
    ca: { min: 400, max: 450 },
    mg: { min: 1320, max: 1400 },
    k: { min: 390, max: 420 },
    no3: { min: 0.5, max: 2 },
    po4: { min: 0.02, max: 0.08 },
  },
  targetInputs: {
    kh: "7.5-8.5",
    ca: "400-450",
    mg: "1320-1400",
    k: "390-420",
    no3: "0.5-2",
    po4: "0.02-0.08",
  },
};

export const PARAMETERS = [
  { key: "kh", label: "KH", unit: "dKH", tolerance: 0.2, singleTolerance: 0.5, doseKey: "kh", minAdjust: 0.05, maxAdjust: 0.1 },
  { key: "ca", label: "CA", unit: "ppm", tolerance: 10, singleTolerance: 20, doseKey: "ca", minAdjust: 0.05, maxAdjust: 0.15 },
  { key: "mg", label: "MG", unit: "ppm", tolerance: 30, singleTolerance: 30, doseKey: "mg", minAdjust: 0.1, maxAdjust: 0.2 },
  { key: "k", label: "鉀(K)", unit: "ppm", tolerance: 10, singleTolerance: 20, doseKey: "kplus", minAdjust: 0, maxAdjust: 0 },
  { key: "no3", label: "NO3", unit: "ppm", tolerance: 0.5, singleTolerance: 0.5 },
  { key: "po4", label: "PO4", unit: "ppm", tolerance: 0.02, singleTolerance: 0.02 },
];

export function normalizeTarget(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a <= b ? { min: a, max: b } : { min: b, max: a };
}

export function targetSpan(target) {
  return Math.max(target.max - target.min, 0.0001);
}

export function cleanTargetInput(value) {
  return String(value || "")
    .trim()
    .replace(/[，]/g, ".")
    .replace(/[－–—]/g, "-")
    .replace(/±/g, "+/-")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/ppm|dkh/g, "");
}

export function parseTargetExpression(input, param) {
  const text = cleanTargetInput(input);
  if (!text) return null;

  const plusMinus = text.match(/^(-?\d+(?:\.\d+)?)\+\/-(-?\d+(?:\.\d+)?)$/);
  if (plusMinus) {
    const center = Number(plusMinus[1]);
    const spread = Math.abs(Number(plusMinus[2]));
    return normalizeTarget(center - spread, center + spread);
  }

  const range = text.match(/^(-?\d+(?:\.\d+)?)[~-](-?\d+(?:\.\d+)?)$/);
  if (range) return normalizeTarget(Number(range[1]), Number(range[2]));

  const single = text.match(/^-?\d+(?:\.\d+)?$/);
  if (single) {
    const center = Number(single[0]);
    const spread = param.singleTolerance || 0;
    return normalizeTarget(center - spread, center + spread);
  }

  return null;
}
