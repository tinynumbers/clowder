import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTab, filterSuggestions, findDuplicatesToClose, formatRule, groupForSite, matchRule, parseRules, planRuleAndDomainGroups, siteOf } from "../extension/grouping.js";

test("parseRules reads substring and regex rules, skipping junk", () => {
  const rules = parseRules(`
    # comment
    github.com/decisiv = Work repos, blue
    /localhost:\\d+/ = Local dev
    no equals sign here
    bad = Name, notacolor
  `);
  assert.equal(rules.length, 3);
  assert.equal(rules[0].color, "blue");
  assert.ok(rules[1].regex);
  assert.equal(rules[2].color, undefined);
});

test("matchRule matches host+path substrings and regexes", () => {
  const rules = parseRules("github.com/decisiv = Work\n/localhost:\\d+/ = Dev");
  assert.equal(matchRule(rules, "https://github.com/decisiv/case/pull/1").name, "Work");
  assert.equal(matchRule(rules, "https://github.com/other/repo"), null);
  assert.equal(matchRule(rules, "http://localhost:3000/x").name, "Dev");
});

test("siteOf collapses subdomains and handles country second-level domains", () => {
  assert.equal(siteOf("https://docs.google.com/a"), "google.com");
  assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
  assert.equal(siteOf("chrome://settings"), null);
});

test("planRuleAndDomainGroups applies rules first, then domains over the threshold", () => {
  const tabs = [
    { id: 1, url: "https://github.com/decisiv/a" },
    { id: 2, url: "https://github.com/other/b" },
    { id: 3, url: "https://github.com/other/c" },
    { id: 4, url: "https://news.ycombinator.com/" },
    { id: 5, url: "chrome://newtab" },
  ];
  const { groups, leftovers } = planRuleAndDomainGroups(tabs, parseRules("github.com/decisiv = Work, blue"), 2);
  assert.deepEqual(groups.find((g) => g.name === "Work"), { name: "Work", color: "blue", tabIds: [1] });
  assert.deepEqual(groups.find((g) => g.name === "Github").tabIds, [2, 3]);
  assert.deepEqual(leftovers.map((t) => t.id).sort(), [4, 5]);
});

test("describeTab strips query strings and fragments", () => {
  const d = describeTab({ id: 7, title: "Inbox", url: "https://mail.example.com/x?token=secret#frag" });
  assert.equal(d.url, "https://mail.example.com/x");
});

test("findDuplicatesToClose keeps the most recently loaded copy of each URL", () => {
  const tabs = [
    { id: 1, url: "https://a.com/" },
    { id: 2, url: "https://a.com/" },
    { id: 3, url: "https://a.com/" },
    { id: 4, url: "https://b.com/" },
    { id: 5, url: "https://a.com/#top" },
  ];
  assert.deepEqual(findDuplicatesToClose(tabs, { 1: 300, 2: 100, 3: 200 }).sort(), [2, 3]);
});

test("findDuplicatesToClose falls back to lastAccessed, then tab id", () => {
  const tabs = [
    { id: 1, url: "https://a.com/", lastAccessed: 50 },
    { id: 2, url: "https://a.com/", lastAccessed: 10 },
    { id: 3, url: "https://b.com/" },
    { id: 4, url: "https://b.com/" },
  ];
  assert.deepEqual(findDuplicatesToClose(tabs).sort(), [2, 3]);
});

test("findDuplicatesToClose never closes pinned tabs", () => {
  const tabs = [
    { id: 1, url: "https://a.com/", pinned: true },
    { id: 2, url: "https://a.com/" },
    { id: 3, url: "https://b.com/", pinned: true },
    { id: 4, url: "https://b.com/", pinned: true },
  ];
  assert.deepEqual(findDuplicatesToClose(tabs, { 2: 999 }), [2]);
});

test("groupForSite picks the group holding the most tabs from that site", () => {
  const tabs = [
    { id: 1, groupId: 10, url: "https://github.com/org/a" },
    { id: 2, groupId: 10, url: "https://github.com/org/b" },
    { id: 3, groupId: 20, url: "https://gist.github.com/x" },
    { id: 4, groupId: 20, url: "https://news.ycombinator.com/" },
    { id: 5, groupId: -1, url: "https://github.com/org/c" },
  ];
  assert.equal(groupForSite(tabs, "github.com"), 10);
  assert.equal(groupForSite(tabs, "ycombinator.com"), 20);
  assert.equal(groupForSite(tabs, "example.com"), null);
  assert.equal(groupForSite(tabs, null), null);
});

test("formatRule writes a rule line that parseRules reads back", () => {
  const line = formatRule({ pattern: "github.com/acme", name: "Acme repos", color: "blue" });
  assert.equal(line, "github.com/acme = Acme repos, blue");
  const [rule] = parseRules(line);
  assert.equal(rule.name, "Acme repos");
  assert.equal(formatRule({ pattern: "x.com", name: "X" }), "x.com = X");
});

test("filterSuggestions keeps only new rules that match an open tab", () => {
  const tabs = [
    { url: "https://github.com/acme/api" },
    { url: "https://acme.atlassian.net/browse/PD-1" },
    { url: "http://localhost:3000/" },
  ];
  const suggestions = [
    { pattern: "github.com/acme", name: "Acme repos", color: "blue" },
    { pattern: "acme.atlassian.net", name: "Jira", color: "cyan" },
    { pattern: "/localhost:\\d+/", name: "Local dev", color: "green" },
    { pattern: "gitlab.com/acme", name: "Nope", color: "red" },
    { pattern: "/([/", name: "Bad regex", color: "red" },
    { pattern: "GitHub.com/acme", name: "Duplicate", color: "blue" },
    { pattern: "docs.acme.dev", name: "Dismissed", color: "grey" },
  ];
  const fresh = filterSuggestions(suggestions, {
    rulesText: "ACME.atlassian.net = Tickets",
    pending: [],
    dismissed: ["docs.acme.dev"],
    tabs: [...tabs, { url: "https://docs.acme.dev/x" }],
  });
  assert.deepEqual(fresh.map((s) => s.pattern), ["github.com/acme", "/localhost:\\d+/"]);
});

test("filterSuggestions skips suggestions already pending", () => {
  const fresh = filterSuggestions([{ pattern: "github.com/acme", name: "A", color: "blue" }], {
    rulesText: "",
    pending: [{ pattern: "github.com/acme", name: "A", color: "blue" }],
    tabs: [{ url: "https://github.com/acme/x" }],
  });
  assert.deepEqual(fresh, []);
});

test("filterSuggestions drops rules that would cut across Claude's groups", () => {
  const tabs = [
    { id: 1, url: "https://acme.atlassian.net/browse/PD-1" },
    { id: 2, url: "https://github.com/acme/pricing/pull/88" },
    { id: 3, url: "https://acme.atlassian.net/browse/PD-2" },
    { id: 4, url: "http://localhost:3000/" },
    { id: 5, url: "http://localhost:3001/" },
  ];
  const groups = [
    { name: "Pricing Fix", tabIds: [1, 2] },
    { name: "Case Export", tabIds: [3] },
    { name: "Local Dev", tabIds: [4, 5] },
  ];
  const suggestions = [
    { pattern: "acme.atlassian.net", name: "Jira", color: "cyan" },
    { pattern: "acme.atlassian.net/browse/PD-1", name: "Pricing fix", color: "blue" },
    { pattern: "/localhost:\\d+/", name: "Local Dev", color: "green" },
  ];
  const fresh = filterSuggestions(suggestions, { rulesText: "", tabs, groups });
  assert.deepEqual(fresh.map((s) => s.pattern), ["acme.atlassian.net/browse/PD-1", "/localhost:\\d+/"]);
});
