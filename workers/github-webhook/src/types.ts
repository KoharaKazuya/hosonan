import type { ArticlePath } from "@hosonan/shared";

export interface GitHubPushPayload {
  ref?: string;
  repository: {
    owner: {
      login: string;
    };
    name: string;
    full_name: string;
  };
  installation?: {
    id: number;
  };
  commits?: Array<{
    id: string;
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

export type { ArticlePath };
