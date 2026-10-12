export function cloudDataSummary(data) {
  const tanks = Array.isArray(data?.tanks) ? data.tanks : [];
  return {
    tanks: tanks.length,
    records: tanks.reduce((count, tank) => count + (tank.records?.length || 0) + (tank.archivedRecords?.length || 0), 0),
  };
}

function validState(data) {
  return data && Array.isArray(data.tanks) && data.tanks.every((tank) =>
    tank && typeof tank.id === "string" && tank.tank && Array.isArray(tank.records));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

async function digest(data) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(data))));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloudError(error) {
  if (error?.message?.includes("CLOUD_REVISION_CONFLICT")) return "另一台裝置已更新雲端。這台的紀錄仍保留，請先確認再載入雲端。";
  if (error?.message?.includes("CLOUD_ALREADY_INITIALIZED")) return "雲端已經有資料，不能再次匯入本機資料覆蓋。";
  if (error?.message?.includes("LOCAL_BACKUP_FAILED")) return "無法保存本機安全備份，暫不載入雲端；原本紀錄仍保留。";
  if (error?.message?.includes("LOCAL_METADATA_FAILED")) return "無法保存同步狀態，已暫停自動同步；本機紀錄仍保留。";
  if (error?.message?.includes("LOCAL_DRAFT_PENDING")) return "有尚未儲存的測量輸入，已保留；請先儲存或完成測量，再重新同步。";
  if (error?.message?.includes("INVALID_CLOUD_STATE")) return "雲端資料格式不正確，沒有取代本機紀錄。";
  if (error?.code === "PGRST202" || error?.code === "42703") return "雲端資料表尚未更新，請完成後台設定；本機紀錄仍保留。";
  return "暫時無法同步，本機紀錄仍保留。請恢復網路後再試。";
}

export function createSupabaseCloudRepository(client, ownerId) {
  return {
    async load() {
      const { data, error } = await client.from("user_app_state")
        .select("data,updated_at,revision").eq("user_id", ownerId).maybeSingle();
      if (error) throw error;
      return data;
    },
    async initialize(data) {
      const response = await client.rpc("reef_initialize_app_state", { p_data: data });
      if (response.error) throw response.error;
      return response.data;
    },
    async save(data, revision) {
      const response = await client.rpc("reef_save_app_state", { p_data: data, p_expected_revision: revision });
      if (response.error) throw response.error;
      return response.data;
    },
  };
}

export function createCloudSyncController({ getLocalState, replaceLocalState, saveBackup, loadMetadata, saveMetadata, onChange = () => {} }) {
  let binding = null;
  let generation = 0;
  let changes = 0;
  let syncedChanges = 0;
  let hydrating = false;
  let queue = Promise.resolve();
  let status = { phase: "signed_out", remote: null, revision: null, lastSyncedAt: null, message: "尚未登入雲端" };

  function update(patch) {
    status = { ...status, ...patch };
    onChange(getStatus());
  }

  function getStatus() {
    return { ...status, local: cloudDataSummary(getLocalState()), pending: changes > syncedChanges, canPublish: Boolean(binding) && ["connected", "error"].includes(status.phase) && Number.isInteger(status.revision) };
  }

  function fail(error) {
    const conflict = /CLOUD_REVISION_CONFLICT|CLOUD_ALREADY_INITIALIZED/.test(error?.message || "");
    update({ phase: conflict ? "conflict" : "error", message: cloudError(error), ...(["LOCAL_METADATA_FAILED", "LOCAL_DRAFT_PENDING"].includes(error?.message) ? { revision: null } : {}) });
    return false;
  }

  function checkSnapshot(snapshot) {
    if (!snapshot || !validState(snapshot.data) || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("INVALID_CLOUD_STATE");
  }

  async function acceptSnapshot(snapshot, submitted, submittedChanges, key, ticket) {
    checkSnapshot(snapshot);
    const metadata = { ownerKey: key, revision: snapshot.revision, digest: await digest(submitted), updatedAt: snapshot.updated_at };
    if (generation !== ticket) return false;
    if (!saveMetadata(metadata)) throw new Error("LOCAL_METADATA_FAILED");
    syncedChanges = submittedChanges;
    update({ phase: "connected", revision: snapshot.revision, remote: cloudDataSummary(snapshot.data), lastSyncedAt: snapshot.updated_at, message: "雲端資料已啟用" });
    return true;
  }

  async function hydrate(snapshot, key, expectedGeneration) {
    checkSnapshot(snapshot);
    const before = structuredClone(getLocalState());
    if (before.tanks.length && !saveBackup(before)) throw new Error("LOCAL_BACKUP_FAILED");
    if (generation !== expectedGeneration) return false;
    // Mark ownership uncertain before replacing data; logout can interrupt the later digest.
    if (!saveMetadata({ ownerKey: key, revision: null, digest: "", updatedAt: null })) throw new Error("LOCAL_METADATA_FAILED");
    hydrating = true;
    try { replaceLocalState(snapshot.data); } finally { hydrating = false; }
    return acceptSnapshot(snapshot, getLocalState(), changes, key, expectedGeneration);
  }

  async function connect({ ownerKey, repository }) {
    const ticket = ++generation;
    const current = { key: ownerKey, repository };
    binding = current;
    update({ phase: "checking", revision: null, remote: null, message: "正在確認雲端資料" });
    try {
      const localBeforeRead = await digest(getLocalState());
      const snapshot = await repository.load();
      if (ticket !== generation) return false;
      if (!snapshot) {
        update({ phase: "awaiting_import", remote: { tanks: 0, records: 0 }, message: "雲端尚未有紀錄，請確認本機數量後首次匯入" });
        return true;
      }
      checkSnapshot(snapshot);
      update({ remote: cloudDataSummary(snapshot.data), lastSyncedAt: snapshot.updated_at });
      const savedMetadata = loadMetadata();
      const metadata = savedMetadata?.ownerKey === ownerKey && Number.isInteger(savedMetadata?.revision) && /^[a-f0-9]{64}$/.test(savedMetadata?.digest || "") ? savedMetadata : null;
      const localDigest = await digest(getLocalState());
      if (ticket !== generation) return false;
      const localChangedWhileReading = localDigest !== localBeforeRead;
      if (localChangedWhileReading) {
        update({ phase: "conflict", message: "連線期間本機有新修改，已保留。請確認兩邊紀錄後再載入雲端。" });
        return false;
      }
      if (metadata && metadata.digest !== localDigest) {
        if (metadata.revision !== snapshot.revision) {
          update({ phase: "conflict", message: "本機有未同步修改，雲端也已更新。請先備份並確認紀錄。" });
          return false;
        }
        syncedChanges = changes - 1;
        update({ phase: "connected", revision: snapshot.revision, message: "正在恢復本機未完成的同步" });
        return true;
      }
      if (metadata || !getLocalState().tanks.length) return hydrate(snapshot, ownerKey, ticket);
      update({ phase: "awaiting_load", message: "此帳號已有雲端紀錄，請確認後載入；本機會先保存安全備份" });
      return true;
    } catch (error) { return ticket === generation ? fail(error) : false; }
  }

  function enqueue(action) {
    const current = binding;
    const ticket = generation;
    queue = queue.catch(() => {}).then(async () => {
      if (!current || ticket !== generation) return false;
      try { return await action(current, ticket); } catch (error) { return ticket === generation ? fail(error) : false; }
    });
    return queue;
  }

  return {
    getStatus,
    connect,
    markLocalChange() {
      if (hydrating) return;
      changes += 1;
      onChange(getStatus());
    },
    initialize(confirmImport = () => false) {
      return enqueue(async (current, ticket) => {
        if (status.phase !== "awaiting_import") return false;
        const data = structuredClone(getLocalState());
        if (!validState(data) || !data.tanks.length) {
          update({ message: "這台裝置沒有可匯入的魚缸，請使用原本保存紀錄的手機" });
          return false;
        }
        if (!await confirmImport(cloudDataSummary(data))) return false;
        if (ticket !== generation) return false;
        if (!saveBackup(data)) throw new Error("LOCAL_BACKUP_FAILED");
        const submittedChanges = changes;
        update({ phase: "syncing", message: "正在首次匯入" });
        const snapshot = await current.repository.initialize(data);
        if (ticket !== generation) return false;
        return acceptSnapshot(snapshot, data, submittedChanges, current.key, ticket);
      });
    },
    loadCloud(confirmLoad = () => false) {
      return enqueue(async (current, ticket) => {
        if (!await confirmLoad()) return false;
        const beforeRead = changes;
        update({ phase: "checking", message: "正在載入雲端紀錄" });
        const snapshot = await current.repository.load();
        if (ticket !== generation) return false;
        if (changes !== beforeRead) {
          update({ phase: "conflict", message: "載入期間本機有新修改，已保留。請重新確認後再載入雲端。" });
          return false;
        }
        return hydrate(snapshot, current.key, ticket);
      });
    },
    sync() {
      return enqueue(async (current, ticket) => {
        if (!getStatus().canPublish || !getStatus().pending) return false;
        const data = structuredClone(getLocalState());
        const submittedChanges = changes;
        update({ phase: "syncing", message: "正在同步最新紀錄" });
        const snapshot = await current.repository.save(data, status.revision);
        if (ticket !== generation) return false;
        return acceptSnapshot(snapshot, data, submittedChanges, current.key, ticket);
      });
    },
    refresh() {
      return binding ? connect({ ownerKey: binding.key, repository: binding.repository }) : Promise.resolve(false);
    },
    disconnect() {
      generation += 1;
      binding = null;
      update({ phase: "signed_out", remote: null, revision: null, lastSyncedAt: null, message: "已登出，暫停同步" });
    },
  };
}
