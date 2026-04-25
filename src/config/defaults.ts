export function generateDefaultWorkflow(repoName: string): string {
  return `---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/${repoName}
channels:
  - provider: your-channel-provider
    name: my-channel
    config: {}
publishers:
  - provider: your-artifact-publisher
    artifacts:
      - artifact
    config: {}
---

You are working on an idea for the ${repoName} project.

{{ idea.content }}
`;
}
