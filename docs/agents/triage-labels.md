# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual
labels used in this repo's Linear team `AIFY0`.

| Label in mattpocock/skills | Label in our tracker           | Meaning                                  |
| -------------------------- | ------------------------------ | ---------------------------------------- |
| `needs-triage`             | `needs-triage`                 | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`                   | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`              | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`              | Requires human implementation            |
| `wontfix`                  | none — Linear state `Canceled` | Will not be actioned                     |

The four labels belong to team `AIFY0`. When a skill applies a triage label, use `addLabels`.
When a skill resolves a role to `wontfix`, move the issue to state `Canceled` and apply no label.
