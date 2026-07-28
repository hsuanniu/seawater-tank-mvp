import { escapeHtml } from "../services/formatService.js";

function fallbackAppName() {
  return document.title || "App";
}

function formatBuildDate(metadata) {
  if (metadata?.build_date) return metadata.build_date;
  if (!metadata?.build_time) return "";
  const date = new Date(metadata.build_time);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function footerHtml(metadata = {}) {
  const appName = metadata.app_name || metadata.displayName || metadata.productName || metadata.name || fallbackAppName();
  const version = metadata.version || metadata.current_version || "0.0.0";
  const buildDate = formatBuildDate(metadata);
  return `
    <div>${escapeHtml(appName)} v${escapeHtml(version)}</div>
    <div>${buildDate ? `最後更新 ${escapeHtml(buildDate)}` : "最後更新 -"}</div>
  `;
}

export function createAppVersionFooter({
  root,
  metadataUrl = "version.json",
  fallback = {},
} = {}) {
  if (!root) return { render: () => {}, refresh: async () => {} };

  function render(metadata) {
    root.innerHTML = footerHtml(metadata);
  }

  async function refresh() {
    render(fallback);
    try {
      const response = await fetch(`${metadataUrl}?ts=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) throw new Error("version unavailable");
      render(await response.json());
    } catch {
      render(fallback);
    }
  }

  return { render, refresh };
}
