export interface RepoActivityBoundsBucket {
  sourceId: string;
  projectPath: string | null;
  projectKey: string;
  updatedAt: string;
}

export function repoActivityProjectKey(projectPath: string | null): string {
  return projectPath === null ? "null:" : `path:${projectPath}`;
}

export function repoActivityBoundsBucket(sourceId: string, projectPath: string | null, updatedAt: string): RepoActivityBoundsBucket {
  const projectKey = repoActivityProjectKey(projectPath);
  return { sourceId, projectPath, projectKey, updatedAt };
}

export function repoActivityBoundsBucketId(sourceId: string, projectKey: string): string {
  return `${sourceId}\0${projectKey}`;
}
