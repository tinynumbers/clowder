// Finds tabs that belong to the same piece of work: a Jira ticket, the pull
// requests that mention it, their CircleCI runs, and PRs sharing a milestone.
// Pure logic, no chrome.* calls, so it can be tested under Node.

// A tab naming more tickets than this (a release PR listing everything in it)
// doesn't link by ticket, or it would merge every task into one group.
export const MAX_TICKETS_PER_TAB = 3;

const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![0-9])/g;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Jira project keys ("PD", "CASE"): the ones you list in settings, plus any
// seen in an open Jira ticket's URL. Only these count as ticket keys, so
// lookalikes such as UTF-8 and SHA-256 are ignored.
export function jiraProjects(tabs, configured = "") {
  const projects = new Set(
    configured.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9]{1,9}$/.test(s)),
  );
  for (const tab of tabs) {
    const u = parse(tab.url);
    if (!u || !(u.hostname.endsWith("atlassian.net") || u.hostname.includes("jira"))) continue;
    const m = u.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9]{1,9})-\d+/);
    if (m) projects.add(m[1].toUpperCase());
  }
  return projects;
}

export function ticketKeys(text, projects) {
  const keys = new Set();
  for (const [, project, number] of (text || "").matchAll(KEY_RE)) {
    const p = project.toUpperCase();
    if (projects.has(p)) keys.add(`${p}-${number}`);
  }
  return keys;
}

// github.com/owner/repo/pull/12 (and its /files, /checks... subpages).
export function parsePrUrl(url) {
  const u = parse(url);
  if (!u || u.hostname !== "github.com") return null;
  const m = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export const prKey = ({ owner, repo, number }) => `${owner}/${repo}#${number}`.toLowerCase();

// Identifiers for a CircleCI run, from an open CircleCI tab or from a link in
// a PR's checks. A workflow id is unique on its own; job numbers are per repo.
//   app.circleci.com/pipelines/github/org/repo/12/workflows/<uuid>/jobs/345
//   app.circleci.com/workflow/<uuid>
//   app.circleci.com/jobs/github/org/repo/345
//   circleci.com/gh/org/repo/345
export function circleKeys(url) {
  const u = parse(url);
  if (!u || !/(^|\.)circleci\.com$/.test(u.hostname)) return [];
  const path = u.pathname.toLowerCase();
  const keys = [];
  const wf = path.match(new RegExp(`/workflows?/(${UUID})`));
  if (wf) keys.push(`ci:wf:${wf[1]}`);
  const job =
    path.match(/^\/pipelines\/(?:github|gh)\/([\w.-]+)\/([\w.-]+)\/\d+\/workflows\/[^/]+\/jobs\/(\d+)/) ||
    path.match(/^\/jobs\/(?:github|gh)\/([\w.-]+)\/([\w.-]+)\/(\d+)/) ||
    path.match(/^\/gh\/([\w.-]+)\/([\w.-]+)\/(\d+)/);
  if (job) keys.push(`ci:job:${job[1]}/${job[2]}/${job[3]}`);
  return keys;
}

// Everything that can link this tab to others. prMeta maps prKey() to what the
// gh lookup found: { milestone, headRef, ciUrls }.
export function linkKeys(tab, { projects, prMeta = {}, groupByMilestone = true }) {
  const keys = new Set();
  const tickets = ticketKeys(`${tab.title || ""} ${tab.url || ""}`, projects);
  const pr = parsePrUrl(tab.url);
  const meta = pr && prMeta[prKey(pr)];
  if (meta?.headRef) ticketKeys(meta.headRef, projects).forEach((k) => tickets.add(k));
  if (tickets.size <= MAX_TICKETS_PER_TAB) tickets.forEach((k) => keys.add(`ticket:${k}`));
  if (pr) keys.add(`pr:${prKey(pr)}`);
  if (meta?.milestone && groupByMilestone) keys.add(`ms:${meta.milestone.trim().toLowerCase()}`);
  for (const url of meta?.ciUrls || []) circleKeys(url).forEach((k) => keys.add(k));
  circleKeys(tab.url).forEach((k) => keys.add(k));
  return keys;
}

// A short group name for a cluster: its milestone, else its ticket keys, else its PR.
function labelFor(keys, milestones) {
  const ms = [...keys].find((k) => k.startsWith("ms:"));
  if (ms) return milestones.get(ms);
  const tickets = [...keys].filter((k) => k.startsWith("ticket:")).map((k) => k.slice(7)).sort();
  if (tickets.length) return tickets.length > 2 ? `${tickets.slice(0, 2).join(", ")} +${tickets.length - 2}` : tickets.join(", ");
  const pr = [...keys].find((k) => k.startsWith("pr:"));
  if (pr) return pr.slice(3).split("/")[1].replace("#", " #");
  return "Related";
}

// Groups tabs that share any link key. Returns [{ tabIds, label }] for every
// set of two or more linked tabs.
export function findClusters(tabs, opts) {
  const parent = new Map(tabs.map((t) => [t.id, t.id]));
  const find = (id) => {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  };
  const owner = new Map();
  const keysByTab = new Map();
  const milestones = new Map();
  for (const tab of tabs) {
    const keys = linkKeys(tab, opts);
    keysByTab.set(tab.id, keys);
    for (const key of keys) {
      if (key.startsWith("ms:") && !milestones.has(key)) {
        milestones.set(key, opts.prMeta[prKey(parsePrUrl(tab.url))].milestone.trim());
      }
      if (owner.has(key)) parent.set(find(tab.id), find(owner.get(key)));
      else owner.set(key, tab.id);
    }
  }
  const byRoot = new Map();
  for (const tab of tabs) {
    const root = find(tab.id);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(tab.id);
  }
  const clusters = [];
  for (const tabIds of byRoot.values()) {
    if (tabIds.length < 2) continue;
    // Only keys at least two of these tabs share say why they're linked.
    const counts = new Map();
    for (const id of tabIds) for (const k of keysByTab.get(id)) counts.set(k, (counts.get(k) || 0) + 1);
    const shared = new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
    clusters.push({ tabIds, label: labelFor(shared, milestones) });
  }
  return clusters;
}

// The group most of this tab's linked tabs are already in, or null. Tabs are
// chrome.tabs.Tab-shaped, with groupId -1 when ungrouped.
export function linkedGroupId(tabId, clusters, tabs) {
  const cluster = clusters.find((c) => c.tabIds.includes(tabId));
  return cluster ? majorityGroup(cluster.tabIds.filter((id) => id !== tabId), tabs) : null;
}

// The group holding the most of these tabs, or null if none are grouped.
function majorityGroup(tabIds, tabs) {
  const members = new Set(tabIds);
  const counts = new Map();
  for (const t of tabs) {
    if (!members.has(t.id) || t.groupId === -1 || t.groupId === undefined) continue;
    counts.set(t.groupId, (counts.get(t.groupId) || 0) + 1);
  }
  let best = null;
  for (const [groupId, n] of counts) if (best === null || n > counts.get(best)) best = groupId;
  return best;
}

// Turns clusters into groups to apply without Claude. Each keeps the name of
// the existing group most of it is already in (groupTitles: groupId -> title),
// so re-running doesn't rename your groups, or else takes the cluster's label.
export function clusterGroups(clusters, tabs, groupTitles) {
  return clusters.map((c) => ({
    name: groupTitles.get(majorityGroup(c.tabIds, tabs)) || c.label,
    tabIds: [...c.tabIds],
  }));
}

// Makes each cluster land in a single group, whatever Claude (or a rule) did:
// the group already holding most of the cluster takes the rest, or a new
// group named after the cluster is made. Groups left empty are dropped.
export function enforceClusters(groups, clusters) {
  const out = groups.map((g) => ({ ...g, tabIds: [...g.tabIds] }));
  for (const cluster of clusters) {
    const members = new Set(cluster.tabIds);
    let best = null;
    let bestCount = 0;
    for (const g of out) {
      const n = g.tabIds.filter((id) => members.has(id)).length;
      if (n > bestCount) [best, bestCount] = [g, n];
    }
    for (const g of out) if (g !== best) g.tabIds = g.tabIds.filter((id) => !members.has(id));
    if (best) best.tabIds = [...new Set([...best.tabIds, ...cluster.tabIds])];
    else out.push({ name: cluster.label, tabIds: [...cluster.tabIds] });
  }
  return out.filter((g) => g.tabIds.length);
}
