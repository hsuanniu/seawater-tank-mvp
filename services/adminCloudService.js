const SESSION_KEY = "seawaterTankAdminSession.v1";

export function createAdminCloudClient({ apiUrl, fetchImpl = fetch, storage = localStorage, now = () => Date.now(), onUnauthorized = () => {} }) {
  let session = null;
  try {
    const saved = JSON.parse(storage.getItem(SESSION_KEY));
    if (saved?.apiUrl === apiUrl && /^[a-f0-9]{64}$/.test(saved.token) && Date.parse(saved.expiresAt) > now()) session = saved;
  } catch { /* Unavailable browser storage must not erase local tank data. */ }

  function clearSession() {
    session = null;
    try { storage.removeItem(SESSION_KEY); } catch { /* In-memory logout still stops syncing. */ }
  }

  async function request(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method, cache: "no-store", credentials: "omit", redirect: "error",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("CLOUD_UNAVAILABLE"); }
    if (!response.ok) {
      if (response.status === 401 && session) { clearSession(); onUnauthorized(); }
      throw new Error(result?.error || "CLOUD_UNAVAILABLE");
    }
    return result;
  }

  return {
    async getSession() {
      const status = await request("/api/internal/session");
      if (!status.authenticated) clearSession();
      return { ...status, session: status.authenticated ? { libraryId: status.libraryId } : null };
    },
    async signIn(password) {
      const result = await request("/api/internal/session", { method: "POST", body: { password } });
      if (!/^[a-f0-9]{64}$/.test(result.token) || !result.libraryId || !(Date.parse(result.expiresAt) > now())) throw new Error("INVALID_SESSION");
      session = { apiUrl, token: result.token, expiresAt: result.expiresAt };
      // Only a revocable, expiring session is kept. Never persist the admin password.
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Current session remains usable until the app closes. */ }
      return { libraryId: result.libraryId };
    },
    async signOut() {
      try { if (session) await request("/api/internal/session", { method: "DELETE" }); }
      finally { clearSession(); }
    },
    repository: {
      load: () => request("/api/internal/state"),
      initialize: (data) => request("/api/internal/initialize", { method: "POST", body: { data } }),
      save: (data, revision) => request("/api/internal/state", { method: "PUT", body: { data, expectedRevision: revision } }),
    },
    inventory: {
      list: (tankId) => request(`/api/internal/reservoirs/${encodeURIComponent(tankId)}`),
      operate: (tankId, operation) => request(`/api/internal/reservoirs/${encodeURIComponent(tankId)}/operations`, { method: "POST", body: operation }),
      history: (tankId, reservoirId, cursor) => request(`/api/internal/reservoirs/${encodeURIComponent(tankId)}/${encodeURIComponent(reservoirId)}/history${cursor ? `/${encodeURIComponent(cursor)}` : ""}`),
    },
  };
}
