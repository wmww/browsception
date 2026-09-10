## Overview
Browsception is a browser extension for running browser tabs within a sub-browser, running under wasm.

## Notes
The `notes/` directory contains your persistent notes about the project state. Create/edit/rename/split/delete notes as needed (without being asked) to keep them correct and maximally useful to you. Keep notes concise, remove parts or whole notes that are unimportant or obvious. Keep `notes/README.md` up to date with an index of what is where.

## Worktrees
Ephemeral worktrees under `.worktrees/` are cheap: `npm test` self-bootstraps a fresh one (or run `node scripts/wt-setup.mjs` first). Never copy or cold-build the engine per-worktree — `scripts/build-engine.sh` compiles your checkout's engine sources against the main checkout's shared build tree, so a coupled engine+JS change lives on one branch. Read `notes/worktrees.md` before touching `engine/`.

## Issues
Issues live in `issues/`. Do not solve them unless asked or the fix falls out of current work. Create/update issues for nontrivial problems discovered during other work. Delete confirmed-solved issues (move still-useful context into notes first).

## Plans
Future plans live in `plans/`. Do not execute them unless asked, or write new plans unless asked. Like issues, delete them and integrate their contents into your notes when they are complete.

## Releases
"Make a release" means follow `notes/releasing.md` step by step. That request is the approval to push and to create the GitHub release; stop and ask whenever a step's check doesn't come out as described.

## Workflow
- This project is agent-built, you own the code.
- Refactor freely as needed. don't trust that existing code/comments/notes are necessarily correct, or existing design decisions are optimal.
- Only git commit when asked.
- Only pull/push when explicitly asked. Git push may hang without user approval.
- Commit to the current branch unless asked, don't make feature branches.
- Do not run code formatting tools unless explicitly asked.
- Keep prose, comments, errors, and commit messages short unless extra detail is genuinely useful.
- Avoid opening windows in the user's desktop, to test, interact with and screenshot GUI apps use the gui-testing skill from https://github.com/wmww/agent-skills.
