export const ADDITIVE_TYPES = [
  { value: "red-sea-ab-plus", label: "Red Sea AB+", group: "coral-nutrition" },
  { value: "tm-a-plus", label: "Tropic Marin A+", group: "trace-additive" },
  { value: "tm-k-plus", label: "Tropic Marin K+", group: "trace-additive" },
  { value: "amin-amino", label: "AMIN（胺基酸）", group: "amino" },
  { value: "tm-nitribiotic", label: "TM 硝化益生菌", group: "bacteria" },
];

const LEGACY_ADDITIVE_VALUES = {
  "AB+": "red-sea-ab-plus",
  "TM 硝化益生菌": "tm-nitribiotic",
  "AMIN（胺基酸）": "amin-amino",
};

export const ADDITIVE_FREQUENCIES = ["單次", "每天", "每週 1 次", "每週 2 次", "每週 3 次", "不固定"];

export function additiveLabel(value) {
  const normalized = LEGACY_ADDITIVE_VALUES[value] || value;
  return ADDITIVE_TYPES.find((item) => item.value === normalized)?.label || value || "未命名添加物";
}

export function additiveGroup(value) {
  const normalized = LEGACY_ADDITIVE_VALUES[value] || value;
  return ADDITIVE_TYPES.find((item) => item.value === normalized)?.group || "other";
}

export function normalizeAdditiveLog(input) {
  const normalizedItem = LEGACY_ADDITIVE_VALUES[input.item] || input.item;
  const item = ADDITIVE_TYPES.some((type) => type.value === normalizedItem) ? normalizedItem : "red-sea-ab-plus";
  return {
    date: input.date,
    item,
    itemLabel: additiveLabel(item),
    doseMl: Math.max(0, Number(input.doseMl) || 0),
    coralFed: Boolean(input.coralFed),
    autoDosed: Boolean(input.autoDosed),
    frequency: ADDITIVE_FREQUENCIES.includes(input.frequency) ? input.frequency : "單次",
    note: String(input.note || "").trim(),
  };
}
