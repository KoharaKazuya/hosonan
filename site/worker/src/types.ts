export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  ARTICLES_BUCKET: R2Bucket;
}

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

export interface ArticlePath {
  date: string;
  slug: string;
  path: string;
}
