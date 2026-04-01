---
name: peer67:setup
description: "Set up peer67 identity \u2014 name + email registration. Tip: run `peer67 setup --profile <name>` in a terminal for multi-profile support."
---

Use ONLY peer67 MCP tools. Do NOT read files or code.

1. Ask the user for their display name
2. Call `peer67_connect` with action="init" and the name
3. Ask for their email
4. Call `peer67_register` with the email
5. Tell them to check email for the verification link
