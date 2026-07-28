import { readFile, writeFile } from "node:fs/promises";

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const buildDate = new Date();
const version = packageJson.version || "0.0.0";
const metadata = {
  app_name: packageJson.displayName || packageJson.productName || packageJson.name || "App",
  package_name: packageJson.name || "",
  version,
  current_version: version,
  build_date: formatDate(buildDate),
  build_time: buildDate.toISOString(),
};

await writeFile(
  new URL("../version.json", import.meta.url),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
