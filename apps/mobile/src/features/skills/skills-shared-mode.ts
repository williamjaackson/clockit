import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Repository-file mode is opt-in per project and lasts until the app closes.
 * Projects start private, and the first switch for each project asks once.
 */
const sharedProjects = new Set<string>();
const confirmedProjects = new Set<string>();

function projectKey(environmentId: EnvironmentId, projectPath: string): string {
  return JSON.stringify([environmentId, projectPath]);
}

export function readSharedMode(environmentId: EnvironmentId, projectPath: string) {
  const key = projectKey(environmentId, projectPath);
  return { shared: sharedProjects.has(key), confirmed: confirmedProjects.has(key) };
}

export function saveSharedMode(environmentId: EnvironmentId, projectPath: string, shared: boolean) {
  const key = projectKey(environmentId, projectPath);
  if (shared) {
    sharedProjects.add(key);
    confirmedProjects.add(key);
  } else {
    sharedProjects.delete(key);
  }
}
