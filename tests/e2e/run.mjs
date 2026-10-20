// End-to-end tests: loads Clowder into Chrome for Testing, opens tabs on fake
// copies of GitHub, Jira and CircleCI, runs each action the way the popup does,
// and checks the tab groups that result. Uses the real native helper, so GitHub
// lookups go through your gh login and the Claude test makes one Claude call.
//
//   npm run setup    once, to download Chrome for Testing
//   npm test         HEADFUL=1 npm test to watch it
//   npm test -- auto only run scenarios whose name contains "auto"

import { getInstalledBrowsers } from "@puppeteer/browsers";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startFakeSites } from "./fake-sites.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(HERE, "../../extension");
const ID = "eehdejcmldpmhkcefkkhgicgcnapajdl";
const HOST = "com.clowder_tabs.host";
const HOST_MANIFEST = join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts", `${HOST}.json`);

const J1 = "https://decisiv.atlassian.net/browse/PD-5872";
const PR1 = "https://github.com/Decisiv/pricing/pull/21248";
const PR2 = "https://github.com/Decisiv/pricing/pull/21247/files";
const J2 = "https://decisiv.atlassian.net/browse/PD-5767";
const J3 = "https://decisiv.atlassian.net/browse/PD-9999";
const RAILS = "https://github.com/rails/rails/issues/4";
const GUIDE = "https://guides.rubyonrails.org/active_record_callbacks.html";
const BREAD1 = "https://www.seriouseats.com/sourdough";
const BREAD2 = "https://www.kingarthurbaking.com/recipes/focaccia";
let CI; // a CircleCI tab for PR1's real latest workflow, found at startup

const BASE_SETTINGS = {
  autoGroup: false,
  useClaudeForUnmatched: false,
  joinGroupsAcrossWindows: false,
  manualScope: "window",
  githubLookups: false,
  groupByMilestone: true,
  jiraProjects: "",
  rules: "",
};

let ctl; // an extension page, so chrome.* APIs can be called from the test
const x = (fn, ...args) => ctl.evaluate(fn, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

const allLoaded = (tabs) => tabs.every((t) => t.status === "complete" && t.title);

async function openWindow(urls) {
  const windowId = await x(async (urls) => (await chrome.windows.create({ url: urls, focused: false })).id, urls);
  await waitFor("tabs to load", async () => {
    const tabs = await x((id) => chrome.tabs.query({ windowId: id }), windowId);
    return tabs.length === urls.length && allLoaded(tabs);
  });
  return windowId;
}

async function openTab(windowId, url) {
  const id = await x(async ([windowId, url]) => (await chrome.tabs.create({ windowId, url, active: true })).id, [windowId, url]);
  await waitFor("tab to load", async () => allLoaded([await x((id) => chrome.tabs.get(id), id)]));
  return id;
}

// Every tab with its window and group name (null when ungrouped).
async function layout() {
  return x(async () => {
    const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
    return (await chrome.tabs.query({})).map((t) => ({
      id: t.id,
      url: t.url,
      windowId: t.windowId,
      groupId: t.groupId,
      group: t.groupId === -1 ? null : groups.get(t.groupId),
    }));
  });
}

const tabFor = (tabs, url) => tabs.find((t) => t.url === url);
const groupOf = (tabs, url) => tabFor(tabs, url)?.group ?? null;
const together = (tabs, urls) => {
  const ids = urls.map((u) => tabFor(tabs, u)?.groupId);
  return ids[0] !== undefined && ids[0] !== -1 && ids.every((id) => id === ids[0]);
};
const describe = (tabs, urls) => urls.map((u) => `${u.split("/").slice(-2).join("/")} in ${JSON.stringify(groupOf(tabs, u))}`).join("; ");

const run = (cmd, windowId) => x(([cmd, windowId]) => chrome.runtime.sendMessage({ cmd, windowId }), [cmd, windowId]);

let windows = [];
async function reset(settings = {}) {
  for (const id of windows) await x((id) => chrome.windows.remove(id).catch(() => {}), id);
  windows = [];
  await x(async (s) => {
    await chrome.storage.sync.set(s);
    await chrome.storage.local.clear();
  }, { ...BASE_SETTINGS, ...settings });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
}

// ---- Scenarios ----

const SCENARIOS = {
  async "group by rules: ticket key links a ticket and its PR"() {
    await reset();
    const win = await openWindow([J1, PR1, PR2, J2, RAILS, GUIDE, BREAD1, BREAD2]);
    windows.push(win);
    const reply = await run("groupByRules", win);
    const tabs = await layout();
    check("action succeeded", reply.ok, reply.message);
    check("PD-5872 ticket and PR share a group", together(tabs, [J1, PR1]), describe(tabs, [J1, PR1]));
    check("that group is named PD-5872", groupOf(tabs, J1) === "PD-5872", describe(tabs, [J1]));
    check("other GitHub tabs form a site group", together(tabs, [PR2, RAILS]) && groupOf(tabs, PR2) === "Github", describe(tabs, [PR2, RAILS]));
    check("UTF-8 and SHA-256 in a title link nothing", groupOf(tabs, RAILS) !== "PD-5872", describe(tabs, [RAILS]));
    check("lone tabs stay ungrouped", [J2, GUIDE, BREAD1, BREAD2].every((u) => groupOf(tabs, u) === null), describe(tabs, [J2, GUIDE, BREAD1, BREAD2]));
  },

  async "group by rules with GitHub lookups: branch names and CircleCI runs"() {
    await reset({ githubLookups: true });
    const win = await openWindow([J1, PR1, CI, PR2, J2, RAILS, BREAD1]);
    windows.push(win);
    const reply = await run("groupByRules", win);
    const tabs = await layout();
    check("action succeeded without a lookup warning", reply.ok && !/GitHub/.test(reply.message), reply.message);
    check("CircleCI run joins its PR and ticket", together(tabs, [J1, PR1, CI]), describe(tabs, [J1, PR1, CI]));
    check("PR with the key only in its branch joins its ticket", together(tabs, [PR2, J2]), describe(tabs, [PR2, J2]));
    check("the two tickets stay in separate groups", tabFor(tabs, J1).groupId !== tabFor(tabs, J2).groupId, describe(tabs, [J1, J2]));
    check("unrelated GitHub tab stays out", groupOf(tabs, RAILS) === null, describe(tabs, [RAILS]));
  },

  async "links outrank rules"() {
    await reset({ githubLookups: true, rules: "decisiv.atlassian.net = Jira, cyan" });
    const win = await openWindow([J1, PR1, J3]);
    windows.push(win);
    await run("groupByRules", win);
    const tabs = await layout();
    check("linked ticket stays with its PR", together(tabs, [J1, PR1]), describe(tabs, [J1, PR1]));
    check("unlinked ticket follows the rule", groupOf(tabs, J3) === "Jira", describe(tabs, [J3]));
  },

  async "organize with Claude keeps linked tabs together"() {
    await reset({ githubLookups: true });
    const win = await openWindow([J1, PR1, CI, PR2, J2, RAILS, GUIDE, BREAD1, BREAD2]);
    windows.push(win);
    const reply = await run("organizeWithClaude", win);
    const tabs = await layout();
    console.log(`    Claude: ${reply.message}`);
    for (const t of tabs.filter((t) => t.windowId === win)) console.log(`      ${t.group ?? "(none)"}: ${t.url}`);
    check("action succeeded", reply.ok, reply.message);
    check("ticket, PR and CircleCI run share a group", together(tabs, [J1, PR1, CI]), describe(tabs, [J1, PR1, CI]));
    check("branch-linked PR shares a group with its ticket", together(tabs, [PR2, J2]), describe(tabs, [PR2, J2]));
    check("the two tasks are separate groups", tabFor(tabs, J1).groupId !== tabFor(tabs, J2).groupId, describe(tabs, [J1, J2]));
    check("baking tabs are grouped together", together(tabs, [BREAD1, BREAD2]), describe(tabs, [BREAD1, BREAD2]));
    check("baking is not mixed with work", ![J1, J2].some((u) => tabFor(tabs, u).groupId === tabFor(tabs, BREAD1).groupId), describe(tabs, [BREAD1, J1, J2]));
  },

  async "auto-group: new tabs join their linked group, unrelated ones don't"() {
    await reset({ autoGroup: true, githubLookups: true });
    const win = await openWindow([J1, PR1]);
    windows.push(win);
    await waitFor("ticket and PR to be auto-grouped", async () => together(await layout(), [J1, PR1])).catch(() => {});
    let tabs = await layout();
    check("ticket and PR are auto-grouped", together(tabs, [J1, PR1]), describe(tabs, [J1, PR1]));
    await openTab(win, CI);
    await waitFor("CircleCI tab to join", async () => together(await layout(), [J1, PR1, CI])).catch(() => {});
    tabs = await layout();
    check("new CircleCI tab joins its PR's group", together(tabs, [J1, PR1, CI]), describe(tabs, [J1, PR1, CI]));
    await openTab(win, RAILS);
    await sleep(3000);
    tabs = await layout();
    check("unrelated GitHub tab doesn't join the ticket's group", groupOf(tabs, RAILS) !== groupOf(tabs, PR1), describe(tabs, [RAILS, PR1]));
  },

  async "close duplicates keeps the most recently loaded copy"() {
    await reset();
    const win = await openWindow([BREAD1, BREAD1, BREAD2]);
    windows.push(win);
    const [older, newer] = (await layout()).filter((t) => t.url === BREAD1).map((t) => t.id);
    await x((id) => chrome.tabs.reload(id), older);
    await waitFor("reload", async () => allLoaded([await x((id) => chrome.tabs.get(id), older)]));
    await sleep(300);
    const reply = await run("closeDuplicates", win);
    const tabs = await layout();
    const left = tabs.filter((t) => t.url === BREAD1).map((t) => t.id);
    check("one copy closed", reply.ok && left.length === 1, `${reply.message} left=${left}`);
    check("the reloaded copy is the one kept", left[0] === older && !left.includes(newer), `kept ${left}, reloaded ${older}`);
    check("the unique tab is untouched", !!tabFor(tabs, BREAD2), "focaccia tab missing");
  },

  async "all-windows scope gathers linked tabs into the current window"() {
    await reset({ manualScope: "all" });
    const winA = await openWindow([J1, GUIDE]);
    const winB = await openWindow([PR1, BREAD1]);
    windows.push(winA, winB);
    const reply = await run("groupByRules", winA);
    const tabs = await layout();
    check("action succeeded", reply.ok, reply.message);
    check("PR moved over to join its ticket", together(tabs, [J1, PR1]) && tabFor(tabs, PR1).windowId === winA, describe(tabs, [J1, PR1]));
    check("ungrouped tab stays in its window", tabFor(tabs, BREAD1).windowId === winB, "sourdough moved");
  },

  async "cross-window auto-join follows links into another window"() {
    await reset({ autoGroup: true, githubLookups: true, joinGroupsAcrossWindows: true });
    const winA = await openWindow([J1, PR1]);
    windows.push(winA);
    await waitFor("ticket and PR to be auto-grouped", async () => together(await layout(), [J1, PR1])).catch(() => {});
    const winB = await openWindow([BREAD2]);
    windows.push(winB);
    await openTab(winB, CI);
    await waitFor("CircleCI tab to move", async () => together(await layout(), [J1, PR1, CI])).catch(() => {});
    const tabs = await layout();
    check("CircleCI tab moved into its PR's group in the other window", together(tabs, [J1, PR1, CI]) && tabFor(tabs, CI).windowId === winA, describe(tabs, [J1, PR1, CI]));
  },

  async "settings page shows and adds suggested rules"() {
    await reset();
    await x(() => chrome.storage.local.set({ ruleSuggestions: [{ pattern: "/localhost:\\d+/", name: "Local Dev", color: "green" }] }));
    const page = await ctl.browser().newPage();
    await page.goto(`chrome-extension://${ID}/options.html`);
    await page.waitForSelector("#suggestions:not([hidden]) .suggestion");
    const fields = await page.evaluate(() => ["jiraProjects", "githubLookups", "groupByMilestone", "manualScope"].filter((id) => !document.getElementById(id)));
    check("new settings fields are on the page", fields.length === 0, `missing ${fields}`);
    check("suggestion is listed", (await page.$eval(".suggestion code", (c) => c.textContent)) === "/localhost:\\d+/ = Local Dev, green");
    await page.click(".suggestion button");
    await waitFor("rule to save", () => x(async () => (await chrome.storage.sync.get("rules")).rules.includes("Local Dev")));
    const { pending } = await x(async () => ({ pending: (await chrome.storage.local.get("ruleSuggestions")).ruleSuggestions }));
    check("Add saves the rule and clears the suggestion", pending.length === 0, JSON.stringify(pending));
    await page.close();
  },
};

// ---- Runner ----

async function main() {
  const only = process.argv[2];
  const chrome = (await getInstalledBrowsers({ cacheDir: join(HERE, ".cache") })).find((b) => b.browser === "chrome");
  if (!chrome) throw new Error("Chrome for Testing isn't installed. Run: npm run setup");
  if (!existsSync(HOST_MANIFEST)) throw new Error("The native helper isn't installed. Run ../../install.sh");

  const fake = await startFakeSites();
  // A throwaway profile. Chrome reads native host manifests from the profile
  // folder when one is given, so the installed helper is registered there too.
  const profile = mkdtempSync(join(tmpdir(), "clowder-profile-"));
  mkdirSync(join(profile, "NativeMessagingHosts"));
  copyFileSync(HOST_MANIFEST, join(profile, "NativeMessagingHosts", `${HOST}.json`));

  const browser = await puppeteer.launch({
    executablePath: chrome.executablePath,
    headless: !process.env.HEADFUL,
    userDataDir: profile,
    enableExtensions: [EXTENSION],
    pipe: true,
    args: fake.chromeArgs,
  });
  try {
    await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(ID), { timeout: 10000 });
    ctl = await browser.newPage();
    await ctl.goto(`chrome-extension://${ID}/popup.html`);
    for (const p of await browser.pages()) if (p !== ctl) await p.close();

    const lookup = await x((host) => chrome.runtime.sendNativeMessage(host, { mode: "github", prs: [{ owner: "Decisiv", repo: "pricing", number: 21248 }] }), HOST);
    const wf = lookup.prs?.["decisiv/pricing#21248"]?.ciUrls?.map((u) => u.match(/workflow\/([0-9a-f-]{36})/)?.[1]).find(Boolean);
    if (!wf) throw new Error(`Couldn't look up PR 21248's CircleCI workflow: ${JSON.stringify(lookup)}`);
    CI = `https://app.circleci.com/pipelines/github/Decisiv/pricing/1/workflows/${wf}/jobs/1`;

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (only && !name.includes(only)) continue;
      console.log(name);
      try {
        await scenario();
      } catch (err) {
        check("scenario ran", false, err.message);
      }
    }
  } finally {
    await browser.close();
    fake.server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
