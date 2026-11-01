#!/usr/bin/env node
// agentkit: run an agent described by agent.yaml (docs/agentkit.md).
//   agentkit run <agent> [--once "<input>"] [--port N]   triggers, chat page, API and A2A; or one run
//   agentkit acp <agent>                                  ACP on stdio
//   agentkit mcp <agent>                                  MCP on stdio (one tool: ask_<name>)
//   agentkit check <agent>                                validate agent.yaml
//   agentkit init <folder>                                a starter agent to edit
import { main } from '../src/agentkit/cli.js';

main(process.argv.slice(2));
