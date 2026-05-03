export interface GitHubPushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository: {
    id: number;
    owner: {
      login: string;
    };
    name: string;
    full_name: string;
    default_branch?: string;
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
