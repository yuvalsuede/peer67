---
name: peer67:chat
description: Start a chat session with a contact. Usage: /peer67:chat <name>
---

Use ONLY peer67 MCP tools. Do NOT read files or code.

1. Call `peer67_inbox` filtered by the contact name to get recent messages
2. Show any messages with >> prefix
3. Tell the user: "Chatting with [name]. Just type to send."
4. From now on, treat every user message as a message to send to this contact
5. Call `peer67_send` for each user message — NO confirmation, NO drafts
6. Keep checking `peer67_inbox` between messages
7. Stop chat mode when user says "done", "exit", or changes topic
