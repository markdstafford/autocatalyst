export function generateDefaultWorkflow(repoName: string): string {
  return `---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/${repoName}
---

You are working on an idea for the ${repoName} project.

{{ idea.content }}
`;
}
