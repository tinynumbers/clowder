import {
  COLORS,
  DEFAULT_SETTINGS,
  colorFor,
  describeTab,
  findDuplicatesToClose,
  groupForSite,
  labelForSite,
  matchRule,
  parseRules,
  planRuleAndDomainGroups,
  siteOf,
} from "./grouping.js";

const HOST = "com.clowder_tabs.host";
const AUTO_DELAY_MS = 1500;
const CLAUDE_AUTO_DELAY_MS = 8000;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

async function groupableTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId, pinned: false });
  return tabs.filter((t) => t.url && !t.url.startsWith("chrome-extension://"));
}

// Puts each planned group's tabs into the window's existing group of the same
// name, or a new group. Tabs that closed or moved windows meanwhile are skipped.
async function applyGroups(windowId, groups) {
  const live = new Set((await groupableTabs(windowId)).map((t) => t.id));
  const existing = await chrome.tabGroups.query({ windowId });
  let applied = 0;
  for (const group of groups) {
    const tabIds = [...new Set(group.tabIds)].filter((id) => live.has(id));
    if (!tabIds.length) continue;
    const name = group.name.slice(0, 40);
    const color = COLORS.includes(group.color) ? group.color : colorFor(name);
    const match = existing.find((g) => (g.title || "").toLowerCase() === name.toLowerCase());
    if (match) {
      await chrome.tabs.group({ groupId: match.id, tabIds });
    } else {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: name, color });
      existing.push({ id: groupId, title: name });
    }
    tabIds.forEach((id) => live.delete(id));
    applied++;
  }
  return applied;
}

async function groupByRules(windowId) {
  const settings = await getSettings();
  const tabs = await groupableTabs(windowId);
  const { groups } = planRuleAndDomainGroups(tabs, parseRules(settings.rules), settings.minDomainGroupSize);
  const n = await applyGroups(windowId, groups);
  return `Made or updated ${n} group${n === 1 ? "" : "s"}.`;
}

async function askClaude(payload) {
  const settings = await getSettings();
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, { ...payload, model: settings.model });
    if (!reply || !reply.ok) throw new Error(reply?.error || "No reply from the native host.");
    return reply.groups;
  } catch (err) {
    if (/native messaging host not found|not allowed/i.test(err.message)) {
      throw new Error("Native host isn't installed. Run install.sh, then reload the extension.");
    }
    throw err;
  } finally {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function existingGroupNames(windowId) {
  return (await chrome.tabGroups.query({ windowId })).map((g) => g.title).filter(Boolean);
}

async function organizeWithClaude(windowId) {
  const settings = await getSettings();
  const tabs = await groupableTabs(windowId);
  if (tabs.length < 2) return "Not enough tabs to organize.";
  const groups = await askClaude({
    mode: "organize",
    tabs: tabs.map(describeTab),
    existingGroups: await existingGroupNames(windowId),
    rules: settings.rules,
  });
  const n = await applyGroups(windowId, groups);
  return `Claude organized ${tabs.length} tabs into ${n} group${n === 1 ? "" : "s"}.`;
}

async function ungroupAll(windowId) {
  const ids = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId !== -1).map((t) => t.id);
  if (ids.length) await chrome.tabs.ungroup(ids);
  return `Ungrouped ${ids.length} tab${ids.length === 1 ? "" : "s"}.`;
}

// ---- Duplicate tabs ----

// When each tab last finished loading. Kept in session storage so it survives
// the service worker being stopped, and cleared when the browser quits. One key
// per tab, so tabs finishing at the same moment can't overwrite each other.
const LOADED_PREFIX = "loadedAt:";

async function loadTimes() {
  const loadedAt = {};
  for (const [key, ms] of Object.entries(await chrome.storage.session.get(null))) {
    if (key.startsWith(LOADED_PREFIX)) loadedAt[key.slice(LOADED_PREFIX.length)] = ms;
  }
  return loadedAt;
}

const recordLoad = (tabId) => chrome.storage.session.set({ [LOADED_PREFIX + tabId]: Date.now() });
const forgetLoad = (tabId) => chrome.storage.session.remove(LOADED_PREFIX + tabId);

// Looks across every window, since a copy in another window is still a copy.
async function closeDuplicates() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const ids = findDuplicatesToClose(tabs, await loadTimes());
  if (ids.length) await chrome.tabs.remove(ids);
  return ids.length
    ? `Closed ${ids.length} duplicate tab${ids.length === 1 ? "" : "s"}. Cmd+Shift+T reopens them.`
    : "No duplicate tabs.";
}

// ---- Auto-grouping of new and navigated tabs ----

// Tabs are auto-grouped once per site, so a tab the user pulls out of a group
// stays out until it navigates somewhere else.
const handledSite = new Map();
const pendingWindows = new Map();
const pendingClaude = new Map();

function schedule(map, windowId, delay, fn) {
  clearTimeout(map.get(windowId));
  map.set(windowId, setTimeout(() => {
    map.delete(windowId);
    fn(windowId).catch((err) => console.warn("Auto-group failed:", err));
  }, delay));
}

// The existing group a new tab belongs in: the one its rule or site label
// names, or, with no rule, the one already holding tabs from its site.
function findMatchingGroup(tab, rules, tabs, groups) {
  const rule = matchRule(rules, tab.url);
  const site = siteOf(tab.url);
  const name = rule ? rule.name : site && labelForSite(site);
  let group = name && groups.find((g) => (g.title || "").toLowerCase() === name.toLowerCase());
  if (!group && !rule) {
    const groupId = groupForSite(tabs, site);
    group = groups.find((g) => g.id === groupId);
  }
  return group?.title ? group : null;
}

// Moves a tab into a group in another window. If the tab was the one being
// looked at, follow it so the page doesn't seem to vanish.
async function moveToGroupElsewhere(tab, group) {
  await chrome.tabs.group({ groupId: group.id, tabIds: [tab.id] });
  if (tab.active) {
    await chrome.windows.update(group.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }
}

async function autoGroupWindow(windowId) {
  const settings = await getSettings();
  const rules = parseRules(settings.rules);
  const tabs = await groupableTabs(windowId);
  const existing = await chrome.tabGroups.query({ windowId });
  const fresh = tabs.filter((t) => t.groupId === -1 && t.status === "complete" && handledSite.get(t.id) !== siteOf(t.url));
  if (!fresh.length) return;
  fresh.forEach((t) => handledSite.set(t.id, siteOf(t.url)));

  // Only when no group in this window fits does it look at other windows.
  let elsewhere = null;
  if (settings.joinGroupsAcrossWindows) {
    const all = await chrome.tabs.query({ windowType: "normal", pinned: false });
    const allGroups = await chrome.tabGroups.query({});
    const windowIds = new Set(all.map((t) => t.windowId));
    elsewhere = {
      tabs: all.filter((t) => t.windowId !== windowId),
      groups: allGroups.filter((g) => g.windowId !== windowId && windowIds.has(g.windowId)),
    };
  }

  const toExisting = [];
  const rest = [];
  const placed = new Set();
  for (const tab of fresh) {
    const group = findMatchingGroup(tab, rules, tabs, existing);
    const other = !group && elsewhere && findMatchingGroup(tab, rules, elsewhere.tabs, elsewhere.groups);
    if (group) toExisting.push({ name: group.title, tabIds: [tab.id] });
    else if (other) await moveToGroupElsewhere(tab, other);
    else {
      rest.push(tab);
      continue;
    }
    placed.add(tab.id);
  }
  await applyGroups(windowId, toExisting);

  // Otherwise group with other ungrouped tabs that share a rule or site.
  const ungrouped = tabs.filter((t) => t.groupId === -1 && !placed.has(t.id));
  const { groups, leftovers } = planRuleAndDomainGroups(ungrouped, rules, settings.minDomainGroupSize);
  const restIds = new Set(rest.map((t) => t.id));
  await applyGroups(windowId, groups.filter((g) => g.tabIds.some((id) => restIds.has(id))));

  const unplaced = leftovers.filter((t) => restIds.has(t.id));
  if (settings.useClaudeForUnmatched && unplaced.length) {
    schedule(pendingClaude, windowId, CLAUDE_AUTO_DELAY_MS, assignWithClaude);
  }
}

async function assignWithClaude(windowId) {
  const settings = await getSettings();
  const tabs = (await groupableTabs(windowId)).filter((t) => t.groupId === -1);
  if (!tabs.length) return;
  const groups = await askClaude({
    mode: "assign",
    tabs: tabs.map(describeTab),
    existingGroups: await existingGroupNames(windowId),
    rules: settings.rules,
  });
  await applyGroups(windowId, groups);
}

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== "complete") return;
  await recordLoad(tabId);
  if (tab.pinned || tab.groupId !== -1) return;
  if (!(await getSettings()).autoGroup) return;
  schedule(pendingWindows, tab.windowId, AUTO_DELAY_MS, autoGroupWindow);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handledSite.delete(tabId);
  forgetLoad(tabId);
});

// ---- Popup and keyboard shortcuts ----

const COMMANDS = { groupByRules, organizeWithClaude, ungroupAll, closeDuplicates };
const SHORTCUTS = {
  "organize-with-claude": organizeWithClaude,
  "group-by-rules": groupByRules,
  "close-duplicates": closeDuplicates,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = COMMANDS[msg.cmd];
  if (!fn) return false;
  fn(msg.windowId)
    .then((message) => sendResponse({ ok: true, message }))
    .catch((err) => sendResponse({ ok: false, message: err.message }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const win = await chrome.windows.getLastFocused();
  SHORTCUTS[command](win.id).catch((err) => console.warn(command, "failed:", err));
});
