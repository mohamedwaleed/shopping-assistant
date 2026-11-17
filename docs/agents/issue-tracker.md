# Issue trackers

The user selected both local Markdown and GitHub Issues.

- Local specification: `.scratch/shopping-assistant/spec.md`.
- Local implementation tickets, when requested: one file per issue under `.scratch/<feature>/issues/`, numbered from `01`.
- GitHub destination: `mohamedwaleed/shopping-assistant`, a public repository requested by the user.
- Publish the same specification as a GitHub issue; record its URL locally after creation.
- Local triage state uses a `Status:` line mirrored by the corresponding GitHub label. Parent specification #1 retains its existing `needs-info` state and was not modified by ticket publication. The approved implementation tickets #2–#35 use `ready-for-agent`, with native blocking relationships and explicit provider/source feasibility gates.
- Keep mirrored issue content consistent; record source URLs and numbers rather than creating duplicate issues on retries.
- External pull requests are not a triage request surface by default.

## Published implementation tickets

The user approved breakdown revision 2 and requested publication. The 34 implementation issues are mirrored individually under `.scratch/shopping-assistant/issues/`; `.scratch/shopping-assistant/tickets.md` maps local numbers to GitHub numbers. There are 57 native GitHub blocking relationships, plus readable Blocked by sections. Only work whose blockers are complete can start; `ready-for-agent` is not evidence that its blockers are complete. The initial frontier is GitHub issue #2.

Parent #1 was referenced in child bodies but not edited, closed, relabelled or made a native parent/sub-issue relationship. Use the publication mapping to avoid duplicate creation on retries. No implementation has started.
