import { dosingChanges, reservoirDose, sameReservoirDose } from "../modules/reservoirModule.js";
import { isReefTank } from "../modules/reservoirHistoryModule.js";

export function preserveDosingHistory(previous, next, { at, createId }) {
  const result = structuredClone(next);
  for (const tank of result.tanks) {
    const old = previous.tanks.find((entry) => entry.id === tank.id);
    if (!old || !isReefTank(tank)) continue;
    const history = [...(old.dosingHistory || [])];
    const known = new Set(history.map((e) => e.id));
    const incoming = (tank.dosingHistory || []).filter((e) => e && typeof e.id === "string" && !known.has(e.id));
    for (const entry of incoming) { if (!known.has(entry.id)) { history.push(entry); known.add(entry.id); } }
    for (const change of dosingChanges(old.dosing, tank.dosing, { at, createId, source: "server_observed_change" })) {
      const chain = incoming.filter((e) => e.key === change.key);
      let setting = reservoirDose(old.dosing, change.key);
      let continuous = chain.length > 0;
      for (const event of chain) {
        if (!sameReservoirDose(setting, event.before) || !Number.isFinite(Date.parse(event.effectiveAt))
          || Date.parse(event.effectiveAt) > Date.parse(at)) continuous = false;
        setting = event.after;
      }
      if (!continuous || !sameReservoirDose(setting, change.after)) history.push({ ...change, timingUncertain: true });
    }
    if (history.length || old.dosingHistory !== undefined || tank.dosingHistory !== undefined) tank.dosingHistory = history;
  }
  return result;
}
