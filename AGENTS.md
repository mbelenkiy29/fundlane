# MCA workspace

Read `WORKSPACE_NAVIGATION.md` for the source map, Linear project, setup, and verification commands. Work in `nextjs-version/` for MCA features; `vite-version/` and root `docs/` are template references. The active app uses Supabase Postgres and Supabase Auth; consult `nextjs-version/README.md` for current setup.

Linear project: https://linear.app/michael-belenkiy/project/mca-1e94b0617388 (`b223a780-3987-440c-8e04-41516a97e69b`). Fetch current issue requirements and dependencies from Linear; historical `SEN-*` references and local status snapshots may be stale.

Linear navigation document: https://linear.app/michael-belenkiy/document/mca-workspace-navigation-and-graphify-agent-guide-58ca18ffe2fb

Run Graphify commands from the workspace root so they use the shared `graphify-out/graph.json`. The initial map is code-only; read prose in `nextjs-version/docs/` and Linear separately. Follow graph results to source and use targeted search if the index is incomplete. After `graphify update .`, run `graphify cluster-only . --no-label` to refresh the report and HTML. See the navigation guide for installation and rebuilding a missing graph.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
