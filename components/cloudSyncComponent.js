const PHASE_LABELS = {
  signed_out: "未登入", checking: "確認中", awaiting_import: "等待首次匯入",
  awaiting_load: "等待載入", syncing: "同步中", connected: "已連線", conflict: "待確認", error: "同步失敗",
};

export function renderCloudSyncView({ root, status, session, configured, checkingSetup, authBusy, connectionError = "" }) {
  const element = (id) => root.querySelector(`#${id}`);
  const busy = authBusy || ["checking", "syncing"].includes(status.phase);
  const warning = ["conflict", "error"].includes(status.phase) || Boolean(connectionError);
  element("cloudStatusBadge").textContent = checkingSetup ? "確認中" : !configured ? "尚未啟用" : PHASE_LABELS[status.phase];
  element("cloudStatusBadge").className = `badge ${status.phase === "connected" ? "cloud-connected" : warning ? "cloud-warning" : "muted"}`;
  element("cloudLocalCount").textContent = status.local.records;
  element("cloudLocalTanks").textContent = `${status.local.tanks} 個魚缸`;
  element("cloudRemoteCount").textContent = status.remote ? status.remote.records : "—";
  element("cloudRemoteTanks").textContent = status.remote ? `${status.remote.tanks} 個魚缸` : "尚未連線";
  element("cloudAccount").textContent = session?.user.email || "";
  element("cloudAccount").hidden = !session;
  element("cloudSetupNotice").hidden = configured && !connectionError;
  element("cloudSetupNotice").textContent = checkingSetup
    ? "正在確認雲端連線"
    : connectionError || "雲端後台尚未啟用，本機紀錄照常保留。";
  element("cloudAuthForm").hidden = !configured || Boolean(session);
  root.querySelectorAll("#cloudAuthForm input, #cloudAuthForm button").forEach((input) => { input.disabled = authBusy; });
  element("cloudImportActions").hidden = status.phase !== "awaiting_import";
  element("uploadCloudBtn").disabled = busy || !status.local.tanks;
  element("uploadCloudBtn").textContent = `首次匯入 ${status.local.records} 筆紀錄`;
  element("cloudLoadActions").hidden = !["awaiting_load", "conflict"].includes(status.phase);
  element("downloadCloudBtn").disabled = busy;
  element("cloudConnectedActions").hidden = !["connected", "error", "conflict"].includes(status.phase) || !session;
  element("cloudSyncNowBtn").disabled = busy;
  element("signOutBtn").hidden = !session;
  element("signOutBtn").disabled = busy;
  element("gptSyncStatus").textContent = status.phase === "connected" && status.pending ? "本機有新紀錄，等待同步" : status.message;
  element("gptSyncStatus").hidden = !configured;
  element("gptSyncStatus").className = `cloud-sync-message ${warning ? "is-warning" : status.phase === "connected" ? "is-connected" : ""}`;
  element("cloudLastSynced").textContent = status.lastSyncedAt ? `最後同步 ${new Date(status.lastSyncedAt).toLocaleString("zh-TW")}` : "尚未完成同步";
  element("cloudImportProtection").hidden = !["connected", "conflict", "awaiting_load"].includes(status.phase);
  element("gptLinkDetails").hidden = !session;
}
