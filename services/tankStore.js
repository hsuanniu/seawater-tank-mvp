import { DEFAULT_DOSING, mergeDosing } from "../modules/dosingModule.js";
import { DEFAULT_TANK } from "../modules/tankModule.js";
import { clone, createId, loadJson, saveJson } from "./storageService.js";

export function createTankStore({ storageKey, onChange = () => {}, onDosingDebug = null, onPersist = () => {}, onPersistError = () => {} }) {
  let state = loadState(storageKey);

  function loadState(key) {
    const stored = loadJson(key);
    if (stored) return mergeState(stored);
    return createInitialState();
  }

  function mergeState(stored) {
    if (Array.isArray(stored.tanks)) {
      const tanks = stored.tanks.length ? stored.tanks.map((tank) => mergeTankData(tank)) : [createTankData()];
      const activeTankId = tanks.some((tank) => tank.id === stored.activeTankId) ? stored.activeTankId : tanks[0].id;
      return { version: 3, activeTankId, tanks };
    }

    const legacyTank = mergeTankData({
      id: stored.activeTankId || createId(),
      tank: stored.tank,
      dosing: stored.dosing,
      records: stored.records,
      maintenance: stored.maintenance,
    });
    return { version: 3, activeTankId: legacyTank.id, tanks: [legacyTank] };
  }

  function createInitialState() {
    const firstTank = createTankData();
    return { version: 3, activeTankId: firstTank.id, tanks: [firstTank] };
  }

  function createTankData(overrides = {}) {
    return mergeTankData({
      id: overrides.id || createId(),
      tank: overrides.tank || { name: overrides.name || DEFAULT_TANK.name },
      dosing: overrides.dosing,
      records: overrides.records,
      maintenance: overrides.maintenance,
      doseApplications: overrides.doseApplications,
      livestock: overrides.livestock,
      additives: overrides.additives,
      additiveSchedules: overrides.additiveSchedules,
      feedings: overrides.feedings,
      events: overrides.events,
      uiState: overrides.uiState,
    });
  }

  function mergeTankData(stored = {}) {
    return {
      id: stored.id || createId(),
      tank: {
        ...clone(DEFAULT_TANK),
        ...(stored.tank || {}),
        targets: {
          ...clone(DEFAULT_TANK.targets),
          ...((stored.tank && stored.tank.targets) || {}),
        },
        targetInputs: {
          ...clone(DEFAULT_TANK.targetInputs),
          ...((stored.tank && stored.tank.targetInputs) || {}),
        },
      },
      dosing: {
        ...clone(DEFAULT_DOSING),
        ...(stored.dosing || {}),
        status: {
          ...clone(DEFAULT_DOSING.status),
          ...((stored.dosing && stored.dosing.status) || {}),
        },
      },
      records: Array.isArray(stored.records) ? stored.records : [],
      maintenance: Array.isArray(stored.maintenance) ? stored.maintenance : [],
      doseApplications: Array.isArray(stored.doseApplications) ? stored.doseApplications : [],
      livestock: Array.isArray(stored.livestock) ? stored.livestock : [],
      additives: Array.isArray(stored.additives) ? stored.additives : [],
      additiveSchedules: Array.isArray(stored.additiveSchedules) ? stored.additiveSchedules : [],
      feedings: Array.isArray(stored.feedings) ? stored.feedings : [],
      events: Array.isArray(stored.events) ? stored.events : [],
      uiState: stored.uiState && typeof stored.uiState === "object" ? stored.uiState : {},
    };
  }

  function serializeState() {
    return {
      version: 3,
      activeTankId: state.activeTankId,
      tanks: state.tanks.map((tank) => ({
        id: tank.id,
        tank: tank.tank,
        dosing: tank.dosing,
        records: tank.records,
        maintenance: tank.maintenance,
        doseApplications: tank.doseApplications || [],
        livestock: tank.livestock || [],
        additives: tank.additives || [],
        additiveSchedules: tank.additiveSchedules || [],
        feedings: tank.feedings || [],
        events: tank.events || [],
        uiState: tank.uiState || {},
      })),
    };
  }

  function getActiveTank() {
    const active = state.tanks.find((tank) => tank.id === state.activeTankId) || state.tanks[0];
    state.activeTankId = active.id;
    return active;
  }

  function persist() {
    if (!saveJson(storageKey, serializeState())) {
      onPersistError();
      return false;
    }
    onPersist();
    return true;
  }

  function notify(options = {}) {
    onChange(options);
  }

  return {
    getState: () => state,
    serializeState,
    mergeState,
    createTankData,
    getActiveTank,
    getTank: () => getActiveTank().tank,
    getTargets: () => getActiveTank().tank.targets,
    getDosing: () => getActiveTank().dosing,
    getMeasurements: () => getActiveTank().records,
    getMaintenance: () => getActiveTank().maintenance,
    getDoseApplications: () => getActiveTank().doseApplications,
    getLivestock: () => getActiveTank().livestock,
    getEvents: () => getActiveTank().events,
    getAdditives: () => getActiveTank().additives,
    getAdditiveSchedules: () => getActiveTank().additiveSchedules,
    getFeedings: () => getActiveTank().feedings,
    getUiState: () => getActiveTank().uiState,
    persist,
    notify,
    setActiveTank(tankId) {
      if (!state.tanks.some((tank) => tank.id === tankId)) return;
      state.activeTankId = tankId;
      persist();
      notify({ forms: true });
    },
    addTank(name) {
      const newTank = createTankData({ name });
      state.tanks.push(newTank);
      state.activeTankId = newTank.id;
      persist();
      notify({ forms: true });
      return newTank;
    },
    deleteTank(tankId) {
      if (state.tanks.length <= 1) return { deleted: false, reason: "LAST_TANK" };
      const deletedTank = state.tanks.find((tank) => tank.id === tankId);
      if (!deletedTank) return { deleted: false, reason: "NOT_FOUND" };
      state.tanks = state.tanks.filter((tank) => tank.id !== tankId);
      if (state.activeTankId === tankId) state.activeTankId = state.tanks[0].id;
      persist();
      notify({ forms: true, cloud: true });
      return { deleted: true, deletedTank, activeTank: getActiveTank() };
    },
    updateTankSettings({ name, volume, targets, targetInputs }) {
      const tank = getActiveTank().tank;
      tank.name = name || DEFAULT_TANK.name;
      tank.volume = volume;
      tank.targets = { ...tank.targets, ...targets };
      tank.targetInputs = { ...tank.targetInputs, ...targetInputs };
      persist();
      notify({ forms: true });
    },
    addMeasurement(record) {
      getActiveTank().records.push({ id: createId(), createdAt: new Date().toISOString(), ...record });
      persist();
      notify({ forms: true });
    },
    upsertMeasurementByDate(record) {
      const tankData = getActiveTank();
      const now = new Date().toISOString();
      const sameDateRecords = tankData.records
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.date === record.date)
        .sort((a, b) => {
          const createdA = a.item.createdAt ? new Date(a.item.createdAt).getTime() : 0;
          const createdB = b.item.createdAt ? new Date(b.item.createdAt).getTime() : 0;
          if (createdA !== createdB) return createdA - createdB;
          return a.index - b.index;
        });

      if (sameDateRecords.length) {
        const existing = sameDateRecords[sameDateRecords.length - 1].item;
        tankData.records = tankData.records.filter((item) => item.date !== record.date);
        tankData.records.push({
          ...existing,
          ...record,
          id: existing.id,
          createdAt: existing.createdAt || now,
          updatedAt: now,
        });
        persist();
        notify({ forms: true });
        return { mode: "updated", record: tankData.records[tankData.records.length - 1] };
      }

      const createdRecord = { id: createId(), createdAt: now, ...record };
      tankData.records.push(createdRecord);
      persist();
      notify({ forms: true });
      return { mode: "created", record: createdRecord };
    },
    updateMeasurement(recordId, patch) {
      const records = getActiveTank().records;
      const index = records.findIndex((record) => record.id === recordId);
      if (index === -1) return false;
      records[index] = { ...records[index], ...patch };
      persist();
      notify({ forms: true });
      return true;
    },
    updateDosing(nextDosing, { source = "updateDosing", debug = false, forms = false, statusPrefix = "" } = {}) {
      const tankData = getActiveTank();
      const previous = clone(tankData.dosing);
      tankData.dosing = mergeDosing(tankData.dosing, nextDosing);
      persist();
      notify({ forms, statusPrefix, partial: true });
      if (debug && onDosingDebug) onDosingDebug({ source, input: nextDosing, previous, updated: tankData.dosing });
    },
    addMaintenance(entry) {
      getActiveTank().maintenance.push({ id: createId(), ...entry });
      persist();
      notify({ forms: true });
    },
    addDoseApplication(entry) {
      const created = { id: createId(), ...entry };
      getActiveTank().doseApplications.push(created);
      persist();
      notify({ forms: true });
      return created;
    },
    addFish(entry) {
      getActiveTank().livestock.push({ id: createId(), removed: false, ...entry });
      persist();
      notify({ forms: true });
    },
    updateFish(fishId, patch) {
      const livestock = getActiveTank().livestock;
      const index = livestock.findIndex((fish) => fish.id === fishId);
      if (index === -1) return false;
      livestock[index] = { ...livestock[index], ...patch };
      persist();
      notify({ forms: true });
      return true;
    },
    deleteFish(fishId) {
      const tankData = getActiveTank();
      const initialLength = tankData.livestock.length;
      tankData.livestock = tankData.livestock.filter((fish) => fish.id !== fishId);
      if (tankData.livestock.length === initialLength) return false;
      persist();
      notify({ forms: true });
      return true;
    },
    addFeeding(entry) {
      getActiveTank().feedings.push({ id: createId(), ...entry });
      persist();
      notify({ forms: true });
    },
    deleteFeeding(feedingId) {
      const tankData = getActiveTank();
      const initialLength = tankData.feedings.length;
      tankData.feedings = tankData.feedings.filter((feeding) => feeding.id !== feedingId);
      if (tankData.feedings.length === initialLength) return false;
      persist();
      notify({ forms: true });
      return true;
    },
    addAdditive(entry) {
      getActiveTank().additives.push({ id: createId(), ...entry });
      persist();
      notify({ forms: true });
    },
    deleteAdditive(additiveId) {
      const tankData = getActiveTank();
      const initialLength = tankData.additives.length;
      tankData.additives = tankData.additives.filter((additive) => additive.id !== additiveId);
      if (tankData.additives.length === initialLength) return false;
      persist();
      notify({ forms: true });
      return true;
    },
    addAdditiveSchedule(entry) {
      getActiveTank().additiveSchedules.push({ id: createId(), enabled: true, ...entry });
      persist();
      notify({ forms: true });
    },
    updateAdditiveSchedule(scheduleId, patch) {
      const schedules = getActiveTank().additiveSchedules;
      const index = schedules.findIndex((schedule) => schedule.id === scheduleId);
      if (index === -1) return false;
      schedules[index] = { ...schedules[index], ...patch };
      persist();
      notify({ forms: true });
      return true;
    },
    deleteAdditiveSchedule(scheduleId) {
      const tankData = getActiveTank();
      const initialLength = tankData.additiveSchedules.length;
      tankData.additiveSchedules = tankData.additiveSchedules.filter((schedule) => schedule.id !== scheduleId);
      if (tankData.additiveSchedules.length === initialLength) return false;
      persist();
      notify({ forms: true });
      return true;
    },
    addEvent(entry) {
      getActiveTank().events.push({ id: createId(), createdAt: new Date().toISOString(), ...entry });
      persist();
      notify({ forms: false });
    },
    updateTargets(targets, targetInputs) {
      const tank = getActiveTank().tank;
      tank.targets = { ...tank.targets, ...targets };
      tank.targetInputs = { ...tank.targetInputs, ...targetInputs };
      persist();
      notify({ forms: true });
    },
    replaceState(nextState) {
      state = mergeState(nextState);
      persist();
      notify({ forms: true, cloud: true });
    },
    clear() {
      state = createInitialState();
      persist();
      notify({ forms: true, cloud: true });
    },
  };
}
