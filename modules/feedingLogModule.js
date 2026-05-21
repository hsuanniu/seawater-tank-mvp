export const FOOD_TYPES = [
  { value: "shrimp", label: "蝦子" },
  { value: "frozen-food", label: "冷凍飼料" },
  { value: "fish-pellet", label: "魚飼料" },
  { value: "coral-food", label: "珊瑚糧" },
];

export const FEEDING_AMOUNT_LEVELS = ["少", "中", "多"];
export const FEEDING_FREQUENCIES = ["單次", "每天 1 次", "每天 2 次", "每天 3 次以上", "每週數次", "不固定"];

export function foodLabel(value) {
  return FOOD_TYPES.find((item) => item.value === value)?.label || value || "未填種類";
}

export function normalizeFeedingLog(input) {
  const foodTypes = Array.isArray(input.foodTypes)
    ? input.foodTypes.filter((item) => FOOD_TYPES.some((type) => type.value === item))
    : [];
  return {
    date: input.date,
    amountLevel: FEEDING_AMOUNT_LEVELS.includes(input.amountLevel) ? input.amountLevel : "中",
    frequency: FEEDING_FREQUENCIES.includes(input.frequency) ? input.frequency : "單次",
    foodTypes,
    note: String(input.note || "").trim(),
  };
}

export function isHigherFeeding(feeding) {
  return feeding.amountLevel === "多" || feeding.frequency === "每天 3 次以上" || Number(feeding.timesPerDay) >= 3;
}

export function isLowFeeding(feeding) {
  return feeding.amountLevel === "少" || feeding.frequency === "單次" || Number(feeding.timesPerDay) <= 1;
}
