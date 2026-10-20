// Pure grouping logic, no chrome.* calls, so it can be tested under Node.

export const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

export const DEFAULT_SETTINGS = {
  autoGroup: true,
  useClaudeForUnmatched: false,
  joinGroupsAcrossWindows: false,
  manualScope: "window",
  jiraProjects: "",
  githubLookups: false,
  groupByMilestone: true,
  minDomainGroupSize: 2,
  model: "haiku",
  rules: "",
};

// Rule lines look like:   github.com/decisiv = Work repos, blue
// The left side is a substring of "host/path", or /regex/ to match the full URL.
// Blank lines and lines starting with # are ignored.
export function parseRules(text) {
  const rules = [];
  for (const raw of (text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const pattern = line.slice(0, eq).trim();
    const [name, color] = line.slice(eq + 1).split(",").map((s) => s.trim());
    if (!name) continue;
    let regex = null;
    if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
      try {
        regex = new RegExp(pattern.slice(1, -1), "i");
      } catch {
        continue;
      }
    }
    rules.push({ pattern, regex, name, color: COLORS.includes(color) ? color : undefined });
  }
  return rules;
}

export function matchRule(rules, url) {
  if (!url) return null;
  let hostPath = url;
  try {
    const u = new URL(url);
    hostPath = (u.host + u.pathname).toLowerCase();
  } catch {}
  for (const rule of rules) {
    if (rule.regex ? rule.regex.test(url) : hostPath.includes(rule.pattern.toLowerCase())) return rule;
  }
  return null;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

// "docs.google.com" -> "google.com", "www.bbc.co.uk" -> "bbc.co.uk"
export function siteOf(url) {
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host === "localhost") return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const take = SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-take).join(".");
}

// "github.com" -> "Github", "bbc.co.uk" -> "Bbc"
export function labelForSite(site) {
  const name = site.split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Stable color per name, so a group keeps its color across runs.
export function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// Returns [{ name, color, tabIds }]. Rule matches win; remaining tabs are grouped
// by site when at least minSize tabs share one. Leftovers are returned separately.
export function planRuleAndDomainGroups(tabs, rules, minSize) {
  const byName = new Map();
  const bySite = new Map();
  const leftovers = [];
  for (const tab of tabs) {
    const rule = matchRule(rules, tab.url);
    if (rule) {
      if (!byName.has(rule.name)) byName.set(rule.name, { name: rule.name, color: rule.color, tabIds: [] });
      byName.get(rule.name).tabIds.push(tab.id);
      continue;
    }
    const site = siteOf(tab.url);
    if (!site) {
      leftovers.push(tab);
      continue;
    }
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(tab);
  }
  for (const [site, siteTabs] of bySite) {
    if (siteTabs.length < minSize) {
      leftovers.push(...siteTabs);
      continue;
    }
    const name = labelForSite(site);
    if (!byName.has(name)) byName.set(name, { name, tabIds: [] });
    byName.get(name).tabIds.push(...siteTabs.map((t) => t.id));
  }
  const groups = [...byName.values()].map((g) => ({ ...g, color: g.color || colorFor(g.name) }));
  return { groups, leftovers };
}

export function formatRule({ pattern, name, color }) {
  return `${pattern} = ${name}${color ? `, ${color}` : ""}`;
}

export const ruleKey = (pattern) => pattern.trim().toLowerCase();

// Which of Claude's suggested rules are worth showing: ones that parse as a
// rule, match at least one of the tabs Claude was shown, and aren't already a
// rule, already pending, or previously dismissed. With groups (Claude's reply),
// every matching tab must also be in the group the rule names, since a rule
// that cut across Claude's own groups would undo its grouping from then on.
export function filterSuggestions(suggestions, { rulesText, pending = [], dismissed = [], tabs = [], groups = null }) {
  const skip = new Set([
    ...parseRules(rulesText).map((r) => ruleKey(r.pattern)),
    ...pending.map((s) => ruleKey(s.pattern)),
    ...dismissed,
  ]);
  const fresh = [];
  for (const s of suggestions || []) {
    const [rule] = parseRules(formatRule(s));
    if (!rule || rule.pattern !== s.pattern.trim() || skip.has(ruleKey(s.pattern))) continue;
    const matching = tabs.filter((t) => matchRule([rule], t.url));
    if (!matching.length) continue;
    if (groups) {
      const group = groups.find((g) => g.name.toLowerCase() === rule.name.toLowerCase());
      if (!group || !matching.every((t) => group.tabIds.includes(t.id))) continue;
    }
    skip.add(ruleKey(s.pattern));
    fresh.push({ pattern: rule.pattern, name: rule.name, color: rule.color });
  }
  return fresh;
}

// The existing group holding the most tabs from this site, or null. Lets a
// new github.com tab join a "Work repos" group full of GitHub tabs, whatever
// the group is called.
export function groupForSite(tabs, site) {
  if (!site) return null;
  const counts = new Map();
  for (const tab of tabs) {
    if (tab.groupId === -1 || tab.groupId === undefined || siteOf(tab.url) !== site) continue;
    counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);
  }
  let best = null;
  for (const [groupId, n] of counts) if (best === null || n > counts.get(best)) best = groupId;
  return best;
}

// Returns ids of tabs to close so each URL is open once. The survivor is the
// copy that finished loading last (loadedAt: tabId -> ms); tabs with no
// recorded load fall back to lastAccessed, then to the newest tab id. Pinned
// tabs are never closed, and a pinned copy always survives.
export function findDuplicatesToClose(tabs, loadedAt = {}) {
  const byUrl = new Map();
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (!byUrl.has(tab.url)) byUrl.set(tab.url, []);
    byUrl.get(tab.url).push(tab);
  }
  const rank = (t) => [t.pinned ? 1 : 0, loadedAt[t.id] || 0, t.lastAccessed || 0, t.id];
  const newer = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
    return false;
  };
  const toClose = [];
  for (const copies of byUrl.values()) {
    if (copies.length < 2) continue;
    const keep = copies.reduce((best, t) => (newer(t, best) ? t : best));
    toClose.push(...copies.filter((t) => t !== keep && !t.pinned).map((t) => t.id));
  }
  return toClose;
}

// What Claude gets to see about a tab: no query strings or fragments, since
// those often carry tokens, emails, and search terms.
export function describeTab(tab) {
  let url = tab.url || "";
  try {
    const u = new URL(url);
    url = u.protocol.startsWith("http") ? u.origin + u.pathname : u.protocol + "//" + u.host;
  } catch {}
  return { id: tab.id, title: (tab.title || "").slice(0, 200), url: url.slice(0, 300) };
}
