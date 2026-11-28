# Issue template

The maintainer's template for turning an audit record (or any problem) into an implementation-ready GitHub issue. Records in `audit/records/` use these section headings. Saved verbatim below.

```text
Please draft a GitHub issue for the problems described. Inspect the relevant code and
existing tests. Write a concise, implementation-ready issue that a coding
agent can pick up without repeating the investigation.

Use these sections:

1. Current Implementation
   Explain the current user experience regardless of code intention. Describe the current reality.

2. Problem and evidence
   Describe what the problem is, who it affects, and one concrete example or
   reproduction. Explain why this is undesirable as a problem.
   Cite the verified code path or commit. Flag any unverified assumptions that could change the fix.

3. Required behavior and scope
   Describe the expected behavior. State what is in scope, what is out of
   scope, and which existing behavior or data must be preserved.

4. Relevant Documentation
   Link to relevant documentation pages and important notes or announcements. Use https://developers.reddit.com/docs/llms.txt as a guide to determine which categories to investigate.
   Prioritize official documentation, but also utilize community discussions that address similar issues while being aware that
   conversations might refer to older software versions and different circumstances. If a community discussion is
   referenced, add relevant data such as the discussion date, software versions, etc.
   Use community discussions to guide further documentation investigation.

5. Implementation map and blockers
   List the relevant files and functions, with links or paths. Explain where
   to start, which existing logic to reuse, and any dependency or unresolved
   decision that could block the fix. Leave routine implementation choices
   to the implementer.

6. Edge cases and regression risks
   List only cases that could change the implementation or break existing
   behavior. State the expected outcome for each.

7. Tests and verification
   Name the relevant existing tests and the smallest set of cases to add
   or update. Include a targeted test command if verified.

8. Acceptance criteria
   Provide a short checklist of observable outcomes that defines done.
   Include one check for the original bug and one for the highest-risk
   regression.

9. Criticality and Implementation Cost
   Describe the criticality of this problem for app functionality, on a scale of 1-10. Include 1 sentence why.
   Describe the estimated lines of code that would need to be modified (added, removed, or replaced) to implement.

Return a suggested title and then the issue body in a code block for each unique issue please. Thank you!
```
