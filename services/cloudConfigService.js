function isPublicKey(key) {
  if (key.startsWith("sb_publishable_")) return key.length > 15;
  if (key.startsWith("sb_secret_")) return false;
  try {
    const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)).role === "anon";
  } catch {
    return false;
  }
}

export function normalizeCloudConfig(config) {
  const url = String(config?.url || "").trim().replace(/\/$/, "");
  const publishableKey = String(config?.publishableKey || config?.anonKey || "").trim();
  if (!url && !publishableKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") return null;
    if (!isPublicKey(publishableKey)) return null;
    return { url, publishableKey };
  } catch {
    return null;
  }
}

export function deploymentCloudConfig(env) {
  const url = env.REEF_SUPABASE_URL || "";
  const publishableKey = env.REEF_SUPABASE_PUBLISHABLE_KEY || "";
  if (!url && !publishableKey) return { configured: false, url: "", publishableKey: "" };
  const config = normalizeCloudConfig({ url, publishableKey });
  if (!config) throw new Error("Cloud deployment requires an HTTPS project URL and a publishable/anon key. Secret keys must not be published.");
  return { configured: true, ...config };
}

export async function loadDeploymentCloudConfig({ fetchImpl = fetch, legacyConfig = null } = {}) {
  try {
    const response = await fetchImpl("cloud-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("CONFIG_UNAVAILABLE");
    const config = normalizeCloudConfig(await response.json());
    if (config) return { ...config, source: "deployment" };
  } catch {
    // Existing devices may keep using their previous public connection settings.
    const fallback = normalizeCloudConfig(legacyConfig);
    if (fallback) return { ...fallback, source: "legacy" };
    throw new Error("CLOUD_CONFIG_UNAVAILABLE");
  }
  const legacy = normalizeCloudConfig(legacyConfig);
  return legacy ? { ...legacy, source: "legacy" } : null;
}
