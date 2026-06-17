import {
  buildMeasurementSopSummary,
  convertMeasurementReading,
  getMeasurementSop,
  MEASUREMENT_SOP_ORDER,
  stepText,
} from "../modules/measurementSopModule.js";

function formatReading(value) {
  return Number(value).toLocaleString("zh-Hant", { maximumFractionDigits: 4 });
}

export function createMeasurementSopController({
  root,
  onApply,
  onSkip = () => {},
  onToast = () => {},
}) {
  let parameter = MEASUREMENT_SOP_ORDER[0];
  let mode = "standard";
  let stepIndex = 0;
  let sequenceMode = false;
  let sequenceComplete = false;
  let sequenceResults = {};
  let timerId = null;
  let timerRemaining = 0;
  let timerStartedAt = null;
  let timerDurationSeconds = 0;
  let timerEndsAt = null;
  let timerFinished = false;

  function sop() {
    return getMeasurementSop(parameter);
  }

  function clearTimer() {
    if (timerId) window.clearInterval(timerId);
    timerId = null;
    timerRemaining = 0;
    timerStartedAt = null;
    timerDurationSeconds = 0;
    timerEndsAt = null;
    timerFinished = false;
  }

  function close() {
    clearTimer();
    root.hidden = true;
    document.body.classList.remove("sop-open");
  }

  function timerText() {
    const minutes = Math.floor(timerRemaining / 60);
    const seconds = String(timerRemaining % 60).padStart(2, "0");
    return minutes ? `${minutes}:${seconds}` : `${timerRemaining} 秒`;
  }

  function calculateTimerRemaining() {
    if (!timerEndsAt) return timerRemaining;
    return Math.max(0, Math.ceil((timerEndsAt - Date.now()) / 1000));
  }

  function renderTimer() {
    timerRemaining = calculateTimerRemaining();
    const display = root.querySelector("#sopTimerDisplay");
    const button = root.querySelector("#sopTimerBtn");
    if (display) display.textContent = timerRemaining > 0 ? timerText() : timerFinished ? "時間到" : "完成";
    if (button) button.textContent = timerId ? "停止倒數" : timerRemaining > 0 ? "繼續倒數" : "重新倒數";
  }

  function finishTimer() {
    if (timerId) window.clearInterval(timerId);
    timerId = null;
    timerEndsAt = null;
    timerRemaining = 0;
    timerFinished = true;
    renderTimer();
    onToast("等待時間完成");
  }

  function syncTimer() {
    if (!timerEndsAt) return;
    timerRemaining = calculateTimerRemaining();
    if (timerRemaining <= 0) {
      finishTimer();
      return;
    }
    renderTimer();
  }

  function startTimer(seconds) {
    if (timerId) {
      window.clearInterval(timerId);
      timerId = null;
      timerRemaining = calculateTimerRemaining();
      timerEndsAt = null;
      renderTimer();
      return;
    }
    timerDurationSeconds = seconds;
    if (timerRemaining <= 0) timerRemaining = seconds;
    timerFinished = false;
    timerStartedAt = Date.now();
    timerEndsAt = timerStartedAt + timerRemaining * 1000;
    timerId = window.setInterval(syncTimer, 1000);
    syncTimer();
  }

  function syncTimerAfterResume() {
    if (!timerId || !timerEndsAt) return;
    syncTimer();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncTimerAfterResume();
  });
  window.addEventListener("focus", syncTimerAfterResume);

  function render() {
    clearTimer();
    if (sequenceComplete) {
      const summary = buildMeasurementSopSummary(sequenceResults);
      const labels = (keys) => keys.map((key) => getMeasurementSop(key).label).join("、") || "無";

      root.innerHTML = `
        <div class="sop-backdrop" data-sop-close></div>
        <section class="sop-sheet" role="dialog" aria-modal="true" aria-labelledby="sopTitle">
          <header class="sop-header">
            <div>
              <p class="eyebrow">測量流程完成</p>
              <h3 id="sopTitle">確認本次測量</h3>
            </div>
            <button class="sop-close-button" type="button" data-sop-close aria-label="結束測量流程">
              <span aria-hidden="true">×</span>
              <small>結束</small>
            </button>
          </header>
          <div class="sop-progress"><span style="width:100%"></span></div>
          <main class="sop-content sop-summary-content">
            <div class="sop-summary-hero">
              <strong>${summary.measured.length} 項實測</strong>
              <span>${summary.skipped.length} 項跳過／沿用</span>
            </div>
            <div class="sop-summary-list">
              <article>
                <span>本次有測量</span>
                <strong>${labels(summary.measured)}</strong>
              </article>
              <article>
                <span>跳過／沿用上一筆</span>
                <strong>${labels(summary.skipped)}</strong>
              </article>
              <article class="is-recommendation">
                <span>會參與滴定建議</span>
                <strong>${labels(summary.recommendationEligible)}</strong>
                <small>只有本次實測的 KH／CA／MG 會參與滴定微調。</small>
              </article>
            </div>
            <div class="sop-note">
              跳過項目會保持空白。儲存水質紀錄時，系統會沿用上一筆並標記為未實測，不會用來產生滴定調整。
            </div>
          </main>
          <footer class="sop-actions sop-summary-actions">
            <button class="primary-button" type="button" id="sopFinishBtn">返回測量表單</button>
          </footer>
        </section>
      `;
      root.querySelectorAll("[data-sop-close]").forEach((button) => button.addEventListener("click", close));
      root.querySelector("#sopFinishBtn").addEventListener("click", () => {
        close();
        onToast("測量流程完成，請確認後儲存水質紀錄");
      });
      return;
    }

    const currentSop = sop();
    const isResult = stepIndex >= currentSop.steps.length;
    const total = currentSop.steps.length + 1;
    const currentNumber = Math.min(stepIndex + 1, total);
    const currentStep = currentSop.steps[stepIndex];
    const selectedMode = currentSop.modes.find((item) => item.value === mode) || currentSop.modes[0];
    const nextParameter = MEASUREMENT_SOP_ORDER[MEASUREMENT_SOP_ORDER.indexOf(parameter) + 1] || null;

    root.innerHTML = `
      <div class="sop-backdrop" data-sop-close></div>
      <section class="sop-sheet" role="dialog" aria-modal="true" aria-labelledby="sopTitle">
        <header class="sop-header">
          <div>
            <p class="eyebrow">${currentSop.product}</p>
            <h3 id="sopTitle">${currentSop.label} 測量流程</h3>
          </div>
            <button class="sop-close-button" type="button" data-sop-close aria-label="結束測量流程">
              <span aria-hidden="true">×</span>
              <small>結束</small>
            </button>
        </header>

        <div class="sop-progress" aria-label="測量進度">
          <span style="width:${(currentNumber / total) * 100}%"></span>
        </div>
        <div class="sop-step-meta">
          <strong>${isResult ? "輸入結果" : `步驟 ${currentNumber} / ${currentSop.steps.length}`}</strong>
          <span>${currentSop.label}｜${selectedMode.label}</span>
        </div>

        ${currentSop.modes.length > 1 && stepIndex === 0 ? `
          <label class="sop-mode-select">
            測量模式
            <select id="sopModeSelect">
              ${currentSop.modes.map((item) => `
                <option value="${item.value}" ${item.value === selectedMode.value ? "selected" : ""}>${item.label}</option>
              `).join("")}
            </select>
          </label>
        ` : ""}

        <main class="sop-content">
          ${isResult ? `
            <div class="sop-result-panel">
              <p class="eyebrow">最後一步</p>
              <h4>輸入${parameter === "k" ? "查表後的鉀值" : "對照表原始讀值"}</h4>
              <label>
                原始讀值 ${currentSop.unit}
                <input id="sopRawValue" type="text" inputmode="decimal" placeholder="請輸入數值" autocomplete="off" />
              </label>
              <div class="sop-conversion">
                <span>使用模式</span><strong>${selectedMode.label}</strong>
                <span>換算方式</span><strong>${selectedMode.formula}</strong>
                <span>最終數值</span><strong id="sopFinalValue">尚未輸入</strong>
              </div>
              ${parameter === "k" ? `<div class="sop-warning">請先依 K-3 滴數查說明書表格，再輸入鉀值 ppm。</div>` : ""}
            </div>
          ` : `
            <article class="sop-step-card">
              <p class="eyebrow">現在要做</p>
              <h4>${currentStep.title}</h4>
              <p class="sop-instruction">${stepText(currentStep, selectedMode.value)}</p>
              ${currentStep.caution ? `<div class="sop-note"><strong>注意</strong>${currentStep.caution}</div>` : ""}
              ${currentStep.error ? `<div class="sop-warning"><strong>常見錯誤</strong>${currentStep.error}</div>` : ""}
              ${currentStep.waitSeconds ? `
                <div class="sop-timer">
                  <div><span>建議時間</span><strong id="sopTimerDisplay">${currentStep.waitSeconds} 秒</strong></div>
                  <button class="ghost-button" id="sopTimerBtn" type="button">開始倒數</button>
                </div>
              ` : `<div class="sop-no-wait">這一步不需要等待</div>`}
            </article>
          `}
        </main>

        <footer class="sop-actions">
          <div class="sop-primary-actions">
            <button class="ghost-button" type="button" id="sopBackBtn" ${stepIndex === 0 ? "disabled" : ""}>上一步</button>
            ${isResult
              ? `<button class="primary-button" type="button" id="sopApplyBtn">帶入測量紀錄</button>`
              : `<button class="primary-button" type="button" id="sopNextBtn">下一步</button>`}
          </div>
          ${sequenceMode && nextParameter && isResult ? `<p class="sop-next-hint">帶入後將繼續下一項：${getMeasurementSop(nextParameter).label}</p>` : ""}
          <button class="sop-skip-button" type="button" id="sopSkipBtn">跳過此項，沿用上一筆。</button>
          <button class="sop-manual-button" type="button" data-sop-close>跳過 SOP，直接手動輸入</button>
        </footer>
      </section>
    `;

    root.querySelectorAll("[data-sop-close]").forEach((button) => button.addEventListener("click", close));
    root.querySelector("#sopBackBtn").addEventListener("click", () => {
      stepIndex = Math.max(0, stepIndex - 1);
      render();
    });
    const modeSelect = root.querySelector("#sopModeSelect");
    if (modeSelect) {
      modeSelect.addEventListener("change", (event) => {
        mode = event.target.value;
        render();
      });
    }
    const timerButton = root.querySelector("#sopTimerBtn");
    if (timerButton) timerButton.addEventListener("click", () => startTimer(currentStep.waitSeconds));
    root.querySelector("#sopSkipBtn").addEventListener("click", () => {
      const skippedSop = currentSop;
      onSkip(parameter);
      sequenceResults[parameter] = { status: "skipped" };
      if (!sequenceMode) {
        close();
        onToast(`${skippedSop.label} 已跳過，儲存時將沿用上一筆`);
        return;
      }
      const currentIndex = MEASUREMENT_SOP_ORDER.indexOf(parameter);
      const next = MEASUREMENT_SOP_ORDER[currentIndex + 1];
      if (next) {
        parameter = next;
        mode = getMeasurementSop(next).modes[0].value;
        stepIndex = 0;
        render();
        onToast(`${skippedSop.label} 已跳過，繼續 ${getMeasurementSop(next).label}`);
        return;
      }
      sequenceComplete = true;
      render();
    });
    const nextButton = root.querySelector("#sopNextBtn");
    if (nextButton) {
      nextButton.addEventListener("click", () => {
        stepIndex += 1;
        render();
      });
    }

    const rawInput = root.querySelector("#sopRawValue");
    if (rawInput) {
      const updateResult = () => {
        const result = convertMeasurementReading({ parameter, rawValue: rawInput.value, mode });
        root.querySelector("#sopFinalValue").textContent = result.error
          ? "請輸入有效數值"
          : `${formatReading(result.finalValue)} ${currentSop.unit}`;
      };
      rawInput.addEventListener("input", updateResult);
      root.querySelector("#sopApplyBtn").addEventListener("click", () => {
        const result = convertMeasurementReading({ parameter, rawValue: rawInput.value, mode });
        if (result.error) {
          onToast(result.error);
          rawInput.focus();
          return;
        }
        onApply(result);
        sequenceResults[parameter] = { status: "measured", ...result };
        const currentIndex = MEASUREMENT_SOP_ORDER.indexOf(parameter);
        const next = MEASUREMENT_SOP_ORDER[currentIndex + 1];
        if (sequenceMode && next) {
          parameter = next;
          mode = getMeasurementSop(next).modes[0].value;
          stepIndex = 0;
          render();
          onToast(`${currentSop.label} 已帶入，繼續 ${getMeasurementSop(next).label}`);
          return;
        }
        if (sequenceMode) {
          sequenceComplete = true;
          render();
          return;
        }
        close();
        onToast(`${currentSop.label} 已帶入測量紀錄`);
      });
      window.setTimeout(() => rawInput.focus(), 50);
    }
  }

  function open(nextParameter = MEASUREMENT_SOP_ORDER[0], options = {}) {
    const nextSop = getMeasurementSop(nextParameter);
    if (!nextSop) return;
    parameter = nextParameter;
    mode = nextSop.modes[0].value;
    stepIndex = 0;
    sequenceMode = Boolean(options.sequence);
    sequenceComplete = false;
    sequenceResults = {};
    root.hidden = false;
    document.body.classList.add("sop-open");
    render();
  }

  return { open, close };
}
