/**
 * Helpers for managing the Plane issue description from the orchestrator.
 *
 * Two responsibilities:
 *
 *   1. **Plan fence** — own a `<!-- exponential:plan v1 start --> … <!-- end -->`
 *      block at (or appended to) the end of the description. Everything outside
 *      the fence (the human-authored ask) is never touched.
 *
 *   2. **AC checkoff** — toggle the relevant Acceptance Criteria checkboxes
 *      from unchecked → checked when a phase finishes building green. We
 *      support TipTap-style task lists (`<li data-checked="false">`), bare
 *      HTML checkboxes (`<input type="checkbox">`), and markdown-style
 *      `- [ ]` text as a fallback.
 *
 * Both operations work on raw HTML strings — we deliberately avoid a real
 * HTML parser so the user's existing formatting survives byte-for-byte.
 */

const FENCE_START = "<!-- exponential:plan v1 start -->";
const FENCE_END = "<!-- exponential:plan v1 end -->";

export interface TickResult {
  html: string;
  matched: number[];
  /** AC indices that were requested but not present in the description. */
  skipped: number[];
  format: "tiptap" | "input" | "markdown" | "none";
}

/**
 * Insert or replace the plan inside the sentinel fence. The fence and its
 * contents are the only bytes the orchestrator owns; everything else in
 * `currentHtml` stays untouched. The plan is rendered to a small HTML subset
 * for readability inside Plane.
 */
export function injectPlanFence(
  currentHtml: string,
  planMarkdown: string,
): string {
  const planHtml = planMarkdownToHtml(planMarkdown);
  const fencedBlock = `${FENCE_START}\n${planHtml}\n${FENCE_END}`;

  const startIdx = currentHtml.indexOf(FENCE_START);
  const endIdx = currentHtml.indexOf(FENCE_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = currentHtml.slice(0, startIdx);
    const after = currentHtml.slice(endIdx + FENCE_END.length);
    return `${before}${fencedBlock}${after}`;
  }

  const base = currentHtml.trim();
  if (base.length === 0) {
    return fencedBlock;
  }
  return `${base}\n${fencedBlock}`;
}

/**
 * Toggle AC checkboxes at the given 1-based indices to `checked`.
 * Never un-checks anything already checked.
 *
 * Returns the new html, the indices that were matched, and any that were
 * requested but not present (out of range / no checkbox there).
 */
export function tickAcceptanceCriteria(
  currentHtml: string,
  acIndices: number[],
): TickResult {
  if (acIndices.length === 0) {
    return { html: currentHtml, matched: [], skipped: [], format: "none" };
  }
  const wanted = new Set(acIndices);

  // Try TipTap task-item format first.
  const tipTap = [
    ...currentHtml.matchAll(/<li\b[^>]*\bdata-checked="(true|false)"[^>]*>/gi),
  ];
  if (tipTap.length > 0) {
    return tickByReplace(currentHtml, tipTap, wanted, acIndices, "tiptap", (match) => {
      // Flip data-checked="false" → data-checked="true".
      return match[0].replace(/data-checked="false"/i, 'data-checked="true"');
    });
  }

  // Bare HTML checkboxes.
  const inputs = [
    ...currentHtml.matchAll(/<input\b[^>]*\btype="checkbox"[^>]*>/gi),
  ];
  if (inputs.length > 0) {
    return tickByReplace(currentHtml, inputs, wanted, acIndices, "input", (match) => {
      const tag = match[0];
      if (/\bchecked\b/i.test(tag)) return tag;
      // Insert ` checked` right before the closing `>` (or `/>` for self-close).
      return tag.replace(/\/?>$/i, (close) => ` checked${close}`);
    });
  }

  // Markdown-style `- [ ]` / `* [ ]` fallback. These can appear inside <p> or
  // <pre> blocks if the description was authored as raw markdown.
  const mdMatches = [...currentHtml.matchAll(/(^|\n|>)([\s]*[-*][\s]+)\[ \]/gim)];
  if (mdMatches.length > 0) {
    return tickByReplace(
      currentHtml,
      mdMatches,
      wanted,
      acIndices,
      "markdown",
      (match) => `${match[1]}${match[2]}[x]`,
    );
  }

  return {
    html: currentHtml,
    matched: [],
    skipped: acIndices,
    format: "none",
  };
}

function tickByReplace(
  currentHtml: string,
  matches: RegExpMatchArray[],
  wanted: Set<number>,
  requested: number[],
  format: TickResult["format"],
  flip: (m: RegExpMatchArray) => string,
): TickResult {
  // We rebuild the string by walking matches in order so we can splice each
  // one at its actual position. Using string.replace with an index-aware
  // callback would also work but this stays easier to reason about.
  const matched: number[] = [];
  let cursor = 0;
  let out = "";
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const oneBased = i + 1;
    const start = m.index ?? 0;
    out += currentHtml.slice(cursor, start);
    if (wanted.has(oneBased)) {
      out += flip(m);
      matched.push(oneBased);
    } else {
      out += m[0];
    }
    cursor = start + m[0].length;
  }
  out += currentHtml.slice(cursor);

  const skipped = requested.filter((idx) => !matched.includes(idx));
  return { html: out, matched, skipped, format };
}

/**
 * Render a small subset of markdown (headings, lists, paragraphs, bold, code)
 * to HTML. Intentionally tiny: just enough to make the plan readable inside
 * Plane's description.
 */
export function planMarkdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  let out = "";
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out += "</ul>";
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") {
      closeList();
      continue;
    }
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    const h3 = /^### (.+)$/.exec(line);
    const li = /^[-*] (.+)$/.exec(line);
    if (h1) {
      closeList();
      out += `<h2>${formatInline(h1[1]!)}</h2>`;
    } else if (h2) {
      closeList();
      out += `<h3>${formatInline(h2[1]!)}</h3>`;
    } else if (h3) {
      closeList();
      out += `<h4>${formatInline(h3[1]!)}</h4>`;
    } else if (li) {
      if (!inList) {
        out += "<ul>";
        inList = true;
      }
      out += `<li>${formatInline(li[1]!)}</li>`;
    } else {
      closeList();
      out += `<p>${formatInline(line)}</p>`;
    }
  }
  closeList();
  return out;
}

function formatInline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const __fenceMarkersForTesting = { FENCE_START, FENCE_END };
