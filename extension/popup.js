import { DEFAULT_SETTINGS } from "./grouping.js";

const status = document.getElementById("status");
const buttons = [...document.querySelectorAll("button")];

for (const button of buttons) {
  button.addEventListener("click", async () => {
    buttons.forEach((b) => (b.disabled = true));
    status.className = "";
    status.textContent = button.id === "organizeWithClaude" ? "Asking Claude…" : "Working…";
    const win = await chrome.windows.getCurrent();
    const reply = await chrome.runtime.sendMessage({ cmd: button.id, windowId: win.id });
    status.className = reply?.ok ? "" : "error";
    status.textContent = reply?.message || "No response.";
    buttons.forEach((b) => (b.disabled = false));
  });
}

async function showSuggestionCount() {
  const { ruleSuggestions = [] } = await chrome.storage.local.get("ruleSuggestions");
  const n = ruleSuggestions.length;
  document.getElementById("settingsLink").textContent =
    "Rules and settings" + (n ? ` (${n} suggested rule${n === 1 ? "" : "s"})` : "");
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ruleSuggestions) showSuggestionCount();
});
showSuggestionCount();

const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
for (const key of ["autoGroup", "useClaudeForUnmatched"]) {
  const box = document.getElementById(key);
  box.checked = settings[key];
  box.addEventListener("change", () => chrome.storage.sync.set({ [key]: box.checked }));
}
