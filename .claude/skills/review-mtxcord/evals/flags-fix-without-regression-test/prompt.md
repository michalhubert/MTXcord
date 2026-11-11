---
tags: [review-mtxcord]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

fixed the stream hook hanging when discord is slow - the webhook fetches had no timeout. is this ready to commit?
