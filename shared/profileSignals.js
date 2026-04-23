export function cleanProfileSignalLabel(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9+#/(). -]+$/gi, "");
}

export function profileSignalKey(value) {
  return cleanProfileSignalLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9+#/(). -]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

export function mergeUniqueSignalLabels(values = [], limit = Infinity) {
  const seen = new Set();
  const merged = [];
  for (const raw of Array.isArray(values) ? values : [values]) {
    const label = cleanProfileSignalLabel(raw);
    const key = profileSignalKey(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(label);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function hasNormalizedSignal(collection = [], value) {
  const target = profileSignalKey(value);
  if (!target) return false;
  return (Array.isArray(collection) ? collection : []).some(item => {
    const label = typeof item === "string" ? item : item?.label || item?.signal_label || item?.key || "";
    const key = typeof item === "object" && item?.key ? item.key : profileSignalKey(label);
    return key === target;
  });
}
