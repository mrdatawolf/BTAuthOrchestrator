# Task Lifecycle

The directory containing a task file is its authoritative state.

```text
proposed --human approval--> approved --assigned agent--> in-progress
in-progress --implementation handoff--> review
review --human acceptance--> completed
review --changes requested--> in-progress
```

## States

- `proposed/`: A plan exists, but implementation is not authorized.
- `approved/`: The human approved the task and it is ready to be assigned.
- `in-progress/`: An assigned specialist is actively working on it.
- `review/`: Work and its handoff are ready for human acceptance. This
  applies uniformly, whether or not the task type has an independent
  reviewer — a task with no reviewer role (e.g. a contract-designer or
  human-owned task) still passes through `review/`, with its `## Review`
  section stating "Not applicable" rather than the task skipping the
  directory. There is no task type for which `review/` is optional.
- `completed/`: The human accepted the work.

## Authority

- Only the human moves a task from `proposed/` to `approved/`.
- An assigned implementer moves its task from `approved/` to `in-progress/`.
- The implementer moves completed work to `review/` after recording its handoff.
- The reviewer records findings but does not implement fixes or accept the task.
- The human moves accepted work to `completed/` or returns it to `in-progress/`.
- No agent moves a task into `completed/` on its own initiative, regardless
  of task type or how clearly the human has approved the work's content. An
  agent may execute that move only when explicitly instructed to do so for
  that specific task — approval of content ("yes, approve this contract")
  is not, by itself, an instruction to file the task as completed.

## Blocked work

Blocked is a condition, not a lifecycle directory. Leave the task in its current
state and add a prominent blocker describing what is needed, who can resolve it,
and its effect. Do not continue beyond the approved scope to bypass a blocker.

## File conventions

Use `TASK-NNN-short-description.md`. Keep the identifier and filename stable when
moving the file. Link contracts as `CONTRACT-NNN` and decisions as `ADR-NNN`.
