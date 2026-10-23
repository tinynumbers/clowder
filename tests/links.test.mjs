import assert from "node:assert/strict";
import { test } from "node:test";
import {
  circleKeys,
  clusterGroups,
  enforceClusters,
  findClusters,
  jiraProjects,
  linkedGroupId,
  linkKeys,
  tabFacts,
  parsePrUrl,
  ticketKeys,
} from "../extension/links.js";

const WF = "89a04d8c-be6a-4d89-b333-51f6a0988b58";

test("jiraProjects combines configured keys with ones seen in Jira URLs", () => {
  const tabs = [{ url: "https://acme.atlassian.net/browse/PD-1234" }, { url: "https://jira.example.com/browse/case-9" }];
  assert.deepEqual([...jiraProjects(tabs, "ops, bad-key, X")].sort(), ["CASE", "OPS", "PD"]);
});

test("ticketKeys only accepts known projects and normalizes case", () => {
  const projects = new Set(["PD"]);
  assert.deepEqual([...ticketKeys("[PD-12] fix UTF-8 and SHA-256, see pd-34-branch", projects)], ["PD-12", "PD-34"]);
  assert.deepEqual([...ticketKeys("XPD-12 PD-123456789", projects)], []);
});

test("parsePrUrl reads PR pages and their subpages only", () => {
  assert.deepEqual(parsePrUrl("https://github.com/Acme/pricing/pull/88/files"), { owner: "Acme", repo: "pricing", number: 88 });
  assert.equal(parsePrUrl("https://github.com/acme/pricing/pulls"), null);
  assert.equal(parsePrUrl("https://github.com/acme/pricing/issues/88"), null);
});

test("circleKeys reads every CircleCI URL shape", () => {
  assert.deepEqual(circleKeys(`https://app.circleci.com/pipelines/github/Acme/pricing/12/workflows/${WF}/jobs/345`), [
    `ci:wf:${WF}`,
    "ci:job:acme/pricing/345",
  ]);
  assert.deepEqual(circleKeys(`https://app.circleci.com/workflow/${WF}?utm_source=github`), [`ci:wf:${WF}`]);
  assert.deepEqual(circleKeys("https://circleci.com/gh/acme/pricing/345"), ["ci:job:acme/pricing/345"]);
  assert.deepEqual(circleKeys("https://app.circleci.com/jobs/github/acme/pricing/345"), ["ci:job:acme/pricing/345"]);
  assert.deepEqual(circleKeys("https://app.circleci.com/pipelines/github/acme/pricing/12"), []);
  assert.deepEqual(circleKeys("https://notcircleci.com/gh/a/b/1"), []);
});

test("linkKeys ignores ticket keys on a tab that names too many", () => {
  const keys = linkKeys({ title: "Release: PD-1 PD-2 PD-3 PD-4", url: "https://github.com/acme/app/pull/9" }, { projects: new Set(["PD"]) });
  assert.deepEqual([...keys], ["pr:acme/app#9"]);
});

const projects = new Set(["PD"]);
const tabs = [
  { id: 1, title: "[PD-1] Fix rounding - Jira", url: "https://acme.atlassian.net/browse/PD-1" },
  { id: 2, title: "[PD-1] Fix rounding by dwd · Pull Request #88", url: "https://github.com/acme/pricing/pull/88" },
  { id: 3, title: "pricing - CircleCI", url: `https://app.circleci.com/pipelines/github/acme/pricing/7/workflows/${WF}` },
  { id: 4, title: "Speed up export · Pull Request #90", url: "https://github.com/acme/pricing/pull/90" },
  { id: 5, title: "[PD-2] Export timeout - Jira", url: "https://acme.atlassian.net/browse/PD-2" },
  { id: 6, title: "Docs PR · Pull Request #12", url: "https://github.com/acme/docs/pull/12" },
  { id: 7, title: "Sourdough", url: "https://example.com/bread" },
];
const prMeta = {
  "acme/pricing#88": { milestone: null, headRef: "pd-1-fix-rounding", ciUrls: [`https://app.circleci.com/workflow/${WF}`] },
  "acme/pricing#90": { milestone: "8.40", headRef: "PD-2-export", ciUrls: ["https://circleci.com/gh/acme/pricing/501"] },
  "acme/docs#12": { milestone: "8.40", headRef: "docs", ciUrls: [] },
};

test("findClusters links a ticket, its PR, and the PR's CircleCI run", () => {
  const clusters = findClusters(tabs.slice(0, 3), { projects, prMeta });
  assert.deepEqual(clusters, [{ tabIds: [1, 2, 3], label: "PD-1" }]);
});

test("findClusters joins PRs sharing a milestone, with their tickets", () => {
  const clusters = findClusters(tabs, { projects, prMeta });
  const sorted = clusters.map((c) => ({ ...c, tabIds: [...c.tabIds].sort() }));
  assert.deepEqual(sorted, [
    { tabIds: [1, 2, 3], label: "PD-1" },
    { tabIds: [4, 5, 6], label: "8.40" },
  ]);
});

test("findClusters leaves milestones out when that option is off", () => {
  const clusters = findClusters(tabs, { projects, prMeta, groupByMilestone: false });
  assert.deepEqual(clusters.map((c) => c.label), ["PD-1", "PD-2"]);
});

test("findClusters works on titles alone without GitHub lookups", () => {
  const clusters = findClusters(tabs, { projects });
  assert.deepEqual(clusters, [{ tabIds: [1, 2], label: "PD-1" }]);
});

test("enforceClusters keeps each cluster in the group holding most of it", () => {
  const groups = [
    { name: "Pricing Fix", tabIds: [1, 2] },
    { name: "CI", tabIds: [3, 9] },
    { name: "Bread", tabIds: [7] },
  ];
  const out = enforceClusters(groups, [
    { tabIds: [1, 2, 3], label: "PD-1" },
    { tabIds: [4, 5], label: "PD-2" },
  ]);
  assert.deepEqual(out, [
    { name: "Pricing Fix", tabIds: [1, 2, 3] },
    { name: "CI", tabIds: [9] },
    { name: "Bread", tabIds: [7] },
    { name: "PD-2", tabIds: [4, 5] },
  ]);
});

test("linkedGroupId finds the group holding most of a tab's linked tabs", () => {
  const live = [
    { id: 1, groupId: 50 },
    { id: 2, groupId: 50 },
    { id: 3, groupId: 60 },
    { id: 4, groupId: -1 },
    { id: 9, groupId: 60 },
  ];
  const clusters = [{ tabIds: [1, 2, 3, 4], label: "PD-1" }];
  assert.equal(linkedGroupId(4, clusters, live), 50);
  assert.equal(linkedGroupId(9, clusters, live), null);
});

test("clusterGroups keeps an existing group's name, else uses the label", () => {
  const live = [
    { id: 1, groupId: 50 },
    { id: 2, groupId: -1 },
    { id: 3, groupId: -1 },
    { id: 4, groupId: -1 },
  ];
  const out = clusterGroups(
    [
      { tabIds: [1, 2], label: "PD-1" },
      { tabIds: [3, 4], label: "PD-2" },
    ],
    live,
    new Map([[50, "Pricing Fix"]]),
  );
  assert.deepEqual(out, [
    { name: "Pricing Fix", tabIds: [1, 2] },
    { name: "PD-2", tabIds: [3, 4] },
  ]);
});

test("tabFacts reports ticket keys and what GitHub said about a PR", () => {
  const meta = { "acme/pricing#88": { state: "MERGED", milestone: "8.40", headRef: "pd-7-fix", ciUrls: [] } };
  assert.deepEqual(tabFacts({ title: "[PD-1] Fix · Pull Request #88", url: "https://github.com/acme/pricing/pull/88" }, { projects, prMeta: meta }), {
    tickets: ["PD-1", "PD-7"],
    pr: { repo: "acme/pricing", state: "MERGED", milestone: "8.40", branch: "pd-7-fix" },
  });
  assert.deepEqual(tabFacts({ title: "Some PR", url: "https://github.com/acme/app/pull/3" }, { projects }), { pr: { repo: "acme/app" } });
  assert.equal(tabFacts({ title: "Sourdough", url: "https://example.com/" }, { projects }), null);
});
