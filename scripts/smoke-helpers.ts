/* eslint-disable no-console */
/**
 * Quick smoke test for the pure helpers used by Phase 3:
 *   - planeDescription.injectPlanFence
 *   - planeDescription.tickAcceptanceCriteria
 *   - builder.parseProgress
 *
 * Run with: pnpm tsx scripts/smoke-helpers.ts
 */
import { parseProgress } from "../src/builder.ts";
import { parseVerdict } from "../src/e2e.ts";
import {
  injectPlanFence,
  planMarkdownToHtml,
  tickAcceptanceCriteria,
} from "../src/planeDescription.ts";
import { deriveGhRepo, looksLikeInfraFailure } from "../src/vercel.ts";

let failures = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
    if (extra !== undefined) console.log("        ", extra);
  }
}

console.log("\n== injectPlanFence ==");
{
  const empty = injectPlanFence("", "# Plan\n\nHello");
  check("appends fence to empty description", empty.includes("exponential:plan v1 start"));
  check("fence wraps plan markdown converted to html", empty.includes("<h2>Plan</h2>"));

  const withExisting = "<p>Original ask.</p>";
  const out = injectPlanFence(withExisting, "## Phase 1\n\nDo a thing");
  check("preserves original ask", out.startsWith("<p>Original ask.</p>"));
  check("appends fence after original", out.includes("exponential:plan v1 end"));

  const rewritten = injectPlanFence(out, "## Phase 1\n\nDo a different thing");
  check("rewrites inside fence on second pass", rewritten.includes("Do a different thing"));
  check("does not duplicate fence", rewritten.split("exponential:plan v1 start").length === 2);
  check("original ask survives the rewrite", rewritten.startsWith("<p>Original ask.</p>"));
}

console.log("\n== planMarkdownToHtml ==");
{
  const html = planMarkdownToHtml(
    "# Title\n\n## Section\n\n- one\n- two\n\nparagraph with **bold** and `code`",
  );
  check("renders h1 → h2", html.includes("<h2>Title</h2>"));
  check("renders h2 → h3", html.includes("<h3>Section</h3>"));
  check("renders bullets", html.includes("<ul><li>one</li><li>two</li></ul>"));
  check("renders bold", html.includes("<strong>bold</strong>"));
  check("renders code", html.includes("<code>code</code>"));
  check("escapes < and >", planMarkdownToHtml("a < b").includes("a &lt; b"));
}

console.log("\n== tickAcceptanceCriteria (TipTap format) ==");
{
  const html = `<p>Goal: foo</p>
<h2>Acceptance Criteria</h2>
<ul data-type="taskList">
  <li data-checked="false" data-type="taskItem"><div><p>First</p></div></li>
  <li data-checked="false" data-type="taskItem"><div><p>Second</p></div></li>
  <li data-checked="false" data-type="taskItem"><div><p>Third</p></div></li>
</ul>`;
  const result = tickAcceptanceCriteria(html, [1, 3]);
  check("tiptap format detected", result.format === "tiptap");
  check("matched 1 and 3", result.matched.join(",") === "1,3");
  check("skipped is empty", result.skipped.length === 0);
  check("first li now checked",
    /<li[^>]*data-checked="true"[^>]*>\s*<div><p>First/.test(result.html),
    result.html.slice(0, 400),
  );
  check("second li still unchecked",
    /<li[^>]*data-checked="false"[^>]*>\s*<div><p>Second/.test(result.html),
  );
  check("third li now checked",
    /<li[^>]*data-checked="true"[^>]*>\s*<div><p>Third/.test(result.html),
  );
  check("never un-checks", !result.html.includes('data-checked="false" data-type="taskItem"><div><p>First'));
}

console.log("\n== tickAcceptanceCriteria (bare HTML checkboxes) ==");
{
  const html = `<p>Goal</p>
<ul>
  <li><input type="checkbox"> First</li>
  <li><input type="checkbox"> Second</li>
</ul>`;
  const result = tickAcceptanceCriteria(html, [2]);
  check("input format detected", result.format === "input");
  check("only #2 matched", result.matched.join(",") === "2");
  check("second now has checked attribute",
    /<input[^>]*type="checkbox"[^>]*checked[^>]*>\s*Second/.test(result.html) ||
      /<input[^>]*checked[^>]*type="checkbox"[^>]*>\s*Second/.test(result.html),
    result.html,
  );
  check("first input remains unchecked",
    /<input[^>]*type="checkbox"[^>]*>\s*First/.test(result.html) &&
      !/<input[^>]*type="checkbox"[^>]*checked[^>]*>\s*First/.test(result.html),
  );
}

console.log("\n== tickAcceptanceCriteria (markdown fallback) ==");
{
  const html = `<p>- [ ] First</p>
<p>- [ ] Second</p>
<p>- [ ] Third</p>`;
  const result = tickAcceptanceCriteria(html, [2, 3]);
  check("markdown format detected", result.format === "markdown");
  check("two matched", result.matched.length === 2);
  check("first stays unchecked", result.html.includes("[ ] First"));
  check("second is checked", result.html.includes("[x] Second"));
  check("third is checked", result.html.includes("[x] Third"));
}

console.log("\n== tickAcceptanceCriteria (out-of-range / empty / no AC) ==");
{
  const noAc = tickAcceptanceCriteria("<p>nothing here</p>", [1]);
  check("no AC → format none, skipped=[1]", noAc.format === "none" && noAc.skipped.join(",") === "1");
  check("noop on empty index list", tickAcceptanceCriteria("<p>x</p>", []).html === "<p>x</p>");

  const html = `<ul><li><input type="checkbox"> Only one</li></ul>`;
  const result = tickAcceptanceCriteria(html, [1, 5]);
  check("matches in-range, skips out-of-range", result.matched.join(",") === "1" && result.skipped.join(",") === "5");
}

console.log("\n== parseProgress ==");
{
  const sample = `# Build progress

## Phase 1 — Add data attribute

- Status: complete
- Attempts: 1
- Satisfies AC: 1, 2
- Browser check: passed
- Notes: data-plane-issue attribute rendered on landing root

## Phase 2 — Update test snapshot

- Status: complete
- Attempts: 2
- Satisfies AC: none
- Browser check: skipped
- Notes: regenerated vitest snapshot for landing component

## Phase 3 — Smoke check

- Status: failed
- Attempts: 3
- Satisfies AC: 3
- Browser check: failed
- Notes: dev server returned 500 on /preview
`;
  const phases = parseProgress(sample);
  check("3 phases parsed", phases.length === 3);
  check("phase 1 complete + AC=[1,2]",
    phases[0]!.status === "complete" && phases[0]!.satisfiesAc.join(",") === "1,2",
  );
  check("phase 2 AC=[] (none)", phases[1]!.satisfiesAc.length === 0);
  check("phase 2 attempts=2", phases[1]!.attempts === 2);
  check("phase 3 failed", phases[2]!.status === "failed");
  check("phase 3 browserCheck=failed", phases[2]!.browserCheck === "failed");
  check("notes carry through", phases[0]!.notes.includes("data-plane-issue"));
}

console.log("\n== parseVerdict (E2E) ==");
{
  check("e2e-passed parsed", parseVerdict("e2e-passed\n") === "e2e-passed");
  check("e2e-failed parsed", parseVerdict("  e2e-failed   ") === "e2e-failed");
  check("e2e-blocked parsed", parseVerdict("e2e-blocked extra text") === "e2e-blocked");
  check("trailing junk after newline ignored",
    parseVerdict("e2e-passed\nsome extra commentary") === "e2e-passed");
  check("empty → no-verdict", parseVerdict("") === "no-verdict");
  check("garbage → no-verdict", parseVerdict("hello world") === "no-verdict");
  check("case-insensitive", parseVerdict("E2E-PASSED") === "e2e-passed");
}

console.log("\n== deriveGhRepo ==");
{
  check("https form", deriveGhRepo("https://github.com/foo/bar.git") === "foo/bar");
  check("https without .git", deriveGhRepo("https://github.com/foo/bar") === "foo/bar");
  check("ssh form", deriveGhRepo("git@github.com:foo/bar.git") === "foo/bar");
  check("trailing whitespace", deriveGhRepo("  https://github.com/foo/bar  ") === "foo/bar");
  check("non-github → null", deriveGhRepo("git@gitlab.com:foo/bar.git") === null);
}

console.log("\n== looksLikeInfraFailure ==");
{
  const convexLog = "Running 'npx convex deploy'\n✖ Vercel build environment detected but no Convex deployment configuration found.\nSet CONVEX_DEPLOY_KEY for Convex Cloud deployments";
  check("convex deploy key → infra", looksLikeInfraFailure(convexLog).infra === true);
  check("convex match reports signature",
    looksLikeInfraFailure(convexLog).signature !== null);

  const codeLog = "Type error: Property 'foo' does not exist on type 'Bar'.\n./components/X.tsx:42:10";
  check("type error → not infra", looksLikeInfraFailure(codeLog).infra === false);
  check("type error signature null", looksLikeInfraFailure(codeLog).signature === null);

  const secretLog = "Error: Environment Variable \"API_KEY\" references Secret \"api-key\", which does not exist.";
  check("missing secret → infra", looksLikeInfraFailure(secretLog).infra === true);

  const tokenLog = "Error: The specified token is not valid. Use `vercel login`.";
  check("bad token → infra", looksLikeInfraFailure(tokenLog).infra === true);

  check("empty log → not infra", looksLikeInfraFailure("").infra === false);
}

console.log("");
if (failures === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
