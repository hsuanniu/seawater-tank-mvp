import { nutrientFocusText, nutrientNotes } from "./components/aiExplanationModule.js";
import { actionText, changeText, confidenceText, dailyDeltaText, doseSuggestionText, formatDoseSentence, primaryFocus } from "./components/dashboardModule.js?v=20260520-safety-ux";
import { analyzeTank } from "./engines/analysisEngine.js?v=20260520-safety-ux";
import { additiveLabel, normalizeAdditiveLog } from "./modules/additiveLogModule.js?v=20260520-additive-feeding-log2";
import { analyzeBioLoadReferences, WEEKDAYS } from "./modules/bioLoadModule.js?v=20260520-additive-feeding-log2";
import { APPLICABLE_DOSE_KEYS, createDoseApplicationEntry, getDoseStatus as readDoseStatus } from "./modules/dosingModule.js?v=20260521-stability-tests";
import { buildTimelineEvents, filterTimelineEvents, TIMELINE_EVENT_TYPES } from "./modules/eventTimelineModule.js?v=20260521-event-timeline";
import { foodLabel, normalizeFeedingLog } from "./modules/feedingLogModule.js?v=20260520-additive-feeding-log2";
import { buildMeasurementRecord, getSortedRecords as sortMeasurements } from "./modules/measurementModule.js?v=20260521-stability-tests";
import { DEFAULT_TANK, PARAMETERS, parseTargetExpression } from "./modules/tankModule.js";
import { escapeHtml, formatNumber, targetToText, toNumber } from "./services/formatService.js";
import { restoreBackupText } from "./services/backupService.js";
import { createTankStore } from "./services/tankStore.js";

const STORAGE_KEY = "seawaterTankMvp.v4";
const CLOUD_CONFIG_KEY = "seawaterTankCloudConfig.v1";
const CLOUD_TABLE = "user_app_state";
const DEBUG_MODE = false;
let supabaseClient = null;
let cloudSession = null;
let cloudSaveTimer = null;
let suppressCloudSave = false;
let dosingAutoSaveTimer = null;
let feedbackTimer = null;

const TankStore = createTankStore({
  storageKey: STORAGE_KEY,
  onPersist: () => scheduleCloudSave(),
  onPersistError: () => showToast("本機儲存失敗，請先備份資料並確認瀏覽器儲存空間。"),
  onChange: ({ forms = false, cloud = false, partial = false, statusPrefix = "" } = {}) => {
    if (partial) {
      if (forms) renderForms();
      renderDosingSavedMeta(statusPrefix);
      renderDashboard();
      renderAnalysis();
      renderHistory();
      renderChart();
      return;
    }
    renderAll({ forms, cloud });
  },
  onDosingDebug: debugDosingSync,
});

function activeTank() {
  return TankStore.getActiveTank();
}

function tankSettings() {
  return TankStore.getTank();
}

function dosingSettings() {
  return TankStore.getDosing();
}

function measurements() {
  return TankStore.getMeasurements();
}

function livestock() {
  return TankStore.getLivestock();
}

function feedings() {
  return TankStore.getFeedings();
}

function additives() {
  return TankStore.getAdditives();
}

function additiveSchedules() {
  return TankStore.getAdditiveSchedules();
}

function debugDosingSync({ source, input, previous, updated }) {
  const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  const persistedTank = (persisted.tanks || []).find((tank) => tank.id === TankStore.getState().activeTankId);
  console.group(`[Dosing Sync] ${source}`);
  console.log("input value", {
    kh: input.kh,
    ca: input.ca,
    mg: input.mg,
    aplus: input.aplus,
    kplus: input.kplus,
    customDose: input.customDose,
  });
  console.log("previous state", previous);
  console.log("updated state", updated);
  console.log("persisted data", persistedTank ? persistedTank.dosing : null);
  console.log("dashboard displayed value", {
    kh: formatNumber(updated.kh),
    ca: formatNumber(updated.ca),
    mg: formatNumber(updated.mg),
    adviceText: document.querySelector("#dashboardAdvice")?.textContent.trim() || "",
  });
  console.groupEnd();
}

function getSortedRecords() {
  return sortMeasurements(measurements());
}

function getDoseStatus(key) {
  return readDoseStatus(dosingSettings(), key);
}

function doseStatusText(key) {
  const status = getDoseStatus(key);
  if (!status.enabled) return "目前關閉";
  if (status.pausedDays > 0) return `本週暫停 ${status.pausedDays} 天`;
  return "目前啟用";
}

function reasonText(reasonCode) {
  const labels = {
    ZERO_CURRENT_DOSE: "尚未建立基礎滴定資料",
    NO_PREVIOUS_RECORD: "尚無足夠歷史資料",
    TEST_INTERVAL_TOO_SHORT: "測量間隔太短",
    TREND_TOO_FAST_VERIFY_FIRST: "變化偏快，需先確認",
    VALUE_CARRIED_FORWARD: "本次未實測，沿用上一筆",
    OUTSIDE_SAFE_CALCULATION_RANGE: "超出安全計算範圍",
    DOSER_DISABLED: "滴定目前關閉",
    DOSING_PAUSED_THIS_WEEK: "本週曾暫停滴定",
    WITHIN_TARGET: "位於目標範圍",
    HIGH_REDUCE_ONLY: "高於目標，只允許保守降低",
    LOW_SMALL_INCREASE: "低於目標，只允許小幅增加",
    NORMAL_NEAR_LOW_TREND_DOWN: "接近下緣且下降",
    NORMAL_NEAR_HIGH_TREND_UP: "接近上緣且上升",
    NO_AUTO_DOSING_FOR_PARAMETER: "此項目不提供自動滴定建議",
  };
  return labels[reasonCode] || "保守規則判斷";
}

function recommendationProblem(row) {
  if (row.reasonCode === "ZERO_CURRENT_DOSE") return `尚未建立 ${row.label} 滴定基準`;
  if (row.reasonCode === "NO_PREVIOUS_RECORD") return "資料不足，尚無法判斷消耗趨勢";
  if (row.reasonCode === "TEST_INTERVAL_TOO_SHORT") return "測量間隔太短，暫不判斷趨勢";
  if (row.reasonCode === "VALUE_CARRIED_FORWARD") return `${row.label} 本次未實測`;
  if (row.reasonCode === "OUTSIDE_SAFE_CALCULATION_RANGE") return `${row.label} 超出安全計算範圍`;
  if (row.reasonCode === "TREND_TOO_FAST_VERIFY_FIRST") return `${row.label} 變化速度偏快`;
  if (row.status.text !== "正常") return `${row.label} ${row.status.text}`;
  return `${row.label} 目前穩定`;
}

function recommendationAction(row) {
  if (row.reasonCode === "ZERO_CURRENT_DOSE") return "請先輸入目前固定滴定量，建立基準後再讓系統計算微調。";
  if (!row.canApplyRecommendation) return "目前資料不足，建議持續觀察與建立基準資料。";
  if (row.doseChange > 0) return `可小幅增加至 ${formatNumber(row.newDose)} ml/day，並於下次測量後再確認。`;
  if (row.doseChange < 0) return `可小幅降低至 ${formatNumber(row.newDose)} ml/day，並於下次測量後再確認。`;
  return "建議維持目前滴定量，下一次測量後再依趨勢微調。";
}

function recommendationDebugHtml(row) {
  if (!DEBUG_MODE) return "";
  return `<p class="muted-line">Debug：${row.reasonCode}｜${row.confidenceLevel}｜${dailyDeltaText(row)}</p>`;
}

function analyze() {
  return analyzeTank({
    tank: tankSettings(),
    records: measurements(),
    dosing: dosingSettings(),
  });
}

function analyzeBioLoad() {
  return analyzeBioLoadReferences({
    records: measurements(),
    livestock: livestock(),
    feedings: feedings(),
    additives: additives(),
    targets: tankSettings().targets,
  });
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value || null));
}

function recordsWithPendingMeasurement(record) {
  return [
    ...measurements().filter((item) => item.date !== record.date),
    { id: "pending", createdAt: new Date().toISOString(), ...record },
  ];
}

function logsInSnapshotWindow(items, dateValue, days = 7) {
  const anchor = new Date(dateValue);
  return items.filter((item) => {
    if (!item.date) return false;
    const diff = (anchor - new Date(item.date)) / 86400000;
    return diff >= 0 && diff <= days;
  });
}

function latestMaintenanceBefore(dateValue) {
  const anchor = new Date(dateValue);
  return [...TankStore.getMaintenance()]
    .filter((item) => !item.date || new Date(item.date) <= anchor)
    .slice(-1)[0] || null;
}

function compactRecommendationsForSnapshot(snapshotAnalysis) {
  if (!snapshotAnalysis) return [];
  return snapshotAnalysis.rows
    .filter((row) => ["kh", "ca", "mg"].includes(row.key))
    .map((row) => ({
      key: row.key,
      label: row.label,
      currentDoseMlPerDay: row.currentDose,
      suggestedDoseMlPerDay: row.newDose,
      doseChangeMlPerDay: row.doseChange,
      action: row.recommendationMode,
      actionText: actionText(row.recommendationMode),
      reason: reasonText(row.reasonCode),
      reasonText: row.recommendationReason,
      confidence: confidenceText(row.confidenceLevel),
      canApply: row.canApplyRecommendation,
    }));
}

function buildMeasurementSnapshot(record) {
  const snapshotAnalysis = analyzeTank({
    tank: tankSettings(),
    records: recordsWithPendingMeasurement(record),
    dosing: dosingSettings(),
  });
  return {
    createdAt: new Date().toISOString(),
    dosing: cloneData(dosingSettings()),
    recommendations: compactRecommendationsForSnapshot(snapshotAnalysis),
    maintenance: cloneData(latestMaintenanceBefore(record.date)),
    feedings: cloneData(logsInSnapshotWindow(feedings(), record.date)),
    additives: cloneData(logsInSnapshotWindow(additives(), record.date)),
    appliedRecommendations: [],
  };
}

function todayText() {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const date = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${date}`;
}

function buildMeasurementFromForm(data) {
  return buildMeasurementRecord(data, getSortedRecords(), {
    fallbackDate: todayText(),
    labels: Object.fromEntries(PARAMETERS.map((param) => [param.key, param.label])),
  });
}

function renderTargetInputs() {
  const container = document.querySelector("#targetInputs");
  const tank = tankSettings();
  container.innerHTML = PARAMETERS
    .map((param) => {
      const target = tank.targets[param.key];
      const inputValue = tank.targetInputs[param.key] || targetToText(target);
      return `
        <label class="target-card">${param.label} 目標
          <input
            name="${param.key}Target"
            class="target-expression"
            type="text"
            inputmode="decimal"
            value="${inputValue}"
            data-param="${param.key}"
            aria-label="${param.label} 目標"
            placeholder="例如 ${param.key === "ca" ? "400+/-20" : targetToText(target)}"
          />
          <div class="target-help">
            <span data-target-preview="${param.key}">解析：${targetToText(target)} ${param.unit}</span>
          </div>
        </label>
      `;
    })
    .join("");
  setupTargetPreviewEvents();
}

function setupTargetPreviewEvents() {
  document.querySelectorAll(".target-expression").forEach((input) => {
    const updatePreview = () => {
      const param = PARAMETERS.find((item) => item.key === input.dataset.param);
      const preview = document.querySelector(`[data-target-preview="${param.key}"]`);
      const parsed = parseTargetExpression(input.value, param);
      const wrapper = preview.closest(".target-help");
      if (!parsed) {
        preview.textContent = "格式無法解析";
        wrapper.classList.add("invalid");
        return;
      }
      preview.textContent = `解析：${targetToText(parsed)} ${param.unit}`;
      wrapper.classList.remove("invalid");
    };
    input.addEventListener("input", updatePreview);
    updatePreview();
  });
}

function readDosingForm() {
  const form = document.querySelector("#dosingForm");
  const data = formData(form);
  return {
    kh: toNumber(data.kh),
    ca: toNumber(data.ca),
    mg: toNumber(data.mg),
    aplus: toNumber(data.aplus),
    kplus: toNumber(data.kplus),
    customName: data.customName.trim(),
    customDose: toNumber(data.customDose),
    status: {
      kh: { enabled: form.khEnabled.checked, pausedDays: toNumber(data.khPausedDays) },
      ca: { enabled: form.caEnabled.checked, pausedDays: toNumber(data.caPausedDays) },
      mg: { enabled: form.mgEnabled.checked, pausedDays: toNumber(data.mgPausedDays) },
      aplus: { enabled: form.aplusEnabled.checked, pausedDays: toNumber(data.aplusPausedDays) },
      kplus: { enabled: form.kplusEnabled.checked, pausedDays: toNumber(data.kplusPausedDays) },
      custom: { enabled: form.customEnabled.checked, pausedDays: toNumber(data.customPausedDays) },
    },
  };
}

function saveDosingFromForm({ silent = false, rerenderForms = false } = {}) {
  const nextDosing = readDosingForm();
  TankStore.updateDosing(nextDosing, {
    source: "dosingForm",
    debug: true,
    forms: rerenderForms,
    statusPrefix: silent ? "已自動儲存" : "已儲存",
  });
  if (!silent) showToast("滴定設定已儲存");
}

function scheduleDosingAutoSave() {
  window.clearTimeout(dosingAutoSaveTimer);
  renderDosingSavedMeta("輸入中，準備自動儲存");
  dosingAutoSaveTimer = window.setTimeout(() => saveDosingFromForm({ silent: true }), 650);
}

function dosingSavedText() {
  const dosing = dosingSettings();
  if (!dosing.lastSavedAt) return "尚未儲存滴定設定";
  return `最後儲存 ${new Date(dosing.lastSavedAt).toLocaleString("zh-Hant")}`;
}

function renderDosingSavedMeta(prefix = "") {
  const status = document.querySelector("#dosingSaveStatus");
  if (!status) return;
  const label = prefix ? `${prefix} · ` : "";
  status.textContent = `${label}${tankSettings().name} · ${dosingSavedText()}`;
}

function hasPrimaryDosingBaseline() {
  const dosing = dosingSettings();
  return ["kh", "ca", "mg"].some((key) => toNumber(dosing[key]) > 0);
}

function dosingReadoutHtml() {
  const dosing = dosingSettings();
  const items = [
    { key: "kh", label: "KH" },
    { key: "ca", label: "CA" },
    { key: "mg", label: "MG" },
  ];
  const readout = items
    .map(
      (item) => `
        <div>
          <span>${item.label}</span>
          <strong>${formatNumber(dosing[item.key])} ml/day</strong>
        </div>
      `,
    )
    .join("");

  if (!hasPrimaryDosingBaseline()) {
    return `
      <div class="analysis-warning">
        <div>
          <strong>尚未建立主要滴定量基準</strong>
          <p>系統目前讀到 KH / CA / MG 都是 0 ml/day，所以不會自動建立新的滴定量。請先到滴定設定輸入目前每日滴定量。</p>
        </div>
        <button class="secondary-button" type="button" data-goto="dosing">前往滴定設定</button>
      </div>
    `;
  }

  return `
    <div class="dosing-readout">
      <div>
        <strong>目前分析讀取的滴定設定</strong>
        <span>${dosingSavedText()}</span>
      </div>
      <div class="readout-grid">${readout}</div>
    </div>
  `;
}

function renderForms() {
  const tank = tankSettings();
  const dosing = dosingSettings();
  const tankForm = document.querySelector("#tankForm");
  tankForm.name.value = tank.name;
  tankForm.volume.value = tank.volume;
  renderTargetInputs();

  const dosingForm = document.querySelector("#dosingForm");
  Object.entries(dosing).forEach(([key, value]) => {
    if (key !== "status" && dosingForm.elements[key]) dosingForm.elements[key].value = value;
  });
  ["kh", "ca", "mg", "aplus", "kplus", "custom"].forEach((key) => {
    const status = getDoseStatus(key);
    const enabledInput = dosingForm.elements[`${key}Enabled`];
    const pausedInput = dosingForm.elements[`${key}PausedDays`];
    if (enabledInput) enabledInput.checked = status.enabled;
    if (pausedInput) pausedInput.value = status.pausedDays;
  });
  renderDosingSavedMeta();

  document.querySelector("#waterForm").date.value = todayText();
  document.querySelector("#fishForm").addedAt.value = document.querySelector("#fishForm").addedAt.value || todayText();
  document.querySelector("#feedingForm").date.value = document.querySelector("#feedingForm").date.value || todayText();
  document.querySelector("#additiveForm").date.value = document.querySelector("#additiveForm").date.value || todayText();
}

function renderTankSwitcher() {
  const select = document.querySelector("#tankSelect");
  const storeState = TankStore.getState();
  select.innerHTML = storeState.tanks
    .map((tank) => `<option value="${escapeHtml(tank.id)}" ${tank.id === storeState.activeTankId ? "selected" : ""}>${escapeHtml(tank.tank.name)}</option>`)
    .join("");
}

function dashboardTone(row) {
  if (!row) return "neutral";
  if (row.status.className === "status-critical" || row.trendTooFast) return "danger";
  if (row.status.text === "偏高" || row.status.text === "偏低" || row.recommendationMode === "OBSERVE") return "attention";
  return "stable";
}

function focusIcon(tone) {
  if (tone === "danger") return "!";
  if (tone === "attention") return "~";
  return "✓";
}

function metricCardClass(row, focus) {
  const classes = ["metric-card"];
  if (row.key === focus.key) classes.push("is-focus");
  if (row.status.text === "正常") classes.push("is-stable");
  if (row.status.text !== "正常") classes.push("needs-attention");
  if (row.trendTooFast) classes.push("needs-attention");
  return classes.join(" ");
}

function renderDashboard() {
  const analysis = analyze();
  const tank = tankSettings();
  document.querySelector("#tankNameDisplay").textContent = tank.name;
  document.querySelector("#dashboardMeta").textContent = analysis
    ? `${tank.volume} L | 最新紀錄 ${analysis.latest.date}${analysis.daysSincePrevious !== null ? ` | 距上次 ${analysis.daysSincePrevious} 天` : ""}`
    : `${tank.volume} L | 尚未建立紀錄`;

  const cards = document.querySelector("#latestCards");
  const focusPanel = document.querySelector("#focusPanel");
  if (!analysis) {
    focusPanel.innerHTML = `
      <article class="focus-card empty">
        <div>
          <p class="eyebrow">下一步</p>
          <h3>先新增第一筆水質紀錄</h3>
          <p>填入本週測量值後，首頁會顯示狀態、趨勢與滴定建議。</p>
        </div>
        <button class="primary-button" data-goto="water">開始記錄</button>
      </article>
    `;
    cards.innerHTML = `<div class="notice">尚未有水質紀錄。先新增一筆紀錄後，系統會產生狀態與滴定建議。</div>`;
  } else {
    const focus = primaryFocus(analysis);
    const tone = dashboardTone(focus);
    focusPanel.innerHTML = `
      <article class="focus-card tone-${tone}">
        <div>
          <p class="eyebrow">本週焦點</p>
          <h3>${focus.label}：${focus.status.text}${focus.trendText !== "無上次資料" ? `，較上次${focus.trendText}` : ""}</h3>
          <p>${focus.doseKey ? formatDoseSentence(focus, doseStatusText) : nutrientFocusText(focus)}</p>
        </div>
        <div class="focus-icon" aria-hidden="true">${focusIcon(tone)}</div>
      </article>
    `;
    cards.innerHTML = analysis.rows
      .map(
        (row) => `
          <article class="${metricCardClass(row, focus)}">
            <div class="label">${row.label}</div>
            <div class="value">${formatNumber(row.value, row.key === "po4" ? 3 : 2)}</div>
            <div class="metric-meta">目標 ${targetToText(row.target)} ${row.unit}</div>
            ${row.isMeasured ? "" : `<div class="metric-meta carry-note">沿用上次</div>`}
            <div class="status ${row.status.className}">${row.status.text} / ${row.trendText}</div>
          </article>
        `,
      )
      .join("");
  }

  document.querySelector("#dashboardAdvice").innerHTML = analysis
    ? renderDosingAdvice(analysis)
    : `<div class="notice">等待第一筆水質紀錄。</div>`;
  renderMaintenanceSummary();
}

function recommendationCard(row) {
  const warnings = row.safetyWarnings && row.safetyWarnings.length
    ? row.safetyWarnings.map((warning) => `<li>${warning}</li>`).join("")
    : "<li>無額外安全提醒。</li>";
  const canApply = row.canApplyRecommendation && APPLICABLE_DOSE_KEYS.includes(row.key);
  const needsBaseline = row.reasonCode === "ZERO_CURRENT_DOSE";
  const doseCompare = needsBaseline
    ? `<div class="baseline-empty">
        <strong>請先建立滴定基準</strong>
        <span>請先輸入目前固定滴定量，系統才會開始計算微調建議。</span>
      </div>`
    : `<div class="dose-compare">
        <div><span>目前</span><strong>${formatNumber(row.currentDose)} ml/day</strong></div>
        <div><span>建議</span><strong>${formatNumber(row.newDose)} ml/day</strong></div>
        <div><span>增減</span><strong>${formatNumber(row.doseChange || 0)} ml/day</strong></div>
      </div>`;
  return `
    <article class="recommendation-card ${canApply ? "can-apply" : "observe-only"}">
      <div class="recommendation-head">
        <div>
          <p class="eyebrow">${row.label} 滴定建議</p>
          <h4>${actionText(row.recommendationMode)}</h4>
        </div>
        <div class="recommendation-state">
          <span class="badge ${canApply ? "" : "muted"}">${canApply ? "可套用" : "暫不套用"}</span>
          <span class="state-note">${confidenceText(row.confidenceLevel)}</span>
        </div>
      </div>
      ${doseCompare}
      <p><strong>問題：</strong>${recommendationProblem(row)}</p>
      <p><strong>原因：</strong>${reasonText(row.reasonCode)}。${row.recommendationReason}</p>
      <p><strong>建議動作：</strong>${recommendationAction(row)}</p>
      <p class="muted-line">${dailyDeltaText(row)}</p>
      <strong>安全提醒</strong>
      <ul class="warning-list">${warnings}</ul>
      ${recommendationDebugHtml(row)}
      ${needsBaseline ? "" : `<button class="primary-button" data-apply-dose="${row.key}" ${canApply ? "" : "disabled"} title="${canApply ? "套用這次保守建議" : "目前資料不足，暫不套用"}">${canApply ? "套用建議" : "暫不套用"}</button>`}
    </article>
  `;
}

function recentApplicationsHtml() {
  const applications = [...(TankStore.getDoseApplications() || [])].slice(-5).reverse();
  if (!applications.length) return `<div class="notice">尚未套用過滴定建議。</div>`;
  return applications
    .map(
      (item) => `
        <div class="summary-item">
          ${item.appliedAt}｜${item.label}：${formatNumber(item.oldDoseMlPerDay)} → ${formatNumber(item.newDoseMlPerDay)} ml/day（${reasonText(item.reasonCode)}）
        </div>
      `,
    )
    .join("");
}

function bioLoadReferenceHtml() {
  const reference = analyzeBioLoad();
  const possibleImpacts = reference.possibleImpacts || [];
  const factors = reference.factors.length
    ? reference.factors.map((factor) => `<div class="summary-item">${factor.text}</div>`).join("")
    : `<div class="summary-item">近 ${reference.referenceDays} 天尚未記錄明顯餵食、魚隻或添加物變動。</div>`;
  return `
    <div class="summary-list">
      ${reference.summary.map((item) => `<div class="summary-item">${item}</div>`).join("")}
      ${possibleImpacts.map((item) => `<div class="summary-item"><strong>可能影響因素</strong><span>${item}</span></div>`).join("")}
      ${factors}
      <div class="notice compact">${reference.disclaimer}</div>
    </div>
  `;
}

function renderDosingAdvice(analysis) {
  const kh = analysis.rows.find((row) => row.key === "kh");
  const ca = analysis.rows.find((row) => row.key === "ca");
  const mg = analysis.rows.find((row) => row.key === "mg");
  const lines = [kh, ca, mg].map((row) => {
    if (row.reasonCode === "ZERO_CURRENT_DOSE") {
      return `
        <div class="advice-item">
          <strong>尚未建立 ${row.label} 滴定基準</strong>
          <span>請先輸入目前固定滴定量，系統才會開始計算微調建議。</span>
        </div>
      `;
    }
    return `
      <div class="advice-item">
        <strong>${row.label}：${doseSuggestionText(row, doseStatusText)}</strong>
        <span>${dailyDeltaText(row)}。${row.recommendationReason}</span>
      </div>
    `;
  });
  return lines.join("");
}

function daysSince(dateValue) {
  if (!dateValue) return null;
  return Math.max(0, Math.round((new Date(todayText()) - new Date(dateValue)) / 86400000));
}

function stableWeeks(records, key, target) {
  let count = 0;
  for (const record of [...records].reverse()) {
    const value = toNumber(record[key]);
    if (Number.isFinite(value) && value >= target.min && value <= target.max) count += 1;
    else break;
  }
  return count;
}

function trendStreak(records, key, direction) {
  if (records.length < 2) return 0;
  let count = 0;
  for (let index = records.length - 1; index > 0; index -= 1) {
    const current = toNumber(records[index][key]);
    const previous = toNumber(records[index - 1][key]);
    if (!Number.isFinite(current) || !Number.isFinite(previous)) break;
    if (direction === "down" && current < previous) count += 1;
    else if (direction === "up" && current > previous) count += 1;
    else break;
  }
  return count;
}

function smartSummaryItems() {
  const records = getSortedRecords();
  const analysis = analyze();
  if (!records.length || !analysis) {
    return [
      { tone: "attention", text: "尚未建立測量節奏，先新增第一筆水質紀錄。" },
      { tone: "stable", text: "建立連續紀錄後，系統會開始整理穩定度與趨勢。" },
    ];
  }

  const tank = tankSettings();
  const latest = records[records.length - 1];
  const items = [];
  const staleDays = daysSince(latest.date);
  if (staleDays !== null && staleDays >= 7) items.push({ tone: "attention", text: `已 ${staleDays} 天未新增測量，建議更新本週數值。` });

  const khDown = trendStreak(records, "kh", "down");
  if (khDown >= 2) items.push({ tone: "attention", text: `KH 已連續下降 ${khDown} 次，建議留意消耗與滴定基準。` });

  const mgStable = stableWeeks(records, "mg", tank.targets.mg);
  if (mgStable >= 3) items.push({ tone: "stable", text: `MG 已穩定 ${mgStable} 筆紀錄。` });

  const khStable = stableWeeks(records, "kh", tank.targets.kh);
  if (khStable >= 3) items.push({ tone: "stable", text: `KH 已穩定 ${khStable} 筆紀錄。` });

  const po4Row = analysis.rows.find((row) => row.key === "po4");
  if (po4Row && po4Row.status.text === "正常" && po4Row.trendText === "持平") {
    items.push({ tone: "stable", text: "PO4 維持穩定，營養鹽狀態良好。" });
  }

  const abnormal = analysis.rows.filter((row) => row.status.text !== "正常");
  if (!abnormal.length) items.push({ tone: "stable", text: "本週整體穩定度良好，維持目前節奏。魚缸正在往穩定方向走。" });
  if (!items.length) items.push({ tone: "neutral", text: "目前沒有明顯警訊，建議照原節奏觀察下一筆測量。" });
  return items.slice(0, 4);
}

function renderMaintenanceSummary() {
  const container = document.querySelector("#maintenanceSummary");
  container.innerHTML = smartSummaryItems()
    .map((item) => `<div class="summary-item smart-${item.tone}">${item.text}</div>`)
    .join("");
}

function renderBioLoad() {
  const summary = document.querySelector("#bioLoadSummary");
  const fishList = document.querySelector("#fishList");
  const logList = document.querySelector("#bioLogList");
  const scheduleList = document.querySelector("#additiveScheduleList");
  if (!summary || !fishList || !logList || !scheduleList) return;

  const reference = analyzeBioLoad();
  const possibleImpacts = reference.possibleImpacts || [];
  summary.innerHTML = `
    ${reference.summary.map((item) => `<div class="summary-item">${item}</div>`).join("")}
    ${possibleImpacts.map((item) => `<div class="summary-item"><strong>可能影響因素</strong><span>${item}</span></div>`).join("")}
    ${
      reference.factors.length
        ? reference.factors.map((factor) => `<div class="summary-item">${factor.text}</div>`).join("")
        : `<div class="summary-item">近 ${reference.referenceDays} 天尚未記錄明顯餵食、魚隻或添加物變動。</div>`
    }
    <div class="notice compact">${reference.disclaimer}</div>
  `;

  fishList.innerHTML = livestock().length
    ? livestock()
        .map(
          (fish) => `
            <div class="summary-item">
              <strong>${escapeHtml(fish.name)} x${formatNumber(fish.quantity, 0)}</strong>
              <span>新增：${fish.addedAt || "-"}${fish.removed ? `｜已移除 ${fish.removedAt || ""}` : ""}</span>
              <div class="button-row compact-actions">
                ${fish.removed ? "" : `<button class="ghost-button mini-button" type="button" data-remove-fish="${escapeHtml(fish.id)}">標記移除</button>`}
                <button class="danger-button mini-button" type="button" data-delete-fish="${escapeHtml(fish.id)}">刪除</button>
              </div>
            </div>
          `,
        )
        .join("")
    : `<div class="notice">尚未建立魚隻資料。</div>`;

  const recentFeedings = [...feedings()]
    .reverse()
    .map((item) => `
      <div class="summary-item">
        <strong>餵食｜${item.date}</strong>
        <span>${item.amountLevel}｜${item.frequency || item.timesPerDay || "未填頻率"}｜${(item.foodTypes || []).map(foodLabel).join("、") || "未填種類"}${item.note ? `｜${escapeHtml(item.note)}` : ""}</span>
        <div class="button-row compact-actions">
          <button class="danger-button mini-button" type="button" data-delete-feeding="${escapeHtml(item.id)}">刪除</button>
        </div>
      </div>
    `);
  const recentAdditives = [...additives()]
    .reverse()
    .map((item) => `
      <div class="summary-item">
        <strong>添加｜${item.date}</strong>
        <span>${escapeHtml(item.itemLabel || additiveLabel(item.item))}｜${formatNumber(item.doseMl || 0, 2)} ml｜${item.frequency || "單次"}${item.coralFed ? "｜餵珊瑚" : ""}${item.autoDosed ? "｜自動滴定" : ""}${item.note ? `｜${escapeHtml(item.note)}` : ""}</span>
        <div class="button-row compact-actions">
          <button class="danger-button mini-button" type="button" data-delete-additive="${escapeHtml(item.id)}">刪除</button>
        </div>
      </div>
    `);
  logList.innerHTML = recentFeedings.length || recentAdditives.length
    ? [...recentFeedings, ...recentAdditives].join("")
    : `<div class="notice">尚未有餵食或添加物紀錄。</div>`;

  scheduleList.innerHTML = additiveSchedules().length
    ? [...additiveSchedules()]
        .sort((a, b) => Number(a.weekday) - Number(b.weekday))
        .map((schedule) => {
          const weekday = WEEKDAYS.find((day) => day.value === String(schedule.weekday))?.label || "未設定星期";
          return `
            <div class="summary-item">
              <strong>${weekday}｜${escapeHtml(schedule.itemLabel || additiveLabel(schedule.item))}｜${formatNumber(schedule.doseMl || 0, 2)} ml</strong>
              <span>${schedule.enabled === false ? "已停用" : "啟用"}${schedule.note ? `｜${escapeHtml(schedule.note)}` : ""}</span>
              <div class="button-row compact-actions">
                <button class="ghost-button mini-button" type="button" data-toggle-additive-schedule="${escapeHtml(schedule.id)}">
                  ${schedule.enabled === false ? "啟用" : "停用"}
                </button>
                <button class="danger-button mini-button" type="button" data-delete-additive-schedule="${escapeHtml(schedule.id)}">刪除</button>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="notice">尚未建立固定添加設定。</div>`;
}

function renderAnalysis() {
  const analysis = analyze();
  const output = document.querySelector("#analysisOutput");
  if (!analysis) {
    output.innerHTML = `
      <div class="notice">
        目前沒有成功儲存的水質紀錄。請回到「新增水質紀錄」輸入至少一筆完整紀錄；第一筆不可留空，之後才可沿用上一筆。
      </div>
    `;
    return;
  }

  const statusLines = analysis.rows
    .map(
      (row) => `
        <div class="status-row">
          <div>
            <strong>${row.label}</strong>
            <span>目前 ${formatNumber(row.value, row.key === "po4" ? 3 : 2)} ${row.unit}</span>
            ${row.isMeasured ? "" : `<span class="carry-note">沿用上次，非本次測量</span>`}
          </div>
          <div>目標 ${targetToText(row.target)} ${row.unit}</div>
          <span class="status ${row.status.className}">${row.status.text}</span>
          <div>${changeText(row)}</div>
          <div>${actionText(row.recommendationMode)}</div>
        </div>
      `,
    )
    .join("");

  const doseRows = ["kh", "ca", "mg"].map((key) => analysis.rows.find((row) => row.key === key));
  const doseCards = doseRows.map((row) => recommendationCard(row)).join("");
  const recordCount = getSortedRecords().length;
  const latestDate = analysis.latest?.date || "-";

  output.innerHTML = `
    <div class="notice">本工具依輸入數據與保守規則產生建議，請搭配實際缸況與測試誤差判斷。</div>
    <div class="notice compact">最新紀錄：${latestDate}｜目前共 ${recordCount} 筆水質紀錄</div>
    ${dosingReadoutHtml()}
    <div class="analysis-grid">
      <section class="analysis-card full-span">
        <h4>本週水質狀態</h4>
        <div class="status-table">
          <div class="status-row header">
            <div>項目</div>
            <div>目標</div>
            <div>狀態</div>
            <div>與上次相比</div>
            <div>建議動作</div>
          </div>
          ${statusLines}
        </div>
      </section>
      <section class="analysis-card important full-span">
        <h4>滴定建議</h4>
        <div class="recommendation-grid">${doseCards}</div>
        <div class="notice compact">A+：${doseStatusText("aplus")}，建議維持。鉀(K)+：${doseStatusText("kplus")}，建議維持。NO3 / PO4 不提供自動滴定建議。</div>
      </section>
      <section class="analysis-card">
        <h4>下週觀察重點</h4>
        <ul>${nutrientNotes(analysis).map((note) => `<li>${note}</li>`).join("")}</ul>
      </section>
      <section class="analysis-card">
        <h4>營養鹽參考因素</h4>
        ${bioLoadReferenceHtml()}
      </section>
      <section class="analysis-card">
        <h4>最近套用紀錄</h4>
        <div class="summary-list">${recentApplicationsHtml()}</div>
      </section>
    </div>
  `;
}

function renderHistory() {
  const body = document.querySelector("#historyBody");
  const sortedRecords = getSortedRecords();
  const previousById = new Map(sortedRecords.map((record, index) => [record.id, sortedRecords[index - 1] || null]));
  const records = [...sortedRecords].reverse();
  const meta = document.querySelector("#historyMeta");
  if (meta) meta.textContent = `目前 ${records.length} 筆水質紀錄`;
  const valueCell = (record, key) => {
    const previous = previousById.get(record.id);
    const reallyCarried = record.measuredFields
      && record.measuredFields[key] === false
      && previous
      && Math.abs(toNumber(record[key]) - toNumber(previous[key])) <= 0.000001;
    return `${record[key]}${reallyCarried ? "（沿用）" : ""}`;
  };
  const contextCell = (record) => record.snapshot
    ? `<button class="ghost-button mini-button" type="button" data-toggle-history-context="${escapeHtml(record.id)}">查看脈絡</button>`
    : `<span class="muted-line">舊紀錄</span>`;
  body.innerHTML = records.length
    ? records
        .map(
          (record) => {
            const snapshot = record.snapshot;
            return `
            <tr>
              <td>${record.date}</td>
              <td>${valueCell(record, "kh")}</td>
              <td>${valueCell(record, "ca")}</td>
              <td>${valueCell(record, "mg")}</td>
              <td>${valueCell(record, "k")}</td>
              <td>${valueCell(record, "no3")}</td>
              <td>${valueCell(record, "po4")}</td>
              <td>${record.salinity || "-"}</td>
              <td>${record.temperature || "-"}</td>
              <td>${record.note || "-"}</td>
              <td>${contextCell(record)}</td>
            </tr>
            ${snapshot ? historyContextRow(record) : ""}
          `;
          },
        )
        .join("")
    : `<tr><td colspan="11">尚未有紀錄。</td></tr>`;
  renderEventTimeline();
}

function timelineTypeLabel(type) {
  return TIMELINE_EVENT_TYPES.find((item) => item.value === type)?.label || "事件";
}

function timelineMetadataText(event) {
  if (event.type === "measurement" && event.metadata.measuredFields) {
    const inherited = PARAMETERS
      .filter((param) => event.metadata.measuredFields[param.key] === false)
      .map((param) => param.label);
    if (inherited.length) return `${inherited.join("、")} 沿用上一筆`;
  }
  if (event.type === "dosing-apply" && event.metadata.reason) return event.metadata.reason;
  if (event.metadata.note) return event.metadata.note;
  return "";
}

function renderEventTimeline() {
  const container = document.querySelector("#eventTimeline");
  const filter = document.querySelector("#timelineTypeFilter");
  const meta = document.querySelector("#timelineMeta");
  if (!container || !filter || !meta) return;
  const events = buildTimelineEvents(activeTank());
  const visibleEvents = filterTimelineEvents(events, filter.value);
  meta.textContent = filter.value === "all"
    ? `目前 ${events.length} 筆事件`
    : `${timelineTypeLabel(filter.value)} ${visibleEvents.length} 筆`;
  container.innerHTML = visibleEvents.length
    ? visibleEvents
        .map((event) => {
          const detail = timelineMetadataText(event);
          return `
            <article class="timeline-event type-${escapeHtml(event.type)}">
              <div class="timeline-date">${escapeHtml(event.date)}</div>
              <div class="timeline-body">
                <div class="timeline-title-row">
                  <span class="badge muted">${timelineTypeLabel(event.type)}</span>
                  <strong>${escapeHtml(event.title)}</strong>
                </div>
                <p>${escapeHtml(event.summary)}</p>
                ${detail ? `<span class="timeline-detail">${escapeHtml(detail)}</span>` : ""}
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="notice">目前沒有符合條件的事件。</div>`;
}

function historyContextRow(record) {
  const snapshot = record.snapshot || {};
  const dosing = snapshot.dosing || {};
  const recommendations = snapshot.recommendations || [];
  const applied = snapshot.appliedRecommendations || [];
  const feedingsSnapshot = snapshot.feedings || [];
  const additivesSnapshot = snapshot.additives || [];
  const maintenance = snapshot.maintenance;
  const doseText = `KH ${formatNumber(dosing.kh || 0)}｜CA ${formatNumber(dosing.ca || 0)}｜MG ${formatNumber(dosing.mg || 0)} ml/day`;
  const recommendationText = recommendations.length
    ? recommendations.map((item) => `${item.label}：${item.actionText} ${formatNumber(item.suggestedDoseMlPerDay || 0)} ml/day（${item.reason}）`).join("；")
    : "未保存建議";
  const appliedText = applied.length
    ? applied.map((item) => `${item.label}：${formatNumber(item.oldDoseMlPerDay)} → ${formatNumber(item.newDoseMlPerDay)} ml/day`).join("；")
    : "尚未套用";
  const maintenanceText = maintenance
    ? `換水 ${maintenance.waterChangeCount || 0} 次 / ${maintenance.waterChangeVolume || 0} L；${maintenance.note || "無備註"}`
    : "無近期維護紀錄";
  const feedingText = feedingsSnapshot.length
    ? feedingsSnapshot.map((item) => `${item.date} ${item.amountLevel || "-"} ${(item.foodTypes || []).map(foodLabel).join("、") || "未填種類"}`).join("；")
    : "近 7 天無餵食紀錄";
  const additiveText = additivesSnapshot.length
    ? additivesSnapshot.map((item) => `${item.date} ${item.itemLabel || additiveLabel(item.item)} ${formatNumber(item.doseMl || 0)} ml`).join("；")
    : "近 7 天無添加物紀錄";

  return `
    <tr class="history-context-row" data-history-context="${escapeHtml(record.id)}" hidden>
      <td colspan="11">
        <div class="history-context-card">
          <div><strong>當時滴定量</strong><span>${doseText}</span></div>
          <div><strong>當時系統建議</strong><span>${escapeHtml(recommendationText)}</span></div>
          <div><strong>是否套用</strong><span>${escapeHtml(appliedText)}</span></div>
          <div><strong>維護事件</strong><span>${escapeHtml(maintenanceText)}</span></div>
          <div><strong>餵食脈絡</strong><span>${escapeHtml(feedingText)}</span></div>
          <div><strong>添加物脈絡</strong><span>${escapeHtml(additiveText)}</span></div>
        </div>
      </td>
    </tr>
  `;
}

function renderChart() {
  const key = document.querySelector("#trendSelect").value;
  const param = PARAMETERS.find((item) => item.key === key);
  const records = getSortedRecords().filter((record) => Number.isFinite(Number(record[key])));
  const chart = document.querySelector("#chart");
  const tank = tankSettings();

  if (records.length < 2) {
    chart.innerHTML = `<div class="chart-empty">至少需要兩筆紀錄才能顯示趨勢圖。</div>`;
    return;
  }

  const width = 900;
  const height = 340;
  const pad = 48;
  const values = records.map((record) => toNumber(record[key]));
  const target = tank.targets[key];
  const minValue = Math.min(...values, target.min);
  const maxValue = Math.max(...values, target.max);
  const span = maxValue - minValue || 1;
  const x = (index) => pad + (index / (records.length - 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - minValue) / span) * (height - pad * 2);
  const points = records.map((record, index) => `${x(index)},${y(toNumber(record[key]))}`).join(" ");
  const targetYMin = y(target.min);
  const targetYMax = y(target.max);
  const targetTop = Math.min(targetYMin, targetYMax);
  const targetHeight = Math.abs(targetYMax - targetYMin);

  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${param.label} 趨勢圖">
      <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#f8fcfd" />
      <rect x="${pad}" y="${targetTop}" width="${width - pad * 2}" height="${Math.max(targetHeight, 3)}" fill="#e7f6ee" />
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#c7d7dc" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#c7d7dc" />
      <polyline points="${points}" fill="none" stroke="#0e7894" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      ${records
        .map(
          (record, index) => `
            <circle cx="${x(index)}" cy="${y(toNumber(record[key]))}" r="5" fill="#0b2f48" />
            <text x="${x(index)}" y="${height - 16}" text-anchor="middle" fill="#667684" font-size="12">${record.date.slice(5)}</text>
          `,
        )
        .join("")}
      <text x="${pad}" y="24" fill="#13212b" font-size="15" font-weight="700">${param.label} (${param.unit})</text>
      <text x="${width - pad}" y="24" text-anchor="end" fill="#147a53" font-size="13">目標 ${target.min}-${target.max}</text>
      <text x="${pad - 10}" y="${y(maxValue) + 5}" text-anchor="end" fill="#667684" font-size="12">${formatNumber(maxValue, key === "po4" ? 3 : 1)}</text>
      <text x="${pad - 10}" y="${y(minValue) + 5}" text-anchor="end" fill="#667684" font-size="12">${formatNumber(minValue, key === "po4" ? 3 : 1)}</text>
    </svg>
  `;
}

function renderAll({ forms = true, cloud = true } = {}) {
  activeTank();
  renderTankSwitcher();
  if (forms) renderForms();
  renderDashboard();
  renderAnalysis();
  renderHistory();
  renderChart();
  renderBioLoad();
  if (cloud) renderCloudUi();
}

function showToast(message) {
  showFeedback(message);
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function showFeedback(message, { type } = {}) {
  const feedback = document.querySelector("#appFeedback");
  if (!feedback) return;
  const resolvedType = type || (/失敗|錯誤|無法|不能|請先|請輸入|不可|尚未/.test(message) ? "error" : "success");
  window.clearTimeout(feedbackTimer);
  feedback.textContent = message;
  feedback.className = `app-feedback show ${resolvedType}`;
  feedbackTimer = window.setTimeout(() => {
    feedback.classList.remove("show");
  }, 5200);
}

function showSavedFeedback(button, message = "已儲存") {
  if (!button) return;
  const originalText = button.textContent;
  button.textContent = message;
  button.classList.add("saved-pulse");
  window.setTimeout(() => {
    button.textContent = originalText;
    button.classList.remove("saved-pulse");
  }, 1600);
}

function switchPage(id) {
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === id));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.section === id));
  document.querySelector("#pageTitle").textContent = document.querySelector(`.nav-link[data-section="${id}"]`)?.textContent || "首頁";
  if (id === "analysis") renderAnalysis();
  if (id === "dosing") renderDosingSavedMeta();
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function applyDoseRecommendation(parameter) {
  const analysis = analyze();
  if (!analysis) return;
  const row = analysis.rows.find((item) => item.key === parameter);
  if (!row || !row.canApplyRecommendation || !APPLICABLE_DOSE_KEYS.includes(parameter)) {
    showToast("這個項目目前沒有可套用的滴定建議");
    return;
  }

  const oldDose = toNumber(dosingSettings()[row.doseKey]);
  const newDose = toNumber(row.newDose);
  const message = `確定要套用 ${row.label} 建議？\n\n目前：${formatNumber(oldDose)} ml/day\n建議：${formatNumber(newDose)} ml/day\n增減：${formatNumber(row.doseChange)} ml/day\n\n原因：${row.recommendationReason}`;
  if (!confirm(message)) return;

  TankStore.updateDosing(
    { [row.doseKey]: newDose, lastSavedAt: new Date().toISOString() },
    { source: "applyDoseRecommendation", debug: true, forms: true, statusPrefix: "已套用建議" },
  );
  const application = TankStore.addDoseApplication(createDoseApplicationEntry({
    appliedAt: new Date().toLocaleString("zh-Hant"),
    relatedMeasurementId: analysis.latest.id || null,
    parameter: row.key,
    label: row.label,
    oldDose,
    newDose,
    changeAmount: row.doseChange,
    reasonCode: row.reasonCode,
    reason: row.recommendationReason,
  }));
  if (analysis.latest.id) {
    const existingSnapshot = analysis.latest.snapshot || {};
    const appliedRecommendations = [
      ...(existingSnapshot.appliedRecommendations || []),
      {
        id: application.id,
        appliedAt: application.appliedAt,
        label: application.label,
        oldDoseMlPerDay: oldDose,
        newDoseMlPerDay: newDose,
        doseChangeMlPerDay: row.doseChange,
        reason: reasonText(row.reasonCode),
      },
    ];
    TankStore.updateMeasurement(analysis.latest.id, {
      snapshot: { ...existingSnapshot, appliedRecommendations },
    });
  }
  showToast(`${row.label} 滴定建議已套用`);
}

function loadCloudConfig() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY)) || { url: "", anonKey: "" };
  } catch {
    return { url: "", anonKey: "" };
  }
}

function saveCloudConfig(config) {
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(config));
}

function initSupabaseClient() {
  const config = loadCloudConfig();
  if (!config.url || !config.anonKey || !window.supabase) {
    supabaseClient = null;
    return null;
  }
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  return supabaseClient;
}

async function refreshCloudSession() {
  const client = supabaseClient || initSupabaseClient();
  if (!client) {
    cloudSession = null;
    renderCloudStatus();
    return null;
  }
  const { data, error } = await client.auth.getSession();
  if (error) {
    cloudSession = null;
  } else {
    cloudSession = data.session || null;
  }
  renderCloudStatus();
  return cloudSession;
}

function renderCloudConfig() {
  const config = loadCloudConfig();
  document.querySelector("#supabaseUrl").value = config.url || "";
  document.querySelector("#supabaseAnonKey").value = config.anonKey || "";
}

function renderCloudStatus() {
  const badge = document.querySelector("#cloudStatusBadge");
  const summary = document.querySelector("#cloudSummary");
  const config = loadCloudConfig();
  if (!window.supabase) {
    badge.textContent = "套件未載入";
    badge.className = "badge muted";
    summary.innerHTML = `<div class="notice">無法載入 Supabase 套件。若離線或 CDN 被阻擋，雲端同步暫時不可用。</div>`;
    return;
  }
  if (!config.url || !config.anonKey) {
    badge.textContent = "未設定";
    badge.className = "badge muted";
    summary.innerHTML = `<div class="notice">請先填入 Supabase Project URL 與 anon key。</div>`;
    return;
  }
  if (!cloudSession) {
    badge.textContent = "未登入";
    badge.className = "badge muted";
    summary.innerHTML = `<div class="notice">雲端設定已儲存。登入後即可同步手機與電腦資料。</div>`;
    return;
  }
  badge.textContent = "已登入";
  badge.className = "badge";
  summary.innerHTML = `
    <div class="summary-item">帳號：${escapeHtml(cloudSession.user.email || cloudSession.user.id)}</div>
    <div class="summary-item">同步資料：所有魚缸、紀錄、滴定設定、套用紀錄</div>
    <div class="summary-item">模式：本機儲存後會自動排程上傳，也可手動上傳或下載。</div>
  `;
}

function renderCloudUi() {
  renderCloudConfig();
  renderCloudStatus();
}

function scheduleCloudSave() {
  if (suppressCloudSave || !cloudSession || !supabaseClient) return;
  window.clearTimeout(cloudSaveTimer);
  cloudSaveTimer = window.setTimeout(() => {
    uploadCloudState({ silent: true });
  }, 1200);
}

async function uploadCloudState({ silent = false } = {}) {
  const client = supabaseClient || initSupabaseClient();
  if (!client) {
    if (!silent) showToast("請先設定 Supabase");
    return false;
  }
  const session = cloudSession || (await refreshCloudSession());
  if (!session) {
    if (!silent) showToast("請先登入");
    return false;
  }
  const payload = TankStore.serializeState();
  const { error } = await client.from(CLOUD_TABLE).upsert({
    user_id: session.user.id,
    data: payload,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    if (!silent) showToast(`上傳失敗：${error.message}`);
    renderCloudStatus();
    return false;
  }
  if (!silent) showToast("已上傳到雲端");
  renderCloudStatus();
  return true;
}

async function downloadCloudState() {
  const client = supabaseClient || initSupabaseClient();
  if (!client) {
    showToast("請先設定 Supabase");
    return;
  }
  const session = cloudSession || (await refreshCloudSession());
  if (!session) {
    showToast("請先登入");
    return;
  }
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select("data, updated_at")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) {
    showToast(`下載失敗：${error.message}`);
    return;
  }
  if (!data || !data.data) {
    showToast("雲端目前沒有資料，請先上傳");
    return;
  }
  if (!confirm(`確定要用雲端資料覆蓋這台裝置的資料？\n\n雲端更新時間：${data.updated_at || "未知"}`)) return;
  suppressCloudSave = true;
  TankStore.replaceState(data.data);
  suppressCloudSave = false;
  showToast("已從雲端下載");
}

async function signInCloud() {
  const client = supabaseClient || initSupabaseClient();
  if (!client) {
    showToast("請先儲存雲端設定");
    return;
  }
  const email = document.querySelector("#authEmail").value.trim();
  const password = document.querySelector("#authPassword").value;
  if (!email || !password) {
    showToast("請輸入 Email 和密碼");
    return;
  }
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    showToast(`登入失敗：${error.message}`);
    return;
  }
  cloudSession = data.session;
  renderCloudStatus();
  showToast("已登入");
}

async function signUpCloud() {
  const client = supabaseClient || initSupabaseClient();
  if (!client) {
    showToast("請先儲存雲端設定");
    return;
  }
  const email = document.querySelector("#authEmail").value.trim();
  const password = document.querySelector("#authPassword").value;
  if (!email || !password) {
    showToast("請輸入 Email 和密碼");
    return;
  }
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) {
    showToast(`建立帳號失敗：${error.message}`);
    return;
  }
  cloudSession = data.session || null;
  renderCloudStatus();
  showToast(cloudSession ? "帳號已建立並登入" : "帳號已建立，請依 Supabase 設定完成 Email 驗證");
}

async function signOutCloud() {
  const client = supabaseClient || initSupabaseClient();
  if (!client) return;
  await client.auth.signOut();
  cloudSession = null;
  renderCloudStatus();
  showToast("已登出");
}

function setupEvents() {
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.addEventListener("click", () => switchPage(button.dataset.section));
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-goto]");
    if (target) switchPage(target.dataset.goto);
    const applyTarget = event.target.closest("[data-apply-dose]");
    if (applyTarget) applyDoseRecommendation(applyTarget.dataset.applyDose);
    const removeFishTarget = event.target.closest("[data-remove-fish]");
    if (removeFishTarget) {
      TankStore.updateFish(removeFishTarget.dataset.removeFish, { removed: true, removedAt: todayText() });
      showToast("魚隻已標記移除");
    }
    const fishDelete = event.target.closest("[data-delete-fish]");
    if (fishDelete) {
      const deleted = TankStore.deleteFish(fishDelete.dataset.deleteFish);
      showToast(deleted ? "魚隻資料已刪除" : "找不到要刪除的魚隻資料");
      return;
    }
    const feedingDelete = event.target.closest("[data-delete-feeding]");
    if (feedingDelete) {
      const deleted = TankStore.deleteFeeding(feedingDelete.dataset.deleteFeeding);
      showToast(deleted ? "餵食紀錄已刪除" : "找不到要刪除的餵食紀錄");
      return;
    }
    const additiveDelete = event.target.closest("[data-delete-additive]");
    if (additiveDelete) {
      const deleted = TankStore.deleteAdditive(additiveDelete.dataset.deleteAdditive);
      showToast(deleted ? "添加物紀錄已刪除" : "找不到要刪除的添加物紀錄");
      return;
    }
    const historyContextToggle = event.target.closest("[data-toggle-history-context]");
    if (historyContextToggle) {
      const row = document.querySelector(`[data-history-context="${CSS.escape(historyContextToggle.dataset.toggleHistoryContext)}"]`);
      if (row) {
        row.hidden = !row.hidden;
        historyContextToggle.textContent = row.hidden ? "查看脈絡" : "收合脈絡";
      }
      return;
    }
    const scheduleToggle = event.target.closest("[data-toggle-additive-schedule]");
    if (scheduleToggle) {
      const schedule = additiveSchedules().find((item) => item.id === scheduleToggle.dataset.toggleAdditiveSchedule);
      if (schedule) {
        TankStore.updateAdditiveSchedule(schedule.id, { enabled: schedule.enabled === false });
        showToast(schedule.enabled === false ? "固定添加已啟用" : "固定添加已停用");
      }
    }
    const scheduleDelete = event.target.closest("[data-delete-additive-schedule]");
    if (scheduleDelete) {
      const deleted = TankStore.deleteAdditiveSchedule(scheduleDelete.dataset.deleteAdditiveSchedule);
      showToast(deleted ? "固定添加已刪除" : "找不到要刪除的固定添加");
      return;
    }
  });

  document.querySelector("#tankSelect").addEventListener("change", (event) => {
    TankStore.setActiveTank(event.target.value);
    showToast(`已切換到 ${tankSettings().name}`);
  });

  document.querySelector("#addTankBtn").addEventListener("click", () => {
    TankStore.addTank(`魚缸 ${TankStore.getState().tanks.length + 1}`);
    switchPage("tank");
    showToast("新魚缸已建立");
  });

  document.querySelector("#saveCloudConfigBtn").addEventListener("click", async () => {
    const url = document.querySelector("#supabaseUrl").value.trim();
    const anonKey = document.querySelector("#supabaseAnonKey").value.trim();
    saveCloudConfig({ url, anonKey });
    initSupabaseClient();
    await refreshCloudSession();
    showToast("雲端設定已儲存");
  });

  document.querySelector("#clearCloudConfigBtn").addEventListener("click", () => {
    localStorage.removeItem(CLOUD_CONFIG_KEY);
    supabaseClient = null;
    cloudSession = null;
    renderCloudUi();
    showToast("雲端設定已清除");
  });

  document.querySelector("#signInBtn").addEventListener("click", signInCloud);
  document.querySelector("#signUpBtn").addEventListener("click", signUpCloud);
  document.querySelector("#signOutBtn").addEventListener("click", signOutCloud);
  document.querySelector("#uploadCloudBtn").addEventListener("click", () => uploadCloudState());
  document.querySelector("#downloadCloudBtn").addEventListener("click", downloadCloudState);

  document.querySelector("#tankForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    const parsedTargets = {};
    for (const param of PARAMETERS) {
      const rawTarget = data[`${param.key}Target`];
      const parsed = parseTargetExpression(rawTarget, param);
      if (!parsed) {
        showToast(`${param.label} 目標格式無法解析`);
        return;
      }
      parsedTargets[param.key] = { raw: rawTarget.trim(), target: parsed };
    }

    const targets = {};
    const targetInputs = {};
    PARAMETERS.forEach((param) => {
      targets[param.key] = parsedTargets[param.key].target;
      targetInputs[param.key] = parsedTargets[param.key].raw;
    });
    TankStore.updateTankSettings({
      name: data.name.trim() || DEFAULT_TANK.name,
      volume: toNumber(data.volume, DEFAULT_TANK.volume),
      targets,
      targetInputs,
    });
    showSavedFeedback(event.submitter);
    showToast("魚缸設定已儲存");
  });

  document.querySelector("#waterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    const result = buildMeasurementFromForm(data);
    if (result.error) {
      showToast(result.error);
      return;
    }
    result.record.snapshot = buildMeasurementSnapshot(result.record);
    const saveResult = TankStore.upsertMeasurementByDate(result.record);
    event.currentTarget.reset();
    event.currentTarget.date.value = todayText();
    switchPage("analysis");
    showSavedFeedback(event.submitter, saveResult.mode === "updated" ? "已更新" : "已新增");
    const savedText = saveResult.mode === "updated" ? "同日期水質紀錄已更新，不重複新增" : "水質紀錄已新增";
    showToast(result.carriedFields.length ? `${savedText}；${result.carriedFields.join("、")} 沿用上一筆` : savedText);
  });

  document.querySelector("#dosingForm").addEventListener("submit", (event) => {
    event.preventDefault();
    window.clearTimeout(dosingAutoSaveTimer);
    saveDosingFromForm({ rerenderForms: true });
    showSavedFeedback(event.submitter);
  });

  document.querySelector("#dosingForm").addEventListener("input", scheduleDosingAutoSave);
  document.querySelector("#dosingForm").addEventListener("change", scheduleDosingAutoSave);

  document.querySelector("#maintenanceForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = formData(form);
    TankStore.addMaintenance({
      date: todayText(),
      waterChangeCount: toNumber(data.waterChangeCount),
      waterChangeVolume: toNumber(data.waterChangeVolume),
      newFish: form.newFish.checked,
      newCoral: form.newCoral.checked,
      moreFeeding: form.moreFeeding.checked,
      changedAdditive: form.changedAdditive.checked,
      note: data.note.trim(),
    });
    form.reset();
    showSavedFeedback(event.submitter);
    showToast("維護紀錄已儲存");
  });

  document.querySelector("#fishForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    TankStore.addFish({
      name: data.name.trim(),
      quantity: Math.max(1, toNumber(data.quantity, 1)),
      addedAt: data.addedAt || todayText(),
      removed: false,
    });
    event.currentTarget.reset();
    event.currentTarget.addedAt.value = todayText();
    showSavedFeedback(event.submitter, "已新增");
    showToast("魚隻資料已新增");
  });

  document.querySelector("#feedingForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const raw = new FormData(event.currentTarget);
    TankStore.addFeeding(normalizeFeedingLog({
      date: raw.get("date") || todayText(),
      amountLevel: raw.get("amountLevel"),
      frequency: raw.get("frequency"),
      foodTypes: raw.getAll("foodTypes"),
      note: String(raw.get("note") || "").trim(),
    }));
    event.currentTarget.reset();
    event.currentTarget.date.value = todayText();
    event.currentTarget.amountLevel.value = "中";
    event.currentTarget.frequency.value = "每天 1 次";
    showSavedFeedback(event.submitter, "已新增");
    showToast("餵食紀錄已新增");
  });

  document.querySelector("#additiveForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = new FormData(form);
    TankStore.addAdditive(normalizeAdditiveLog({
      date: raw.get("date") || todayText(),
      item: raw.get("item"),
      doseMl: raw.get("doseMl"),
      coralFed: form.coralFed.checked,
      autoDosed: form.autoDosed.checked,
      frequency: raw.get("frequency"),
      note: String(raw.get("note") || "").trim(),
    }));
    form.reset();
    form.date.value = todayText();
    form.item.value = "red-sea-ab-plus";
    form.frequency.value = "單次";
    showSavedFeedback(event.submitter, "已新增");
    showToast("添加物紀錄已新增");
  });

  document.querySelector("#additiveScheduleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = new FormData(form);
    const additive = normalizeAdditiveLog({
      date: todayText(),
      item: raw.get("item"),
      doseMl: raw.get("doseMl"),
      frequency: "每週 1 次",
      note: String(raw.get("note") || "").trim(),
    });
    TankStore.addAdditiveSchedule({
      weekday: raw.get("weekday") || "1",
      item: additive.item,
      itemLabel: additive.itemLabel,
      doseMl: additive.doseMl,
      enabled: form.enabled.checked,
      note: additive.note,
    });
    form.reset();
    form.weekday.value = "1";
    form.item.value = "red-sea-ab-plus";
    form.enabled.checked = true;
    showSavedFeedback(event.submitter, "已新增");
    showToast("固定添加已新增");
  });

  document.querySelector("#trendSelect").addEventListener("change", renderChart);
  document.querySelector("#timelineTypeFilter").addEventListener("change", renderEventTimeline);

  document.querySelector("#exportBtn").addEventListener("click", (event) => {
    const blob = new Blob([JSON.stringify(TankStore.serializeState(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `seawater-tank-${todayText()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showSavedFeedback(event.currentTarget, "已備份");
    showToast("備份檔已下載，請保留在你找得到的位置。");
  });

  document.querySelector("#importInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const restoreResult = restoreBackupText(await file.text(), {
        confirmRestore: (imported) => confirm(`要用這份備份還原嗎？\n\n這會覆蓋這台裝置目前的資料。\n備份內魚缸數：${imported.tanks.length}\n\n建議先確認你已保留需要的資料。`),
        replaceState: (imported) => TankStore.replaceState(imported),
      });
      if (restoreResult.status === "INVALID_JSON") {
        showToast("還原失敗，請確認備份檔是否正確");
        return;
      }
      if (restoreResult.status === "INVALID_STRUCTURE") {
        showToast("還原失敗，這不是本工具產生的備份檔。");
        return;
      }
      if (restoreResult.status === "CANCELLED") showToast("已取消還原，原本資料未變更。");
      if (restoreResult.status === "RESTORED") showToast("備份已還原，畫面已更新。");
    } catch {
      showToast("還原失敗，請確認備份檔是否正確");
    } finally {
      event.target.value = "";
    }
  });

  document.querySelector("#clearBtn").addEventListener("click", () => {
    if (!confirm("確定要清除所有魚缸與紀錄？")) return;
    TankStore.clear();
    showToast("資料已清除");
  });
}

setupEvents();
renderAll();
initSupabaseClient();
refreshCloudSession();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // PWA registration is optional; the app still works as a normal website.
    });
  });
}
