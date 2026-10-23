import { DEFAULT_SETTINGS } from "./grouping.js";

const status = document.getElementById("status");
const buttons = [...document.querySelectorAll("button")];
const instruction = document.getElementById("instruction");
const ASKS_CLAUDE = new Set(["organizeWithClaude", "groupWithInstruction"]);

async function send(cmd, extra = {}) {
  buttons.forEach((b) => (b.disabled = true));
  status.className = "";
  status.textContent = ASKS_CLAUDE.has(cmd) ? "Asking Claude…" : "Working…";
  const win = await chrome.windows.getCurrent();
  const reply = await chrome.runtime.sendMessage({ cmd, windowId: win.id, ...extra });
  status.className = reply?.ok ? "" : "error";
  status.textContent = reply?.message || "No response.";
  buttons.forEach((b) => (b.disabled = false));
  return reply;
}

for (const button of buttons) {
  if (button.type !== "submit") button.addEventListener("click", () => send(button.id));
}

document.getElementById("instructForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!instruction.value.trim()) return instruction.focus();
  const reply = await send("groupWithInstruction", { instruction: instruction.value });
  if (reply?.ok) instruction.value = "";
});

// Your recent instructions show up as suggestions in the box.
async function showRecentInstructions() {
  const { recentInstructions = [] } = await chrome.storage.local.get("recentInstructions");
  document.getElementById("recentInstructions").replaceChildren(
    ...recentInstructions.map((text) => Object.assign(document.createElement("option"), { value: text })),
  );
}

async function showSuggestionCount() {
  const { ruleSuggestions = [] } = await chrome.storage.local.get("ruleSuggestions");
  const n = ruleSuggestions.length;
  document.getElementById("settingsLink").textContent =
    "Rules and settings" + (n ? ` (${n} suggested rule${n === 1 ? "" : "s"})` : "");
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ruleSuggestions) showSuggestionCount();
  if (changes.recentInstructions) showRecentInstructions();
});
showSuggestionCount();
showRecentInstructions();

const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
for (const key of ["autoGroup", "useClaudeForUnmatched"]) {
  const box = document.getElementById(key);
  box.checked = settings[key];
  box.addEventListener("change", () => chrome.storage.sync.set({ [key]: box.checked }));
}
