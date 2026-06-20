---
name: dev-all
description: "Process issues sequentially: /dev per issue in isolated sub-agent → CI wait → merge → next"
argument-hint: "[issue numbers, e.g. #42 #43 #44, or empty for all open issues]"
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Bash(git checkout:*)
  - Bash(git pull:*)
  - Bash(git log:*)
  - Bash(git status)
  - Bash(git branch:*)
  - Bash(gh pr create:*)
  - Bash(gh pr merge:*)
  - Bash(gh pr view:*)
  - Bash(gh pr checks:*)
  - Bash(gh issue view:*)
  - Bash(gh issue list:*)
  - Glob
  - Grep
  - Read
  - Agent
  - Skill
  - TaskCreate
  - TaskUpdate
  - TaskList
  - TaskGet
  - AskUserQuestion
---

# /dev-all — Sequential Issue Processing

Process multiple GitHub Issues sequentially. Each issue runs `/dev` in an isolated sub-agent, then waits for CI and merges before proceeding to the next.

**Arguments:** $ARGUMENTS

## Why Per-Issue (not Single Branch)?

Each issue gets its own branch, PR, and merge cycle:
- **Clean git history**: each PR is atomic and reviewable
- **CI validates each change independently**
- **Merge conflicts are impossible**: each issue starts from latest main
- **Rollback is easy**: revert a single PR, not a batch

---

## Step 0: Core Value Check (GATE)

1. Read the project's `CLAUDE.md` and look for `## Core Values` section
2. **If missing**: Warn the user that Core Values are undefined. Ask if they want to:
   - Define Core Values now (recommended)
   - Proceed without the filter (not recommended — risk of feature bloat)
3. If user chooses to proceed without, log a warning in the final report

---

## Step 1: Resolve Target Issues

**If `$ARGUMENTS` is provided:** Extract issue numbers.
**If empty:** Fetch all open issues:
```bash
gh issue list --state open --json number,title,labels,body --limit 100
```

### 1a. Filter Issues

- **Skip issues labeled `won't`** — these are explicitly decided not to implement
- **Skip issues listed in CLAUDE.md `## Won't Do`** — cross-reference issue titles

---

## Step 2: Parallel Investigation (Read-Only)

Launch **parallel Explore agents** (one per issue) to quickly understand scope:

Each agent:
1. `gh issue view {NUMBER} --json title,body,labels,comments`
2. Grep/Glob to find related code
3. Return: summary, affected files, estimated scope, dependencies

---

## Step 3: Dependency Analysis & Order

### 3a. Detect Dependencies
Check issue bodies for: `blocked by #N`, `depends on #N`, `after #N`

### 3b. Execution Order
Topological sort:
1. Independent issues first (ascending by number)
2. Dependent issues after their dependencies
3. Circular dependencies → skip, report

---

## ── AskUserQuestion: Execution Plan ──

Present:
1. Ordered list of issues
2. Dependencies detected
3. Skipped issues (with reasons — including `won't` label and Won't Do matches)
4. Estimated scope per issue
5. **Core Value alignment per issue** (if Core Values are defined)

Ask user to confirm before proceeding.

---

## Step 4: Sequential Issue Loop

Create a master task tracker:
```
TaskCreate for each issue: "#{number}: {title}"
```

### For each issue (in order):

#### 4a. Pull latest main
```bash
git checkout main && git pull origin main
```

#### 4a-design. Design Gate — Codex MCP (new shared patterns only)

**Before implementing an issue that introduces a NEW shared pattern** (foundation module, new architecture, a template that later issues will copy), verify the design **once** with Codex MCP (`ToolSearch("select:mcp__codex__codex")`), per `rules/ai-ops.md` step 5.

- Run it **once per new pattern**, not per issue. The first issue of a foundation set (e.g. the first `engine/` shared module **for a given engine**) gets a Codex design check; the siblings that copy the established pattern **skip** Codex. Each engine's foundation is its own pattern (different lifecycle APIs), so re-verify once per engine.
- Feed the Codex pitfalls forward: bake them into the implementer sub-agent's prompt (4b) and into the review checklist (4b-review).
- Pure existing-pattern issues, small fixes, naming → **skip** Codex. Codex is for design, not fact lookup.

#### 4b. Run /dev in isolated sub-agent (autonomous via /goal)
```
Agent(
  prompt: "/goal 'Issue #{issue_number} is resolved: tests pass, review has no Critical findings, and PR is created' /dev #{issue_number}",
  model: "opus",
  isolation: "worktree"
)
```

The sub-agent:
- Gets a fresh context (no pollution from previous issues)
- Works in an isolated git worktree (no file conflicts)
- Runs the full /dev workflow autonomously via /goal
- Skips AskUserQuestion confirmations (proceeds with best judgment)
- Returns: structured result with PR URL, review status, and counts

#### 4b-result. Review Validation

After the sub-agent completes, validate the result before proceeding to merge:

1. Read `workspace/{issue}/review.json` to get the structured review output
2. Parse the sub-agent's return value for review status

**Decision logic:**

| Review Status | Action |
|---------------|--------|
| `critical` (critical_count > 0) | **Skip this issue.** Report to user: "#{issue} has {N} critical findings — skipping." Mark task as failed. Proceed to next issue. |
| `warnings` (warning_count > 0) | **Report to user.** `AskUserQuestion`: "#{issue} PR has {N} unresolved warnings. Merge anyway?" If yes → proceed. If no → skip. |
| `clean` | **Proceed to auto-merge.** |
| Sub-agent failed (`status: "failed"`) | **Skip this issue.** Report failure reason. Proceed to next issue. |

#### 4b-review. Independent review gate (MANDATORY, every PR)

The sub-agent's own self-review is **not** sufficient. Before merging, run an **independent** review on the PR diff:

- Spawn a fresh review sub-agent (or invoke `/code-review` / the `review` skill) against `origin/main...origin/{branch}` for the PR's subdir.
- Include any Codex pitfalls from 4a-design as explicit checks for this engine/pattern.
- Apply the same severity decision table as 4b-result: **Critical → skip/fix**, **Warning → report (autonomous: best-judgment; interactive: ask)**, **clean → merge**.
- Fix-then-merge is allowed: if the review finds a Critical/Warning that is cheap to fix, fix it in the worktree (or via a follow-up sub-agent), re-verify build green, then merge.

#### 4c. Merge

```bash
gh pr merge {PR_URL} --auto --merge --delete-branch   # when CI + auto-merge are enabled
```

**If the repo has no CI workflow or auto-merge is disabled** (`gh api repos/{owner}/{repo} --jq .allow_auto_merge` → `false`): the sub-agent's local build-green + the 4b-review gate ARE the validation. Merge directly:

```bash
gh pr merge {PR_URL} --merge --delete-branch
git checkout main && git pull origin main --ff-only
git worktree remove .claude/worktrees/agent-{id} --force   # clean up the issue's worktree
```

> **Committed-doc caveat:** any change you make to repo files OUTSIDE an issue worktree (e.g. editing this skill, rules, or docs on `main`) must be **committed promptly on its own branch+PR**. A later worktree sub-agent may reset the shared checkout to clean `main` and silently discard uncommitted changes.

#### 4d. Wait for merge
Poll until merged (check every 30 seconds, timeout 15 minutes):
```bash
STATE=$(gh pr view {PR_URL} --json state -q '.state')
```

If CI fails:
1. Report the failure to user
2. Ask: skip this issue and continue, or stop?

#### 4e. Mark task completed and proceed

---

## Step 5: Final Report

```
## Batch Development Summary

| # | Issue | PR | Status |
|---|-------|----|--------|
| 1 | #{42} Title | PR_URL | Merged |
| 2 | #{43} Title | PR_URL | Merged |
| 3 | #{44} Title | — | Skipped (CI failed) |

Completed: N / M issues
```

Mark all tasks `completed`.

---

## Autonomous Mode (/goal)

When the user invokes `/dev-all` with `/goal`, the entire batch runs autonomously:

```
/goal "All issues in $ARGUMENTS are resolved: each has a merged PR or a documented skip reason"
```

In autonomous mode:
- Skip `AskUserQuestion` confirmations — proceed with best judgment
- On CI failure: skip the issue and continue (don't stop)
- Stop only on 3 consecutive failures
- **The gates still run.** "Skip confirmations" means skip the user prompts, NOT skip the gates: the 4a-design Codex check (new patterns) and the 4b-review independent review are MANDATORY in autonomous mode too. On a Warning, exercise best judgment instead of asking; never skip the review itself.

## Error Handling

| Situation | Action |
|-----------|--------|
| Issue not found | Skip, warn in report |
| Circular dependency | Skip affected issues, report |
| Sub-agent /dev fails | Ask user: skip or stop |
| CI fails | Ask user: skip or stop |
| Merge conflict | Ask user: skip or stop |
| 3 consecutive failures | Stop, report to user |
| Auto-merge timeout (15min) | Report, ask user |
