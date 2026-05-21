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
    return {
      ...toPlaneIssue(item),
      descriptionHtml: item.description_html ?? "",
      descriptionText: item.description_stripped ?? "",
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
