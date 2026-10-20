import { DEFAULT_SETTINGS, formatRule, parseRules, ruleKey } from "./grouping.js";

const fields = Object.keys(DEFAULT_SETTINGS);
const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
const rulesBox = document.getElementById("rules");

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

// ---- Rule suggestions from Claude ----

async function removeSuggestion(pattern) {
  const { ruleSuggestions = [] } = await chrome.storage.local.get("ruleSuggestions");
  await chrome.storage.local.set({
    ruleSuggestions: ruleSuggestions.filter((s) => ruleKey(s.pattern) !== ruleKey(pattern)),
  });
}

// Appends to the rules box (keeping any unsaved edits there) and saves the rules.
async function addSuggestion(suggestion) {
  const text = rulesBox.value.replace(/\s*$/, "");
  rulesBox.value = (text ? text + "\n" : "") + formatRule(suggestion) + "\n";
  await chrome.storage.sync.set({ rules: rulesBox.value });
  await removeSuggestion(suggestion.pattern);
  document.getElementById("saved").textContent = `Added rule for ${suggestion.pattern}.`;
}

async function dismissSuggestion(suggestion) {
  const { dismissedRules = [] } = await chrome.storage.local.get("dismissedRules");
  await chrome.storage.local.set({ dismissedRules: [...dismissedRules, ruleKey(suggestion.pattern)] });
  await removeSuggestion(suggestion.pattern);
}

function button(text, onClick) {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

// Built with textContent, never innerHTML: suggestions come from Claude, which
// read titles from arbitrary web pages.
async function renderSuggestions() {
  const { ruleSuggestions = [] } = await chrome.storage.local.get("ruleSuggestions");
  const list = document.getElementById("suggestionList");
  list.replaceChildren(
    ...ruleSuggestions.map((s) => {
      const row = document.createElement("div");
      row.className = "suggestion";
      const code = document.createElement("code");
      code.textContent = formatRule(s);
      row.append(code, button("Add", () => addSuggestion(s)), button("Dismiss", () => dismissSuggestion(s)));
      return row;
    }),
  );
  document.getElementById("suggestions").hidden = !ruleSuggestions.length;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ruleSuggestions) renderSuggestions();
});
renderSuggestions();
