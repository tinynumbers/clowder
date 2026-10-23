import {
  COLORS,
  DEFAULT_SETTINGS,
  colorFor,
  describeTab,
  filterSuggestions,
  findDuplicatesToClose,
  groupForSite,
  labelForSite,
  matchRule,
  parseRules,
  planRuleAndDomainGroups,
  siteOf,
} from "./grouping.js";
import { clusterGroups, enforceClusters, findClusters, jiraProjects, linkedGroupId, parsePrUrl, prKey, tabFacts } from "./links.js";

const HOST = "com.clowder_tabs.host";
const AUTO_DELAY_MS = 1500;
const CLAUDE_AUTO_DELAY_MS = 8000;
const GITHUB_CACHE_MS = 5 * 60 * 1000;
// Bump when the lookup starts returning new fields, so old cache entries are ignored.
const GITHUB_CACHE_PREFIX = "gh2:";
const MAX_RECENT_INSTRUCTIONS = 8;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
}

// With allWindows, tabs from every normal window instead of just this one.
async function groupableTabs(windowId, allWindows = false) {
  const query = allWindows ? { windowType: "normal", pinned: false } : { windowId, pinned: false };
  const tabs = await chrome.tabs.query(query);
  return tabs.filter((t) => t.url && !t.url.startsWith("chrome-extension://"));
}

// Groups in this window, or with allWindows in every window, this window's first
// so a same-named group here wins over one elsewhere.
async function groupsInScope(windowId, allWindows = false) {
  if (!allWindows) return chrome.tabGroups.query({ windowId });
  const groups = await chrome.tabGroups.query({});
  return groups.sort((a, b) => (b.windowId === windowId) - (a.windowId === windowId));
}

// Puts each planned group's tabs into the existing group of the same name, or a
// new group. Tabs that closed or left the scope meanwhile are skipped. With
// allWindows, groups and tabs from other windows are moved into this window.
async function applyGroups(windowId, groups, allWindows = false) {
  const live = new Set((await groupableTabs(windowId, allWindows)).map((t) => t.id));
  const existing = await groupsInScope(windowId, allWindows);
  let applied = 0;
  for (const group of groups) {
    const tabIds = [...new Set(group.tabIds)].filter((id) => live.has(id));
    if (!tabIds.length) continue;
    const name = group.name.slice(0, 40);
    const color = COLORS.includes(group.color) ? group.color : colorFor(name);
    const match = existing.find((g) => (g.title || "").toLowerCase() === name.toLowerCase());
    if (match) {
      if (match.windowId !== windowId) {
        await chrome.tabGroups.move(match.id, { windowId, index: -1 });
        match.windowId = windowId;
      }
      await chrome.tabs.group({ groupId: match.id, tabIds });
    } else {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: name, color });
      existing.push({ id: groupId, title: name, windowId });
    }
    tabIds.forEach((id) => live.delete(id));
    applied++;
  }
  return applied;
}

// " from 3 windows", or nothing when every tab is in one window.
function windowsNote(tabs) {
  const n = new Set(tabs.map((t) => t.windowId)).size;
  return n > 1 ? ` from ${n} windows` : "";
}

async function callHost(msg) {
  try {
    const reply = await chrome.runtime.sendNativeMessage(HOST, msg);
    if (!reply || !reply.ok) throw new Error(reply?.error || "No reply from the native host.");
    return reply;
  } catch (err) {
    if (/native messaging host not found|not allowed/i.test(err.message)) {
      throw new Error("Native host isn't installed. Run install.sh, then reload the extension.");
    }
    throw err;
  }
}

// ---- Linked tabs: tickets, their PRs and CI runs, and shared milestones ----

// Milestone, branch, and CI links for the open PRs, from the gh CLI. Cached for
// a few minutes so auto-grouping doesn't call GitHub on every new tab. A failed
// lookup never stops grouping; it comes back as a warning instead.
async function prDetails(tabs, settings) {
  if (!settings.githubLookups) return { prMeta: {}, warning: "" };
  const refs = new Map();
  for (const tab of tabs) {
    const pr = parsePrUrl(tab.url);
    if (pr) refs.set(prKey(pr), pr);
  }
  if (!refs.size) return { prMeta: {}, warning: "" };
  const cacheKeys = [...refs.keys()].map((k) => GITHUB_CACHE_PREFIX + k);
  const cached = await chrome.storage.session.get(cacheKeys);
  const prMeta = {};
  const missing = [];
  for (const [key, pr] of refs) {
    const hit = cached[GITHUB_CACHE_PREFIX + key];
    if (hit && Date.now() - hit.at < GITHUB_CACHE_MS) {
      if (hit.meta) prMeta[key] = hit.meta;
    } else missing.push(pr);
  }
  if (!missing.length) return { prMeta, warning: "" };
  try {
    const reply = await callHost({ mode: "github", prs: missing });
    const store = {};
    for (const pr of missing) {
      const meta = reply.prs[prKey(pr)] || null;
      store[GITHUB_CACHE_PREFIX + prKey(pr)] = { at: Date.now(), meta };
      if (meta) prMeta[prKey(pr)] = meta;
    }
    await chrome.storage.session.set(store);
    const warning = reply.errors?.length ? `GitHub couldn't find ${reply.errors.length} PR${reply.errors.length === 1 ? "" : "s"}.` : "";
    return { prMeta, warning };
  } catch (err) {
    console.warn("GitHub lookup failed:", err);
    return { prMeta, warning: `GitHub lookup failed: ${err.message}` };
  }
}

// Also returns what it learned (Jira projects, PR details), which Claude is
// shown alongside each tab via forClaude().
async function linkClusters(tabs, settings) {
  const { prMeta, warning } = await prDetails(tabs, settings);
  const projects = jiraProjects(tabs, settings.jiraProjects);
  const clusters = findClusters(tabs, { projects, prMeta, groupByMilestone: settings.groupByMilestone });
  return { clusters, warning, projects, prMeta };
}

// Tabs as Claude sees them: title and trimmed URL, plus any facts we know.
function forClaude(tabs, { projects, prMeta }) {
  return tabs.map((t) => {
    const facts = tabFacts(t, { projects, prMeta });
    return facts ? { ...describeTab(t), facts } : describeTab(t);
  });
}

const withWarning = (message, warning) => (warning ? `${message} ${warning}` : message);

// Linked tabs are grouped first and outrank rules, which tend to sort by site
// and would split a ticket from its PR.
async function groupByRules(windowId) {
  const settings = await getSettings();
  const allWindows = settings.manualScope === "all";
  const tabs = await groupableTabs(windowId, allWindows);
  const { clusters, warning } = await linkClusters(tabs, settings);
  const linked = new Set(clusters.flatMap((c) => c.tabIds));
  const titles = new Map((await groupsInScope(windowId, allWindows)).map((g) => [g.id, g.title]));
  const rest = tabs.filter((t) => !linked.has(t.id));
  const { groups } = planRuleAndDomainGroups(rest, parseRules(settings.rules), settings.minDomainGroupSize);
  const n = await applyGroups(windowId, [...clusterGroups(clusters, tabs, titles), ...groups], allWindows);
  return withWarning(`Made or updated ${n} group${n === 1 ? "" : "s"}${windowsNote(tabs)}.`, warning);
}

// Saves Claude's new rule suggestions for approval on the settings page and
// returns how many were new. Kept in local storage: they're per browser.
async function storeSuggestions(suggestions, tabs, groups, rulesText) {
  const { ruleSuggestions = [], dismissedRules = [] } = await chrome.storage.local.get(["ruleSuggestions", "dismissedRules"]);
  const fresh = filterSuggestions(suggestions, {
    rulesText,
    pending: ruleSuggestions,
    dismissed: dismissedRules,
    tabs,
    groups,
  });
  if (fresh.length) await chrome.storage.local.set({ ruleSuggestions: [...ruleSuggestions, ...fresh] });
  return fresh.length;
}

// Returns Claude's groups, plus how many new rule suggestions it stored. Each
// cluster of linked tabs is held together whatever Claude did, unless you've
// given standing guidance or an instruction, which outrank links.
async function askClaude(payload, clusters = []) {
  const settings = await getSettings();
  const guidance = settings.guidance.trim();
  await chrome.action.setBadgeText({ text: "…" });
  try {
    const reply = await callHost({ ...payload, guidance, linked: clusters, model: settings.model });
    const enforce = payload.mode !== "instruct" && !guidance;
    const groups = enforce ? enforceClusters(reply.groups, clusters) : reply.groups;
    const newRules = await storeSuggestions(reply.suggestedRules, payload.tabs, groups, settings.rules);
    return { groups, newRules };
  } finally {
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function existingGroupNames(windowId, allWindows = false) {
  const names = (await groupsInScope(windowId, allWindows)).map((g) => g.title).filter(Boolean);
  return [...new Set(names)];
}

async function organizeWithClaude(windowId) {
  const settings = await getSettings();
  const allWindows = settings.manualScope === "all";
  const tabs = await groupableTabs(windowId, allWindows);
  if (tabs.length < 2) return "Not enough tabs to organize.";
  const link = await linkClusters(tabs, settings);
  const { clusters, warning } = link;
  const { groups, newRules } = await askClaude(
    {
      mode: "organize",
      tabs: forClaude(tabs, link),
      existingGroups: await existingGroupNames(windowId, allWindows),
      rules: settings.rules,
    },
    clusters,
  );
  const n = await applyGroups(windowId, groups, allWindows);
  const suggested = newRules ? ` It also suggested ${newRules} new rule${newRules === 1 ? "" : "s"}: see Rules and settings.` : "";
  return withWarning(`Claude organized ${tabs.length} tabs${windowsNote(tabs)} into ${n} group${n === 1 ? "" : "s"}.${suggested}`, warning);
}

// Words that mean an instruction depends on what GitHub knows about a PR.
const NEEDS_GITHUB = /\b(merged|closed|draft|milestones?|branch(es)?)\b/i;

async function rememberInstruction(instruction) {
  const { recentInstructions = [] } = await chrome.storage.local.get("recentInstructions");
  const recent = [instruction, ...recentInstructions.filter((i) => i !== instruction)].slice(0, MAX_RECENT_INSTRUCTIONS);
  await chrome.storage.local.set({ recentInstructions: recent });
}

// Groups just the tabs your instruction describes, like "put the merged PRs in
// one group", and leaves every other tab where it is.
async function groupWithInstruction(windowId, { instruction = "" } = {}) {
  instruction = instruction.trim();
  if (!instruction) throw new Error("Type an instruction first.");
  const settings = await getSettings();
  const allWindows = settings.manualScope === "all";
  const tabs = await groupableTabs(windowId, allWindows);
  const link = await linkClusters(tabs, settings);
  const { groups } = await askClaude(
    {
      mode: "instruct",
      instruction,
      tabs: forClaude(tabs, link),
      existingGroups: await existingGroupNames(windowId, allWindows),
      rules: settings.rules,
    },
    link.clusters,
  );
  await rememberInstruction(instruction);
  const hint =
    !settings.githubLookups && NEEDS_GITHUB.test(instruction)
      ? " Claude can't see PR status, milestones or branches unless \"Look up pull requests on GitHub\" is on in settings."
      : "";
  if (!groups.length) return withWarning(`Claude didn't find any tabs that fit.${hint}`, link.warning);
  await applyGroups(windowId, groups, allWindows);
  const moved = groups.reduce((n, g) => n + g.tabIds.length, 0);
  const names = groups.map((g) => `"${g.name}"`).join(", ");
  return withWarning(`Put ${moved} tab${moved === 1 ? "" : "s"} in ${names}.${hint}`, link.warning);
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

  // Links come first: a new tab joins the group holding the tabs it's linked
  // to, or forms one with linked tabs that aren't grouped yet.
  const scopeTabs = elsewhere ? [...tabs, ...elsewhere.tabs] : tabs;
  const { clusters } = await linkClusters(scopeTabs, settings);
  const linkedIds = new Set(clusters.flatMap((c) => c.tabIds));
  const unlinked = (list) => list.filter((t) => !linkedIds.has(t.id));
  const toExisting = [];
  const rest = [];
  const placed = new Set();
  for (const tab of fresh) {
    if (placed.has(tab.id)) continue;
    const linkedId = linkedGroupId(tab.id, clusters, scopeTabs);
    if (linkedId !== null) {
      const target = elsewhere?.groups.find((g) => g.id === linkedId);
      if (target) await moveToGroupElsewhere(tab, target);
      else await chrome.tabs.group({ groupId: linkedId, tabIds: [tab.id] });
      placed.add(tab.id);
      continue;
    }
    const cluster = clusters.find((c) => c.tabIds.includes(tab.id));
    const here = cluster && tabs.filter((t) => cluster.tabIds.includes(t.id) && t.groupId === -1).map((t) => t.id);
    if (here?.length > 1) {
      toExisting.push({ name: cluster.label, tabIds: here });
      here.forEach((id) => placed.add(id));
      continue;
    }
    // Linked tabs don't count toward a group's sites, or an unrelated GitHub
    // tab would join a ticket's group just because it holds the ticket's PR.
    const group = findMatchingGroup(tab, rules, unlinked(tabs), existing);
    const other = !group && elsewhere && findMatchingGroup(tab, rules, unlinked(elsewhere.tabs), elsewhere.groups);
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
  const { groups } = await askClaude({
    mode: "assign",
    tabs: forClaude(tabs, await linkClusters(tabs, settings)),
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

const COMMANDS = { groupByRules, organizeWithClaude, groupWithInstruction, ungroupAll, closeDuplicates };
const SHORTCUTS = {
  "organize-with-claude": organizeWithClaude,
  "group-by-rules": groupByRules,
  "close-duplicates": closeDuplicates,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = COMMANDS[msg.cmd];
  if (!fn) return false;
  fn(msg.windowId, msg)
    .then((message) => sendResponse({ ok: true, message }))
    .catch((err) => sendResponse({ ok: false, message: err.message }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const win = await chrome.windows.getLastFocused();
  SHORTCUTS[command](win.id).catch((err) => console.warn(command, "failed:", err));
});
