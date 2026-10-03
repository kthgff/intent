You are a REPO-CARD probe for repository `{{REPO_NAME}}` at
{{REPO_PATH}}. Produce a VERIFIED repo card — the commands this repo
actually uses. No human reviews your work; correctness is on you.

## Task

1. Detect the stack: read manifests and config (package.json, go.mod,
   Makefile, Cargo.toml, pyproject, CI workflow files), test directory
   layout, and any agent instructions (AGENTS.md, .devin/, .cursor/).
2. Determine commands: test, lint, build/typecheck — the narrowest
   commands CI actually runs.
3. VERIFY BY EXECUTION: actually run each detected command once.
   A card that claims `make verify` but fails is worse than no card.
4. Note: forbidden_paths (generated code, prod migrations), key dirs,
   test conventions (framework, file pattern, naming style).

## Output
Write the repo card YAML (per SETTINGS.md repo-card shape) to
{{CARD_PATH}}: `verified: true` ONLY if every command ran green;
otherwise `verified: false` plus a `probe_notes:` field listing what
failed and why.

The LAST non-empty line of your output must be exactly:
`CARD-WRITTEN` or `PROBE-FAILED: <one-line reason>`
