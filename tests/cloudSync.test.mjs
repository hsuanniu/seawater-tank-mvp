import assert from "node:assert/strict";
import test from "node:test";
import { deploymentCloudConfig, loadDeploymentCloudConfig } from "../services/cloudConfigService.js";
import { cloudDataSummary, createCloudSyncController, createSupabaseCloudRepository } from "../services/cloudSyncService.js";

function fixture(kh = 8.2) {
  return { version: 3, activeTankId: "tank-1", tanks: [{
    id: "tank-1", tank: { name: "海水缸", volume: 75 }, dosing: { kh: 11.7, status: {} },
    records: [{ id: "today", date: "2026-10-12", kh }],
    archivedRecords: [{ id: "old", date: "2025-01-01", kh: 8.5 }],
    maintenance: [], doseApplications: [], events: [], feedings: [], additives: [],
  }] };
}

class MemoryRepository {
  row = null;
  initializations = 0;
  saves = 0;
  offline = false;
  async load() {
    if (this.offline) throw new Error("offline");
    return structuredClone(this.row);
  }
  async initialize(data) {
    this.initializations += 1;
    if (this.row) throw new Error("CLOUD_ALREADY_INITIALIZED");
    this.row = { data: structuredClone(data), revision: 1, updated_at: "2026-10-12T08:00:00Z" };
    return structuredClone(this.row);
  }
  async save(data, revision) {
    if (this.offline) throw new Error("offline");
    if (this.row.revision !== revision) throw new Error("CLOUD_REVISION_CONFLICT");
    this.saves += 1;
    this.row = { data: structuredClone(data), revision: revision + 1, updated_at: "2026-10-12T09:00:00Z" };
    return structuredClone(this.row);
  }
}

function device(initial = fixture(), repository = new MemoryRepository(), metadata = new Map()) {
  let local = structuredClone(initial);
  const backups = [];
  const options = { failBackup: false, failMetadata: false, pendingDraft: false };
  const controller = createCloudSyncController({
    getLocalState: () => local,
    replaceLocalState: (data) => { if (options.pendingDraft) throw new Error("LOCAL_DRAFT_PENDING"); local = structuredClone(data); controller.markLocalChange(); },
    saveBackup: (data) => { if (options.failBackup) return false; backups.push(structuredClone(data)); return true; },
    loadMetadata: (key) => metadata.get(key),
    saveMetadata: (key, value) => { if (options.failMetadata) return false; metadata.set(key, value); return true; },
  });
  return {
    controller, repository, metadata, backups, options,
    get local() { return local; },
    connect: () => controller.connect({ ownerKey: "project::owner", repository }),
    edit(kh) { local.tanks[0].records[0].kh = kh; controller.markLocalChange(); },
  };
}

test("Cloud deployment config exposes only a public key and rejects server secrets", () => {
  assert.equal(deploymentCloudConfig({}).configured, false);
  const config = deploymentCloudConfig({ REEF_SUPABASE_URL: "https://project.supabase.co", REEF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key" });
  assert.equal(config.configured, true);
  for (const secret of ["sb_secret_admin", "arbitrary-server-password"]) {
    assert.throws(() => deploymentCloudConfig({ REEF_SUPABASE_URL: config.url, REEF_SUPABASE_PUBLISHABLE_KEY: secret }));
  }
  assert.throws(() => deploymentCloudConfig({ REEF_SUPABASE_URL: "http://localhost", REEF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key" }));
});

test("New devices use deployment config without storing URL or key manually", async () => {
  const config = await loadDeploymentCloudConfig({ fetchImpl: async (url, options) => {
    assert.equal(url, "cloud-config.json");
    assert.equal(options.cache, "no-store");
    return Response.json({ url: "https://project.supabase.co", publishableKey: "sb_publishable_test_key" });
  } });
  assert.equal(config.source, "deployment");
  assert.equal(config.url, "https://project.supabase.co");
  const legacy = await loadDeploymentCloudConfig({ fetchImpl: async () => { throw new Error("offline"); }, legacyConfig: { url: config.url, anonKey: config.publishableKey } });
  assert.equal(legacy.source, "legacy");
  await assert.rejects(() => loadDeploymentCloudConfig({ fetchImpl: async () => { throw new Error("offline"); } }));
});

test("First import requires confirmation, saves a backup and cannot run twice", async () => {
  const d = device();
  await d.connect();
  assert.equal(d.controller.getStatus().phase, "awaiting_import");
  assert.equal(await d.controller.initialize(() => false), false);
  assert.equal(d.repository.initializations, 0);
  assert.equal(await d.controller.initialize(() => true), true);
  assert.equal(d.backups.length, 1);
  assert.equal(d.controller.getStatus().phase, "connected");
  assert.equal(d.controller.getStatus().pending, false);
  assert.equal(await d.controller.initialize(() => true), false);
  assert.equal(d.repository.initializations, 1);
  assert.deepEqual(cloudDataSummary(d.repository.row.data), { tanks: 1, records: 2 });
});

test("An empty new device cannot initialize or erase the cloud", async () => {
  const d = device({ version: 3, tanks: [], activeTankId: null });
  await d.connect();
  assert.equal(await d.controller.initialize(() => true), false);
  assert.equal(d.repository.row, null);
  assert.equal(d.repository.initializations, 0);
});

test("A new device loads the existing cloud and does not re-import stale local data", async () => {
  const source = device();
  await source.connect();
  await source.controller.initialize(() => true);
  const empty = device({ version: 3, tanks: [] }, source.repository);
  await empty.connect();
  assert.deepEqual(empty.local, source.local);
  assert.equal(empty.controller.getStatus().pending, false);
  const stale = device(fixture(7.1), source.repository);
  await stale.connect();
  assert.equal(stale.controller.getStatus().phase, "awaiting_load");
  assert.equal(await stale.controller.initialize(() => true), false);
  assert.equal(stale.local.tanks[0].records[0].kh, 7.1);
  assert.equal(await stale.controller.loadCloud(() => false), false);
  await stale.controller.loadCloud(() => true);
  assert.equal(stale.backups[0].tanks[0].records[0].kh, 7.1);
  assert.equal(stale.local.tanks[0].records[0].kh, 8.2);
});

test("Offline modifications remain local and resume after reconnect without data loss", async () => {
  const d = device();
  await d.connect();
  await d.controller.initialize(() => true);
  d.repository.offline = true;
  d.edit(8.4);
  assert.equal(await d.controller.sync(), false);
  assert.equal(d.local.tanks[0].records[0].kh, 8.4);
  assert.equal(d.repository.row.data.tanks[0].records[0].kh, 8.2);
  d.repository.offline = false;
  const reopened = device(d.local, d.repository, d.metadata);
  await reopened.connect();
  assert.equal(reopened.controller.getStatus().pending, true);
  await reopened.controller.sync();
  assert.equal(d.repository.row.data.tanks[0].records[0].kh, 8.4);
});

test("Concurrent devices cannot overwrite a newer revision", async () => {
  const a = device();
  await a.connect();
  await a.controller.initialize(() => true);
  const b = device({ version: 3, tanks: [] }, a.repository);
  await b.connect();
  b.edit(8.5);
  await b.controller.sync();
  a.edit(8.3);
  assert.equal(await a.controller.sync(), false);
  assert.equal(a.controller.getStatus().phase, "conflict");
  assert.equal(a.local.tanks[0].records[0].kh, 8.3);
  assert.equal(a.repository.row.data.tanks[0].records[0].kh, 8.5);
  assert.equal(a.controller.getStatus().canPublish, false);
});

test("A clean returning device loads the latest cloud while divergent offline changes stay local", async () => {
  const first = device();
  await first.connect();
  await first.controller.initialize(() => true);
  const offlineMetadata = new Map(first.metadata);
  const second = device({ version: 3, tanks: [] }, first.repository);
  await second.connect();
  second.edit(8.6);
  await second.controller.sync();
  const cleanReturn = device(first.local, first.repository, first.metadata);
  await cleanReturn.connect();
  assert.equal(cleanReturn.local.tanks[0].records[0].kh, 8.6);
  first.edit(8.4);
  const dirtyReturn = device(first.local, first.repository, offlineMetadata);
  await dirtyReturn.connect();
  assert.equal(dirtyReturn.controller.getStatus().phase, "conflict");
  assert.equal(dirtyReturn.local.tanks[0].records[0].kh, 8.4);
  assert.equal(first.repository.row.data.tanks[0].records[0].kh, 8.6);
});

test("Local edits made during a confirmed cloud load are not overwritten", async () => {
  const source = device();
  await source.connect();
  await source.controller.initialize(() => true);
  const other = device(fixture(7.9), source.repository);
  await other.connect();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  source.repository.load = () => held;
  const loading = other.controller.loadCloud(() => true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  other.edit(8.4);
  release(structuredClone(source.repository.row));
  assert.equal(await loading, false);
  assert.equal(other.controller.getStatus().phase, "conflict");
  assert.equal(other.local.tanks[0].records[0].kh, 8.4);
});

test("A raced first import never replaces the cloud initialized by another device", async () => {
  const d = device();
  await d.connect();
  await d.repository.initialize(fixture(8.6));
  assert.equal(await d.controller.initialize(() => true), false);
  assert.equal(d.controller.getStatus().phase, "conflict");
  assert.equal(d.repository.row.data.tanks[0].records[0].kh, 8.6);
});

test("Backup and metadata failures stop hydration or publishing", async () => {
  const source = device();
  await source.connect();
  await source.controller.initialize(() => true);
  const stale = device(fixture(7.4), source.repository);
  await stale.connect();
  stale.options.failBackup = true;
  assert.equal(await stale.controller.loadCloud(() => true), false);
  assert.equal(stale.local.tanks[0].records[0].kh, 7.4);
  source.edit(8.4);
  source.options.failMetadata = true;
  assert.equal(await source.controller.sync(), false);
  assert.equal(source.controller.getStatus().canPublish, false);
  assert.match(source.controller.getStatus().message, /暫停自動同步/);
});

test("Malformed remote snapshots do not replace the local TankStore", async () => {
  const d = device();
  d.repository.row = { data: { tanks: "invalid" }, revision: 1 };
  await d.connect();
  assert.equal(d.controller.getStatus().phase, "error");
  assert.equal(d.local.tanks[0].records[0].kh, 8.2);
  assert.equal(d.backups.length, 0);
});

test("An unfinished measurement draft blocks cloud hydration without changing local records", async () => {
  const source = device();
  await source.connect();
  await source.controller.initialize(() => true);
  const other = device(fixture(7.9), source.repository);
  await other.connect();
  other.options.pendingDraft = true;
  assert.equal(await other.controller.loadCloud(() => true), false);
  assert.equal(other.local.tanks[0].records[0].kh, 7.9);
  assert.equal(other.controller.getStatus().canPublish, false);
  assert.match(other.controller.getStatus().message, /尚未儲存的測量輸入/);
});

test("Edits during an upload are still pending and get sent in the next save", async () => {
  const d = device();
  await d.connect();
  await d.controller.initialize(() => true);
  d.edit(8.4);
  const save = d.repository.save.bind(d.repository);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  d.repository.save = async (...args) => { await held; return save(...args); };
  const upload = d.controller.sync();
  await new Promise((resolve) => setTimeout(resolve, 0));
  d.edit(8.6);
  release();
  await upload;
  assert.equal(d.controller.getStatus().pending, true);
  await d.controller.sync();
  assert.equal(d.repository.row.data.tanks[0].records[0].kh, 8.6);
  assert.equal(d.controller.getStatus().pending, false);
});

test("Logout ignores an in-flight cloud result and preserves local data", async () => {
  const d = device();
  let release;
  const read = new Promise((resolve) => { release = resolve; });
  d.repository.load = () => read;
  const connected = d.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  d.controller.disconnect();
  release({ data: fixture(9), revision: 1 });
  await connected;
  assert.equal(d.controller.getStatus().phase, "signed_out");
  assert.equal(d.local.tanks[0].records[0].kh, 8.2);
});

test("Supabase writes use atomic RPC with expected revision and reads stay owner-scoped", async () => {
  const calls = [];
  const repository = createSupabaseCloudRepository({
    from: (table) => {
      assert.equal(table, "user_app_state");
      return { select: () => ({ eq: (column, owner) => {
        assert.equal(column, "user_id"); assert.equal(owner, "owner");
        return { maybeSingle: async () => ({ data: null, error: null }) };
      } }) };
    },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: { revision: 2 }, error: null }; },
  }, "owner");
  assert.equal(await repository.load(), null);
  await repository.initialize(fixture());
  await repository.save(fixture(), 1);
  assert.equal(calls[0].name, "reef_initialize_app_state");
  assert.equal(calls[1].name, "reef_save_app_state");
  assert.equal(calls[1].args.p_expected_revision, 1);
  assert.equal(calls[1].args.user_id, undefined);
});
