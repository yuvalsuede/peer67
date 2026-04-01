---
name: peer67:send
description: Send an encrypted message to a contact. Usage: /peer67:send <name> <message>
---

Use ONLY the `peer67_send` MCP tool. Do NOT read files or code.

Parse the arguments: first word is contact name, rest is the message.
Call `peer67_send` with `to` and `message`. No draft, no confirmation — just send.
Report: "Sent."

If no arguments provided, ask who to message and what to say.
