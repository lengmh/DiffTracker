# Maintainer release workflow

Code Diff Tracker uses a semi-automatic release flow. GitHub builds the VSIX,
validates its exact bytes through installed acceptance, and only then may publish
the tag, GitHub Release, VSIX and checksum. Marketplace publication remains a
separate manual maintainer step.

The source is prepared for **0.8.1**. This preparation PR does not authorize a
Release dispatch, tag, GitHub Release or Marketplace publication. PR #21's merged
main commit `ef41d2c496875a1de0d894df5f0973df01676f1e` passed
[Verification #551](https://github.com/lengmh/DiffTracker/actions/runs/37620008513),
attempt 1, 8/8 jobs. That prior result does not verify a later package's bytes.

## Before running Release

1. Prepare consistent `package.json`, lockfile root versions and a non-empty exact
   `## X.Y.Z` changelog section in a normal pull request.
2. Complete review and Verification for that PR, then obtain merge authorization.
3. Merge to `main` and wait for successful push Verification on the exact commit.
4. Obtain separate authorization before dispatching Release. Its `dry_run` input
   still defaults to **false**; never omit or assume it when a dry run is intended.

The workflow refuses other branches or commits without a successful main push
Verification run. The 0.8.1 preparation preserves default review behavior:
WebView remains the factory default, Native Review is selectable and Quick Diff
remains a separate opt-in.

## Exact artifact contract

Every Release build, dry or real, performs the following in order:

1. Validate version, package identity, lockfile versions and release notes.
2. Audit production dependencies and run artifact/harness guard tests.
3. Build `code-diff-tracker-X.Y.Z.vsix` once and record its full SHA-256 plus
   source commit, producing Actions run ID and attempt as build job outputs.
4. Verify that exact VSIX against its JSON and VSIX identity manifests, current
   source metadata and complete expected production outputs.
5. Independently verify the pinned official released `0.7.2` download.
6. Install the final VSIX and execute all five Ubuntu Stable phases: first install,
   recording recovery, stopped recovery, official 0.7.2 preparation and same-ID
   upgrade. Recheck the original digest before installation/phase use and after
   completion; never rebuild or refresh the expected digest to accept a replacement.
7. Validate the ordered successful phase evidence and checksum, then upload the
   VSIX, checksum, release notes and `final-installed-summary.json` as a workflow
   artifact. No upload, tag or release step precedes successful installed acceptance.

The separate publish job has write permission only after the build gate passes.
It downloads that artifact and verifies its bytes and five-phase evidence against
trusted build job outputs plus the workflow commit/run/attempt. A checksum or
summary supplied alongside replaced bytes cannot change the trusted expectations.
Internal `DO-NOT-PUBLISH` VSIX files/evidence cannot satisfy this gate. The publish
job does not compile or repackage anything.

Acceptance proves actual production activation across separate VS Code processes,
V3-to-V4 text migration, preserved ordered legacy rules and candidate-created
opaque recovery. It does not prove a physical Reload Window menu click, released
opaque migration, Marketplace installation or a wider platform matrix. See the
[installed harness](../test/installed/README.md) and
[bounded RC checkpoint](./bounded-rc-checkpoint.md).

## Authorized dry run

Open **GitHub → Actions → Release → Run workflow**, select `main`, and explicitly
set the source version and `dry_run: true`. For this preparation the version is
`0.8.1`. An existing release tag does not block a dry run because it does not
modify release state.

A dry run executes the full exact-VSIX installed gate and uploads validated build
files, but creates no tag or GitHub Release. It is not a packaging-only shortcut.
The release preparation PR itself does not dispatch this workflow. PR Verification
exercises the same final-artifact input path using a separately built CI-only VSIX;
Release must test its own bytes again.

## Authorized GitHub release

For an explicitly approved real release, select `main`, enter the version without
`v`, and set `dry_run: false`. Stable versions use `X.Y.Z`; a supported SemVer
prerelease suffix creates a GitHub prerelease. The source and lock versions must
match the selected version.

After build and publish-side identity checks, the workflow:

- creates annotated tag `vX.Y.Z` on the exact verified commit;
- creates a draft GitHub Release with the matching changelog notes;
- uploads the unchanged VSIX and checksum;
- publishes only after asset upload succeeds, then verifies publication state.

A published release is never overwritten. An existing tag must point to the same
commit. An incomplete draft is recreated only for that verified tag; a published
version fails closed instead of silently replacing its assets.

## Marketplace publication

After the separately authorized GitHub Release succeeds:

1. Download its `code-diff-tracker-X.Y.Z.vsix` and checksum.
2. Verify the checksum against the downloaded bytes.
3. Open the `lengmh` Marketplace publisher and update the existing extension.
4. Confirm the version before submitting the exact downloaded VSIX.

Do not upload a local rebuild, PR artifact or internal `DO-NOT-PUBLISH` candidate.
The release workflow does not publish to Marketplace.

## Recovery and safety

- A failed gate blocks artifact upload and all release mutations. Fix the source
  or metadata through a new PR and obtain fresh Verification.
- Never move an existing tag or replace a published asset with different bytes.
- The producing run attempt is part of identity. **Rerun all jobs** if retrying:
  rerunning only a failed publish job changes the attempt without rebuilding and
  is rejected. Do not weaken the provenance comparison to recover it.
- If a prior attempt created the tag, rerun only while it still points to the
  same authorized commit. An incomplete draft may be recovered by this workflow;
  a published release is not modified automatically.
- Preserve original failure evidence. Historical run #549's later Whole-to-Rules
  durable-preparation failure remains unattributed; later passing runs and the
  separate earlier settings-fixture diagnosis are not a blanket root-cause claim.
