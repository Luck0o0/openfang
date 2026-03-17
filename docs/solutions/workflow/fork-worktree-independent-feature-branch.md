---
title: Independent Feature Branch Development with Git Worktrees and Fork Workflow
category: workflow
date: 2026-03-16
tags: [git, worktree, fork, rebase, upstream, branch-management]
symptoms: Developer needs to work on a long-lived feature branch independently from an upstream main branch they do not control, without being blocked by third-party updates, while retaining the ability to push/PR their work.
components: [git, git-worktree, github-fork]
severity: low
solved: true
---

# Independent Feature Branch with Git Worktree + Fork Workflow

## Problem

When contributing to a third-party open-source project, developers face a structural constraint: they cannot push directly to the upstream repository. Long-lived feature branches compound this problem because they must stay synchronized with ongoing upstream changes across multiple development sessions — without polluting the feature branch history with unnecessary merge commits.

**Symptoms:**
- `git push` fails with "Authentication failed" or "No anonymous write access"
- Upstream `main` receives commits that could conflict with your in-progress feature work
- Cloning the repo a second time wastes disk and creates out-of-sync history

---

## Solution

### Root Cause / Motivation

The two-part solution combines **Git Worktrees** (for parallel, isolated working directories) with **Fork Remote Configuration** (for controlled push/pull targeting) to achieve clean, maintainable feature development alongside an upstream you do not own.

---

### Step 1: Create a Git Worktree for Isolated Feature Development

Git worktrees allow two working directories to share the same `.git` object store and history, eliminating the need to clone the repository a second time.

```bash
# Run from the main repository directory
git worktree add ../openfang-user-isolation -b feature/user-session-isolation
```

After this command you have two independent working trees:

- `/workspace/openfang` — tracks `main` branch (upstream-facing)
- `/workspace/openfang-user-isolation` — tracks `feature/user-session-isolation` (your feature work)

Both directories share the same `.git` history. Switching between them requires no `git stash` or `git checkout` — they are fully independent working trees. Confirm with:

```bash
git worktree list
# /workspace/openfang                  abc1234 [main]
# /workspace/openfang-user-isolation   def5678 [feature/user-session-isolation]
```

---

### Step 2: Configure Fork Remote

Remotes are shared across all worktrees. Rename the current `origin` (which points to the upstream you cannot push to) and add your fork as the new `origin`.

```bash
# Rename the upstream project remote
git remote rename origin upstream

# Add your fork as the pushable origin
git remote add origin https://github.com/YourUsername/openfang.git

# Verify
git remote -v
# origin    https://github.com/YourUsername/openfang.git (fetch)
# origin    https://github.com/YourUsername/openfang.git (push)
# upstream  https://github.com/ThirdParty/openfang.git (fetch)
# upstream  https://github.com/ThirdParty/openfang.git (push)
```

---

### Step 3: Push the Feature Branch to Your Fork

```bash
git push -u origin feature/user-session-isolation
```

The `-u` flag sets the upstream tracking reference so subsequent `git push` and `git pull` commands in this worktree target `origin/feature/user-session-isolation` by default.

---

### Step 4: Sync with Upstream Updates

When the upstream `main` branch receives new commits, incorporate them into your feature branch using `rebase` rather than `merge`:

```bash
# Fetch the latest upstream state (no automatic merge)
git fetch upstream

# Replay your feature commits on top of the updated upstream/main
git rebase upstream/main

# If conflicts arise during rebase, resolve each file, then continue:
git rebase --continue

# Push the rebased branch (history was rewritten, so force-push is required)
git push origin feature/user-session-isolation --force-with-lease
```

---

### Why `rebase` Is Preferred Over `merge` Here

| Concern | `merge` | `rebase` |
|---|---|---|
| History shape | Creates a merge commit on every sync | Keeps a linear history — feature commits appear on top of the latest upstream |
| Pull request clarity | PR diff includes merge noise | PR diff shows only your changes |
| `bisect` / `blame` accuracy | Merge commits obscure authorship | Each commit maps directly to a logical change |
| Long-lived branches | History grows tangled over many syncs | History stays clean regardless of sync frequency |
| Force-push safety | Not needed | `--force-with-lease` aborts if remote has unseen commits |

Because a long-lived branch must track an actively-maintained upstream across multiple sessions, `rebase` prevents the accumulation of synthetic merge commits that make the eventual PR harder to review.

---

## Common Pitfalls

1. **Pushing to upstream instead of origin.** Always specify the remote explicitly: `git push origin <branch>`. Confirm with `git branch -vv` that your branch tracks `origin/<branch>`, not `upstream/<branch>`.

2. **Rebasing with a dirty working tree.** Always run `git stash` or commit before rebasing. Confirm with `git status` first.

3. **Forgetting to `fetch upstream` before rebasing.** `git rebase upstream/main` against a stale local ref means rebasing onto an old base. Always `git fetch upstream` immediately before the rebase.

4. **Worktree path confusion — committing on the wrong branch.** When multiple worktrees are active, terminal sessions can drift. Run `git branch --show-current` at the start of every session to verify which branch you're on.

5. **Unresolved rebase conflicts followed by force-push.** After resolving conflicts, verify the build compiles before `git rebase --continue`. A broken resolution in the history is painful to undo.

---

## Best Practices Checklist

- [ ] Fork the upstream repository on GitHub/GitLab before configuring remotes
- [ ] `git remote rename origin upstream` — rename upstream to prevent accidental push
- [ ] `git remote add origin <your-fork-url>` — add your writable fork as origin
- [ ] `git remote -v` — verify both remotes are registered correctly
- [ ] `git worktree add ../<dir> -b <feature>` — create isolated working directory
- [ ] `git push -u origin <feature>` — set tracking ref on first push
- [ ] `git branch --show-current` — confirm branch at start of every session
- [ ] Keep your fork's `main` in sync separately: `git checkout main && git merge upstream/main && git push origin main`

---

### When to Rebase vs When to Merge

**Use rebase** when:
- Your branch is not yet shared publicly (or only shared to your own fork)
- You want linear history for a clean PR diff
- Routine maintenance — staying current during active development

**Use merge** when:
- The branch has collaborators who have based work on it (rebasing rewrites commits and forces others to reset)
- You want an explicit record of when you synchronized with upstream
- Upstream divergence is large and you need to inspect the combined state first

---

## Verifying Your Setup

```bash
# 1. Confirm both remotes are registered
git remote -v

# 2. Confirm the feature branch tracks origin, not upstream
git branch -vv
# Look for: [origin/<feature>] on your feature branch row

# 3. Confirm all worktrees and their branches
git worktree list

# 4. Confirm upstream is reachable
git fetch upstream --dry-run
```

---

## Long-lived Branch Hygiene

- **Rebase onto `upstream/main` on a fixed cadence** — weekly is ideal; monthly accumulates painful conflicts.
- **Keep commits atomic.** Use `git commit --fixup` and `git rebase -i --autosquash` periodically to compress WIP noise before the history grows unwieldy.
- **Tag your last-known-good rebase point.** `git tag checkpoint/YYYY-MM-DD` after each successful rebase + test run. If a future rebase goes wrong, you have a clean rollback point.
- **Keep your fork's `main` in sync separately** from your feature branch — this keeps PR diffs clean and the fork's default branch usable.
- **If the same file repeatedly conflicts**, that signals structural divergence. Consider splitting the conflicting concern into a separate smaller PR.

---

## Related Documentation

### Internal References

- `crates/openfang-skills/bundled/git-expert/SKILL.md` — built-in Git expert skill covering branching strategies, rebasing, and conflict resolution
- `docs/brainstorms/2026-03-16-user-session-isolation-brainstorm.md` — references the worktree strategy for this project
- `docs/plans/2026-03-16-001-feat-user-session-isolation-channel-admin-plan.md` — feature plan that was developed using this workflow

### External References

- [git-worktree documentation](https://git-scm.com/docs/git-worktree)
- [git-rebase documentation](https://git-scm.com/docs/git-rebase)
- [GitHub: Contributing to a Project (Fork workflow)](https://git-scm.com/book/en/v2/GitHub-Contributing-to-a-Project)
- [Git Branching - Basic Branching and Merging](https://git-scm.com/book/en/v2/Git-Branching-Basic-Branching-and-Merging)
