export function isValidBackupState(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tanks) || !value.tanks.length) return false;
  return value.tanks.every((tank) => tank
    && typeof tank === "object"
    && typeof tank.id === "string"
    && tank.tank
    && typeof tank.tank === "object"
    && Array.isArray(tank.records)
    && Array.isArray(tank.maintenance));
}

export function parseBackupText(text) {
  try {
    const state = JSON.parse(text);
    if (!isValidBackupState(state)) return { status: "INVALID_STRUCTURE" };
    return { status: "VALID", state };
  } catch {
    return { status: "INVALID_JSON" };
  }
}

export function restoreBackupText(text, { confirmRestore, replaceState }) {
  const parsed = parseBackupText(text);
  if (parsed.status !== "VALID") return parsed;
  if (!confirmRestore(parsed.state)) return { status: "CANCELLED", state: parsed.state };
  replaceState(parsed.state);
  return { status: "RESTORED", state: parsed.state };
}
