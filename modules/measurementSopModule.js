export const MEASUREMENT_SOP_ORDER = ["kh", "no3", "po4", "mg", "ca", "k"];

export const MEASUREMENT_SOPS = {
  kh: {
    key: "kh",
    label: "KH",
    unit: "dKH",
    product: "Salifert KH/ALK",
    modes: [
      { value: "standard", label: "標準模式", factor: 1, formula: "不換算" },
      { value: "low-resolution", label: "低準度模式", factor: 2, formula: "原始讀值 × 2" },
    ],
    steps: [
      {
        title: "取缸內水",
        text: { standard: "使用注射管取 4 ml 缸內水至測試瓶。", "low-resolution": "使用注射管取 2 ml 缸內水至測試瓶。" },
      },
      {
        title: "加入 KH-Ind",
        text: { standard: "先搖勻 KH-Ind，再垂直加入 4 滴，搖勻測試瓶。", "low-resolution": "先搖勻 KH-Ind，再垂直加入 2 滴，搖勻測試瓶。" },
        caution: "試劑瓶先搖勻，滴瓶保持垂直。",
      },
      {
        title: "準備滴定試劑",
        text: "將紅色針頭裝在 1 ml 注射管上，確認針頭浸入 KH 試劑，吸取至黑色活塞下緣到達 1 ml。",
        caution: "針筒與針頭間的空氣不影響結果。",
      },
      {
        title: "開始滴定",
        text: "每次滴入 1–2 滴，滴完充分搖勻；接近終點時放慢。",
      },
      {
        title: "確認終點顏色",
        text: "顏色由藍色或綠色轉為橘紅色或粉紅色，才算終點。",
        error: "不要太早停在紫色或灰紫色。",
      },
      {
        title: "讀取原始數值",
        text: "針頭朝上，讀取注射筒黑色活塞上緣，再依對照表取得 KH 數值。",
        caution: "低準度模式的對照表讀值會由 App 自動乘以 2。",
      },
    ],
  },
  no3: {
    key: "no3",
    label: "NO3",
    unit: "ppm",
    product: "Salifert NO3",
    modes: [
      { value: "standard", label: "一般判讀", factor: 1, formula: "不換算" },
      { value: "low-concentration", label: "低濃度模式", factor: 0.1, formula: "原始讀值 ÷ 10" },
    ],
    steps: [
      { title: "取缸內水", text: "使用注射管取 1 ml 缸內水至測試瓶。" },
      { title: "加入 NO3-1", text: "垂直加入 NO3-1 試劑 4 滴。" },
      {
        title: "加入 NO3-2",
        text: "加入 1 平匙 NO3-2 粉，輕輕搖晃 30 秒。",
        waitSeconds: 30,
        error: "不要劇烈搖晃。",
      },
      {
        title: "等待顯色",
        text: "將測試瓶靜置 3 分鐘。",
        waitSeconds: 180,
      },
      {
        title: "一般判讀",
        text: "將測試瓶放在色卡白色區域旁，從側面平視觀察顏色，與色卡比對 NO3 數值。",
        caution: "NO3 請平視比色，不是由上往下看；色卡單位為 ppm（mg/L）。",
      },
      {
        title: "低濃度判讀",
        text: "若讀值小於 10 mg/L，將測試瓶拿至眼前平視；色卡放在瓶後方白色區域。",
        caution: "啟用低濃度模式後，App 會把原始讀值除以 10。",
      },
    ],
  },
  po4: {
    key: "po4",
    label: "PO4",
    unit: "ppm",
    product: "Salifert PO4",
    modes: [
      { value: "standard", label: "標準模式", factor: 1, formula: "不換算" },
      { value: "high-precision", label: "高準度模式", factor: 0.5, formula: "原始讀值 ÷ 2" },
    ],
    steps: [
      {
        title: "取缸內水",
        text: { standard: "使用注射管取 10 ml 缸內水至測試瓶。", "high-precision": "使用兩倍缸內水，共 20 ml 至測試瓶。" },
      },
      {
        title: "加入 PO4-1",
        text: { standard: "加入 PO4-1 試劑 4 滴，搖晃 10 秒。", "high-precision": "加入 PO4-1 試劑 8 滴，搖晃 10 秒。" },
        waitSeconds: 10,
      },
      {
        title: "加入 PO4-2",
        text: { standard: "加入 1 平匙 PO4-2 粉，搖晃 30 秒。", "high-precision": "加入 2 平匙 PO4-2 粉，搖晃 30 秒。" },
        waitSeconds: 30,
      },
      {
        title: "判讀顏色",
        text: "將測試瓶放在色卡白色區域，由上往下看，讀取顏色對應數值。",
        caution: "PO4 在 0.01–0.05 ppm 時人眼判讀誤差較高，請固定白色背景與光線。",
      },
      {
        title: "確認換算",
        text: { standard: "標準模式直接使用色卡讀值。", "high-precision": "高準度模式使用兩倍用量，App 會把色卡原始讀值除以 2。" },
      },
    ],
  },
  mg: {
    key: "mg",
    label: "MG",
    unit: "ppm",
    product: "Salifert Mg",
    modes: [{ value: "standard", label: "標準模式", factor: 1, formula: "不換算" }],
    steps: [
      { title: "取缸內水", text: "使用注射管取 2 ml 缸內水至測試瓶。" },
      { title: "加入 Mg-1", text: "垂直加入 Mg-1 試劑 5 滴。" },
      {
        title: "加入 Mg-2",
        text: "加入 1 平匙 Mg-2 粉，搖晃 10 秒。",
        waitSeconds: 10,
      },
      {
        title: "準備 Mg-3",
        text: "將紅色針頭裝在 1 ml 注射管上，確認針頭浸入 Mg-3，吸取至黑色活塞下緣到達 1 ml。",
        caution: "針筒與針頭間的空氣不影響結果。",
      },
      {
        title: "滴定至終點",
        text: "每次滴入 1 滴 Mg-3 並搖勻，直到顏色轉為灰色或藍色。",
        error: "接近終點時不要連續快速滴入。",
      },
      {
        title: "讀取原始數值",
        text: "針頭朝上，讀取注射筒黑色活塞上緣，再依對照表取得 MG 數值。",
        caution: "MG 變化慢，不要因單次結果大幅調整。",
      },
    ],
  },
  ca: {
    key: "ca",
    label: "CA",
    unit: "ppm",
    product: "Salifert Ca",
    modes: [
      { value: "standard", label: "標準模式", factor: 1, formula: "不換算" },
      { value: "low-resolution", label: "低準度模式", factor: 2, formula: "原始讀值 × 2" },
    ],
    steps: [
      {
        title: "取缸內水",
        text: { standard: "使用注射管取 2 ml 缸內水至測試瓶。", "low-resolution": "使用注射管取 1 ml 缸內水至測試瓶。" },
      },
      {
        title: "加入 Ca-1",
        text: { standard: "加入 1 平匙 Ca-1 粉，先不要搖勻。", "low-resolution": "加入半匙 Ca-1 粉，先不要搖勻。" },
        error: "這一步先不要搖晃。",
      },
      {
        title: "準備 Ca-2",
        text: "將紅色針頭裝在 1 ml 注射管上，確認針頭浸入 Ca-2，吸取至黑色活塞下緣到達 1 ml。",
        caution: "針筒與針頭間的空氣不影響結果。",
      },
      {
        title: "先加入固定量",
        text: { standard: "先滴入 0.6 ml Ca-2，搖勻 5 秒，顏色會呈淡粉紅。", "low-resolution": "先滴入 0.3 ml Ca-2，搖勻 5 秒，顏色會呈淡粉紅。" },
        waitSeconds: 5,
      },
      {
        title: "慢慢滴定",
        text: "繼續每次滴入 1–2 滴 Ca-2，滴完搖勻，直到顏色由粉紅轉為藍色。",
      },
      {
        title: "讀取原始數值",
        text: "針頭朝上，讀取注射筒黑色活塞上緣，再依對照表取得 CA 數值。",
        caution: "低準度模式的對照表讀值會由 App 自動乘以 2。",
      },
    ],
  },
  k: {
    key: "k",
    label: "鉀(K)",
    unit: "ppm",
    product: "K 測試劑",
    modes: [{ value: "standard", label: "標準模式", factor: 1, formula: "依對照表輸入 ppm" }],
    steps: [
      { title: "清潔器具", text: "使用前先將各器具清洗並擦乾。" },
      { title: "取缸內水", text: "使用沒有貼紙的針筒，吸取缸內水 1 ml 注入試管。" },
      {
        title: "加入 K-1",
        text: "使用有紅貼紙的針筒，抽取 K-1 試劑 0.5 ml 注入試管，輕輕晃動 20 秒。",
        waitSeconds: 20,
      },
      {
        title: "加入 K-2",
        text: "垂直加入 K-2 試劑完整 3 滴，不需要搖晃。",
        error: "滴瓶要保持垂直，確認完整加入 3 滴。",
      },
      {
        title: "滴入 K-3",
        text: "垂直滴入 K-3；每滴 1 滴後搖晃 2 秒，並計算滴數。",
        waitSeconds: 2,
      },
      {
        title: "確認終點",
        text: "持續滴定，直到溶液由白色或淡黃色轉為淡藍色。",
        caution: "固定使用白光環境與白色背景，降低主觀色差。",
      },
      {
        title: "查表取得 ppm",
        text: "依盒內說明書右上角表格，以 K-3 滴數查出鉀值 ppm，再輸入結果。",
        caution: "目前 App 沒有完整滴數對照表，因此不會自行推算 ppm。",
      },
    ],
  },
};

export function getMeasurementSop(parameter) {
  return MEASUREMENT_SOPS[parameter] || null;
}

export function getSopMode(parameter, modeValue) {
  const sop = getMeasurementSop(parameter);
  if (!sop) return null;
  return sop.modes.find((mode) => mode.value === modeValue) || sop.modes[0];
}

export function stepText(step, modeValue) {
  if (typeof step.text === "string") return step.text;
  return step.text[modeValue] || step.text.standard || Object.values(step.text)[0] || "";
}

export function convertMeasurementReading({ parameter, rawValue, mode }) {
  if (String(rawValue ?? "").trim() === "") {
    return { error: "請輸入有效的非負數值。" };
  }
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return { error: "請輸入有效的非負數值。" };
  }
  const selectedMode = getSopMode(parameter, mode);
  if (!selectedMode) return { error: "找不到測量模式。" };
  const finalValue = Number((numericValue * selectedMode.factor).toFixed(4));
  return {
    parameter,
    rawValue: numericValue,
    mode: selectedMode.value,
    modeLabel: selectedMode.label,
    formula: selectedMode.formula,
    finalValue,
  };
}

export function buildMeasurementSopSummary(results = {}) {
  const measured = MEASUREMENT_SOP_ORDER.filter((key) => results[key]?.status === "measured");
  const skipped = MEASUREMENT_SOP_ORDER.filter((key) => results[key]?.status === "skipped");
  const pending = MEASUREMENT_SOP_ORDER.filter((key) => !results[key]);
  const recommendationEligible = measured.filter((key) => ["kh", "ca", "mg"].includes(key));

  return {
    measured,
    skipped,
    pending,
    recommendationEligible,
  };
}
