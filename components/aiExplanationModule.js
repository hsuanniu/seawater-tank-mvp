export function nutrientFocusText(row) {
  if (row.key === "no3" && row.status.text === "偏低") return "NO3 偏低時先觀察餵食、魚隻負載與過度過濾。";
  if (row.key === "no3" && row.status.text === "偏高") return "NO3 偏高時檢查餵食量、換水節奏與過濾狀態。";
  if (row.key === "po4" && row.status.text === "偏低") return "PO4 偏低時避免過度使用吸附劑或過度降營養鹽。";
  if (row.key === "po4" && row.status.text === "偏高") return "PO4 偏高時檢查餵食、換水與磷酸鹽吸附管理。";
  return `${row.label} 先觀察趨勢，下次測量後再微調。`;
}

export function nutrientNotes(analysis) {
  const notes = [];
  const no3 = analysis.rows.find((row) => row.key === "no3");
  const po4 = analysis.rows.find((row) => row.key === "po4");
  const kh = analysis.rows.find((row) => row.key === "kh");

  if (kh && kh.status.text !== "正常") notes.push(`觀察 KH 是否回到 ${kh.target.min}-${kh.target.max} dKH`);
  if (no3.status.text === "偏低") notes.push("觀察 NO3 是否仍然過低，避免過度降營養鹽");
  if (no3.status.text === "偏高") notes.push("檢查餵食量、換水節奏與過濾系統對 NO3 的影響");
  if (po4.status.text === "偏低") notes.push("觀察 PO4 是否過低，避免吸附劑或過度過濾造成波動");
  if (po4.status.text === "偏高") notes.push("檢查餵食、換水與磷酸鹽吸附管理");
  notes.push("下次測量後再依趨勢微調");
  return [...new Set(notes)];
}
