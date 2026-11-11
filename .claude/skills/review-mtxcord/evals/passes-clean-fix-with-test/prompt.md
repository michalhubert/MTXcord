---
tags: [review-mtxcord]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Fixed the pony names file parsing: a line like `Name |` used to drop the pony instead of using the name as the tag. Can you look over my changes before I push?
