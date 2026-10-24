# scripts/

Automation, implemented in later build-plan steps:

- `deploy` — devnet build + deploy of the vault program, writes program id.
- `mock-fee-feed` — drips lamports into the FeeReceiver PDA for the devnet dry run.
- `sweep` — cron entry that calls the permissionless `sweep()` instruction.

SCAFFOLD ONLY (Step 0).
