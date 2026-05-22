import { PlaneClient } from "@makeplane/plane-node-sdk";
import type {
  PriorityEnum,
  State,
  WorkItemBase,
} from "@makeplane/plane-node-sdk";
import type { Logger } from "./logger.js";

export type Priority = PriorityEnum;

export const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

export interface PlaneIssue {
  id: string;
  sequenceId: number;
  name: string;
  priority: Priority;
  stateId: string;
  updatedAt: Date;
  createdAt: Date;
  projectId: string;
}

export interface PlaneIssueDetail extends PlaneIssue {
  descriptionHtml: string;
  descriptionText: string;
}

export class PlaneApi {
  private readonly client: PlaneClient;

  constructor(
    private readonly logger: Logger,
    private readonly workspaceSlug: string,
    private readonly projectId: string,
    baseUrl: string,
    apiKey: string,
  ) {
    this.client = new PlaneClient({
      baseUrl,
      apiKey,
    });
  }

  async findStateIdByName(name: string): Promise<string> {
    const states = await this.client.states.list(
      this.workspaceSlug,
      this.projectId,
    );
    const results: State[] = Array.isArray(states)
      ? (states as State[])
      : (states.results ?? []);

    const target = name.trim().toLowerCase();
    const match = results.find(
      (s) => s.name?.trim().toLowerCase() === target,
    );
    if (!match) {
      const available = results.map((s) => s.name).join(", ");
      throw new Error(
        `Plane state "${name}" not found in project ${this.projectId}. Available states: ${available}`,
      );
    }
    return match.id;
  }

  async listIssuesByState(stateId: string): Promise<PlaneIssue[]> {
    const issues: PlaneIssue[] = [];
    const limit = 100;
    let offset = 0;

    while (true) {
      const page = await this.client.workItems.list(
        this.workspaceSlug,
        this.projectId,
        { state: stateId, limit, offset },
      );

      for (const item of page.results) {
        issues.push(toPlaneIssue(item));
      }

      if (!page.next_page_results || page.results.length < limit) {
        break;
      }
      offset += limit;
    }

    return issues;
  }

  async retrieveIssue(workItemId: string): Promise<PlaneIssueDetail> {
    const item = await this.client.workItems.retrieve(
      this.workspaceSlug,
      this.projectId,
      workItemId,
    );
    const descriptionHtml = item.description_html ?? "";
    // Plane's API only populates `description_stripped` when an issue is
    // edited through the TipTap UI — issues created or updated via the REST
    // API leave the field entirely missing. Fall back to stripping the HTML
    // ourselves so downstream agents (Planning, Building, E2E) always have a
    // readable description to work with.
    const descriptionTextRaw = item.description_stripped ?? "";
    const descriptionText = descriptionTextRaw.trim().length > 0
      ? descriptionTextRaw
      : stripHtmlToText(descriptionHtml);
    return {
      ...toPlaneIssue(item),
      descriptionHtml,
      descriptionText,
    };
  }

  async postComment(workItemId: string, html: string): Promise<void> {
    await this.client.workItems.comments.create(
      this.workspaceSlug,
      this.projectId,
      workItemId,
      { comment_html: html },
    );
    this.logger.debug({ workItemId }, "posted plane comment");
  }

  async updateDescriptionHtml(
    workItemId: string,
    descriptionHtml: string,
  ): Promise<void> {
    await this.client.workItems.update(
      this.workspaceSlug,
      this.projectId,
      workItemId,
      { description_html: descriptionHtml },
    );
    this.logger.debug({ workItemId }, "updated plane description");
  }

  async updateState(workItemId: string, stateId: string): Promise<void> {
    await this.client.workItems.update(
      this.workspaceSlug,
      this.projectId,
      workItemId,
      { state: stateId },
    );
    this.logger.debug({ workItemId, stateId }, "updated plane state");
  }
}

/**
 * Convert a Plane description_html blob into reasonable plain text.
 * Preserves block-level structure as newlines so headings and list items
 * remain readable; flattens inline formatting. Used as a fallback when
 * Plane's own description_stripped is missing or empty.
 */
function stripHtmlToText(html: string): string {
  if (!html) return "";
  let s = html;
  // Decode named entities we actually emit.
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  };
  // Convert <br>, <li>, </p>, </h*>, </div>, </ol>, </ul> into newlines so the
  // resulting text preserves block structure.
  s = s
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/(p|h[1-6]|li|div|ol|ul|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  for (const [k, v] of Object.entries(entities)) {
    s = s.split(k).join(v);
  }
  return s
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function toPlaneIssue(item: WorkItemBase): PlaneIssue {
  return {
    id: item.id,
    sequenceId: item.sequence_id,
    name: item.name,
    priority: (item.priority ?? "none") as Priority,
    stateId: item.state ?? "",
    updatedAt: toDate(item.updated_at),
    createdAt: toDate(item.created_at),
    projectId: item.project,
  };
}

function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}
