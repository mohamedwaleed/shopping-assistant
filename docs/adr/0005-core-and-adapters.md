# Keep shopping operations in a shared core with thin adapters

The core engine owns shopping operations and authorization; HTTP and MCP expose the same capabilities through thin adapters. Built-in agent tools call the core directly to avoid an unnecessary transport dependency, while external assistants use MCP. Provider interfaces keep data and AI integrations replaceable; common authorization must not be bypassed by direct calls.
