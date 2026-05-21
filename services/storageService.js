export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createId() {
  return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

export function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
