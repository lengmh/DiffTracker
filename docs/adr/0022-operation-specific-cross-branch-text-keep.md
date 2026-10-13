# ADR 0022: Operation-specific cross-branch text Keep

Status: Accepted

## Context

Issue #35 describes an intentional comparison between a saved DiffTracker baseline on branch A and current files on branch B. A repository-wide Git pause incorrectly blocked text Keep even though Keep changes only DiffTracker's selected before-images.

## Decision

Text Keep uses a separate baseline-only action policy. A paused review can accept selected text files or blocks when the authoritative Git monitor and the tracker agree on the same repository/worktree, and both baseline and current contexts are stable named branches with known commits. A compatible return to the original branch can use the same policy without clearing the existing pause.

Review tokens pin the observed Git context without scanning Git metadata while rendering. Every action validation synchronously samples HEAD and operation markers twice and verifies loose or packed refs against the Git monitor, including linked-worktree metadata; unknown state remains blocked for its owning repository. This bounded stability check cannot atomically lock out an external Git process. Compatible commit movement refreshes token-bearing views without relaxing action signatures or clearing a pause. Keep retains target identity, workspace/symlink, recovery, review-content, dirty-editor, and persistence checks. It pins the current Git signature across asynchronous work and checks it at the durable commit barrier. Cross-branch transactions also re-read bounded text content at that barrier; stale Git, disk, or editor state rejects the candidate and restores the previous saved baseline.

Keep never changes workspace files, the index, HEAD, Git baseline provenance, or the Git-pause marker. Global and folder batches retain explicit text tokens and confirm the eligible cross-branch text-file count using one synchronous verified Git observation; each subsequent action still validates fresh state. File and block Keep do not require rebuilding the baseline. Other pending reviews remain pending.

Revert, Undo, snapshot capture, archive rebuild, and archive restore keep their existing stricter policies. Ordinary same-branch Keep still leaves edits arriving during persistence pending. A Git Keep durably preserves one complete pre-Keep session and a digest-checked intent before publishing the candidate. The incomplete-write marker and rollback intent survive every asynchronous boundary. The final metadata/content check and intent removal use a synchronous commit point; restart restores an interrupted action rather than accepting its candidate. A lifecycle cancellation after preparation blocks new baselines until reload recovery, and explicit discard waits for in-flight recovery actions. Successfully committed Keeps are not rolled back on later Stop or reload. Resolved pre-Keep backups are removed after commit, recovery, rollback, or explicit discard; cleanup failures do not undo a committed Keep and are retried on reload only when no intent remains. Session V4 stays unchanged; a still-incompatible branch recreates its pause when the saved session is reconciled on reload.

## Supported Git metadata and recovery limits

The bounded verifier reads loose/packed refs, not reftable storage; unsupported ref storage fails closed. Manual replacement or repointing of `.git` or linked-worktree metadata at an unchanged path is outside ordinary branch-switch continuity and requires explicit archive/rebuild after the repository is stable. An unborn repository without an initial commit is refused even for same-branch Keep. Restored sessions carrying recorded Git provenance also refuse Keep if the Git monitor is unavailable; they cannot silently fall back to the non-Git Keep path.

## Issue #41 amendment

Compatible Git returns are revalidated against the authoritative monitor and current disk metadata before clearing only the affected repository pause. Recovery actions retain the pause until they settle, so a return cannot revive a write that observed an incompatible context. No before-image or Undo history is replaced by resumption. Existing Session V4 contexts remain supported; this does not extend the documented manual same-path Git metadata replacement boundary.

Only the explicit single-file Acknowledge route opts into the named-branch baseline-only policy. Its displayed token pins Git context, validated again after reads and during durable publication. Folder/mixed opaque batches stay strict. Unknown Reset remains a separately confirmed, strict-context operation. Shared Acknowledge/Unknown transactions reuse the existing pre-acceptance payload and intent storage format; final approved-identity checks use bounded-memory hashing and do not depend on the candidate’s transient pending projection. No automatic retry adopts new file contents.

Ordinary single-file acceptance has no routine modal or success toast. Failed actions preserve their evidence and report a concrete nonmodal reason.

## Original follow-ups (superseded for selected Acknowledge by #41)

Read-only Acknowledge and Reset Unknown Baseline retain their existing Git-pause policy. Extending either requires separate targeted coverage of opaque identity, Unknown evidence, dirty-editor, and durable rollback guards. This change does not classify detached, missing, initializing, merging/rebasing, conflicting, or inconsistent Git state as a safe branch switch.

## Verification

Production-tracker tests use the existing mocked VS Code boundary and real temporary Git repositories. They cover selected file/block/batch acceptance, partial results, unchanged Git/workspace bytes and modes, stale tokens, live context disagreement, pre- and post-publication rollback, reload reconciliation, strict Revert/Undo, and unchanged archive restoration. UI tests cover batch counts, cancellation, frozen selections, and operation-specific messages. Existing Linux/Windows quality and Extension Host CI remain the release gates.
