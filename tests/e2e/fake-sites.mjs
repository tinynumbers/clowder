// A local HTTPS server that stands in for GitHub, Jira, CircleCI and a few
// recipe sites. Chrome is pointed at it with --host-resolver-rules, so tabs
// keep their real URLs (which is what Clowder reads) but never leave this
// machine. Each page is just a <title>, set from TITLES or made from the URL.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOSTS = [
  "github.com",
  "decisiv.atlassian.net",
  "app.circleci.com",
  "www.seriouseats.com",
  "www.kingarthurbaking.com",
  "guides.rubyonrails.org",
];

const TITLES = {
  "decisiv.atlassian.net/browse/PD-5872": "[PD-5872] Stop specs comparing unordered id lists with eq - Jira",
  "decisiv.atlassian.net/browse/PD-5767": "[PD-5767] Migrate service_management base controller - Jira",
  "decisiv.atlassian.net/browse/PD-9999": "[PD-9999] Unrelated ticket - Jira",
  "github.com/Decisiv/pricing/pull/21248":
    "[PD-5872] Stop specs comparing unordered id lists with eq by dwd · Pull Request #21248 · Decisiv/pricing",
  // No ticket key in this title: only the PR's branch name links it to PD-5767.
  "github.com/Decisiv/pricing/pull/21247/files":
    "Migrate service_management base controller · Pull Request #21247 · Decisiv/pricing",
  "github.com/Decisiv/pricing/pull/21287":
    "[PD-5951] Remove configured_integration_id from diagnostic qualification identity by dwd · Pull Request #21287 · Decisiv/pricing",
  "github.com/Decisiv/pricing/pull/21288":
    "[PD-5725] Show the same notes in the Case Notes tooltip as in the Notes section · Pull Request #21288 · Decisiv/pricing",
  "github.com/Decisiv/decisiv-claude-tools": "Decisiv/decisiv-claude-tools: Shared Claude Code skills and plugins",
  "github.com/Decisiv/decisiv-claude-tools/pull/42": "Add a worklog skill · Pull Request #42 · Decisiv/decisiv-claude-tools",
  "app.circleci.com/pipelines/github/Decisiv/decisiv-claude-tools/310": "decisiv-claude-tools - CircleCI",
  "github.com/rails/rails/issues/4": "Fix UTF-8 handling in SHA-256 digests · Issue #4 · rails/rails",
  "www.seriouseats.com/sourdough": "Best sourdough recipe",
  "www.kingarthurbaking.com/recipes/focaccia": "Focaccia guide",
  "guides.rubyonrails.org/active_record_callbacks.html": "Rails Guides: Active Record Callbacks",
};

const escape = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startFakeSites() {
  const dir = mkdtempSync(join(tmpdir(), "clowder-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=clowder-test",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const server = createServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const title = TITLES[url.host + url.pathname] || url.host + url.pathname;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>${escape(title)}</title><h1>${escape(title)}</h1>`);
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // Everything not listed fails to resolve, so the test browser stays offline.
  const rules = [...HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`), "MAP * ~NOTFOUND"].join(", ");
  return { server, chromeArgs: [`--host-resolver-rules=${rules}`, "--ignore-certificate-errors"] };
}
