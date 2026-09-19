# Task 1 report: P04 project home

## What was built

- Added the `project_home` backend module and registered its Tauri commands.
- `project_bootstrap` creates `.flashwork` through a sibling staging directory and atomically
  publishes it with `rename`.
- The generated tree contains versioned `project.json` metadata, harness defaults, RAG defaults,
  and task, flow, and run history directories.
- `project_detect` reads only a regular, non-symlink `project.json`.
- Existing homes with the same project id are filled with missing defaults without overwriting
  existing files.
- Existing homes owned by another project return `flashwork_exists`.
- Path checks reject symlink escapes and non-regular files.

## Important finding fixed

When `.flashwork` already exists without `project.json`, bootstrap now returns
`flashwork_incomplete` instead of filling the directory in place. This preserves atomic
publication: only an absent `.flashwork` is built in staging and renamed into place.

The focused regression test creates an empty `.flashwork`, asserts that bootstrap returns
`flashwork_incomplete`, and verifies that no `project.json` was written. The three original plan
tests remain unchanged.

## TDD and verification evidence

The focused regression is covered by the module test command run after the fix:

```text
cd /home/abner/www/abnerndr/flashwork/apps/orchestrator/src-tauri
cargo test --lib project_home
```

Exact output:

```text
cargo test: 8 passed, 317 filtered out (1 suite, 0.01s)
```

## Files changed across Task 1

- `apps/orchestrator/src-tauri/Cargo.toml`
- `apps/orchestrator/src-tauri/Cargo.lock`
- `apps/orchestrator/src-tauri/src/lib.rs`
- `apps/orchestrator/src-tauri/src/project_home.rs`
- `.superpowers/sdd/task-1-report.md`

## Current fix

- Replaced the in-place missing-metadata branch with a clear `flashwork_incomplete` error.
- Added `bootstrap_refuses_incomplete_existing_project_home`.
