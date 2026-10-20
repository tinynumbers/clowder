import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTab, findDuplicatesToClose, matchRule, parseRules, planRuleAndDomainGroups, siteOf } from "../extension/grouping.js";

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
