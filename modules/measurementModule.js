export function getSortedRecords(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const dateDiff = new Date(a.record.date) - new Date(b.record.date);
      if (dateDiff !== 0) return dateDiff;
      const createdA = a.record.createdAt ? new Date(a.record.createdAt).getTime() : 0;
      const createdB = b.record.createdAt ? new Date(b.record.createdAt).getTime() : 0;
      if (createdA !== createdB) return createdA - createdB;
      return a.index - b.index;
    })
    .map((item) => item.record);
}

export function latestRecords(records) {
  const sortedRecords = getSortedRecords(records);
  return {
    latest: sortedRecords[sortedRecords.length - 1] || null,
    previous: sortedRecords[sortedRecords.length - 2] || null,
  };
}

export function daysBetweenRecords(latest, previous) {
  if (!latest || !previous) return null;
  return Math.max(1, Math.round((new Date(latest.date) - new Date(previous.date)) / 86400000));
}

const MEASURED_PARAMETERS = ["kh", "ca", "mg", "k", "no3", "po4"];

function isBlank(value) {
  return String(value ?? "").trim() === "";
}

export function buildMeasurementRecord(data, records, { fallbackDate = "", labels = {} } = {}) {
  const inputDate = data.date || fallbackDate;
  const previous = getSortedRecords(records)
    .filter((record) => record.date && record.date <= inputDate)
    .slice(-1)[0] || null;
  const measuredFields = {};
  const record = { measuredFields };

  for (const key of MEASURED_PARAMETERS) {
    if (isBlank(data[key])) {
      if (!previous || !Number.isFinite(Number(previous[key]))) {
        return { error: "找不到這個日期可沿用的上一筆水質資料，請補上本次測量值。" };
      }
      record[key] = Number(previous[key]);
      measuredFields[key] = false;
    } else {
      record[key] = Number(data[key]);
      measuredFields[key] = true;
    }
  }

  return {
    record: {
      ...record,
      date: inputDate,
      salinity: isBlank(data.salinity) ? "" : Number(data.salinity),
      temperature: isBlank(data.temperature) ? "" : Number(data.temperature),
      note: String(data.note || "").trim(),
    },
    carriedFields: Object.entries(measuredFields)
      .filter(([, measured]) => !measured)
      .map(([key]) => labels[key] || key),
  };
}
