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

export interface GitHubAccountPayload {
  id: number;
  login: string;
  type?: string;
}

export interface GitHubRepositoryPayload {
  id: number;
  owner?: {
    login: string;
  };
  name: string;
  full_name?: string;
  default_branch?: string | null;
  visibility?: string;
  private?: boolean;
  archived?: boolean;
}

export interface GitHubInstallationPayload {
  id: number;
  account?: GitHubAccountPayload;
}

export interface GitHubInstallationEventPayload {
  action?: string;
  installation: GitHubInstallationPayload;
  repositories?: GitHubRepositoryPayload[];
}

export interface GitHubInstallationRepositoriesPayload {
  action?: string;
  installation: GitHubInstallationPayload;
  repositories_added?: GitHubRepositoryPayload[];
  repositories_removed?: GitHubRepositoryPayload[];
}

export interface GitHubRepositoryEventPayload {
  action?: string;
  installation?: GitHubInstallationPayload;
  repository: GitHubRepositoryPayload;
}

export interface GitHubInstallationTargetPayload {
  action?: string;
  installation?: GitHubInstallationPayload;
  account?: GitHubAccountPayload;
  changes?: {
    login?: {
      from?: string;
    };
  };
}

export interface GitHubMetaPayload {
  hook_id?: number;
}
