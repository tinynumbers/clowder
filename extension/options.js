import { DEFAULT_SETTINGS, parseRules } from "./grouping.js";

const fields = Object.keys(DEFAULT_SETTINGS);
const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

for (const key of fields) {
  const el = document.getElementById(key);
  if (el.type === "checkbox") el.checked = settings[key];
  else el.value = settings[key];
}

document.getElementById("save").addEventListener("click", async () => {
  const next = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    next[key] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) || 2 : el.value;
  }
  await chrome.storage.sync.set(next);
  const n = parseRules(next.rules).length;
  document.getElementById("saved").textContent = `Saved (${n} rule${n === 1 ? "" : "s"}).`;
});
