# scripts/

Devnet automation. **All three refuse to run unless `SOLANA_RPC_URL` contains
"devnet".** Secret keys are generated into a gitignored `keys/` folder and are
never printed — only public keys appear in output.

| Script | Command | What it does |
|---|---|---|
| deploy:devnet | `pnpm --filter @pennyboi/scripts deploy:devnet` | Generate `keys/admin.json` + `keys/agent.json`, fund them from the faucet, `anchor build`/`keys sync`/`deploy` (skipped if already deployed — idempotent), then initialize the on-chain Config (caps/cooldowns/threshold). Prints the program id + the `.env` lines to paste. |
| mock-fee-feed | `pnpm --filter @pennyboi/scripts mock-fee-feed` | Drip SOL from `admin` into the FeeReceiver PDA on an interval (simulates Pump.fun creator fees for the dry run). `--once` for a single drip. |
| sweep | `pnpm --filter @pennyboi/scripts sweep` | Call the permissionless `sweep()` once (cron-friendly). `--loop` to self-schedule every `SWEEP_INTERVAL_SECS`. |

## Typical devnet dry run

```bash
# 1. point .env at devnet, then:
pnpm --filter @pennyboi/scripts deploy:devnet  # keys, deploy, initialize (idempotent)
# paste the printed VAULT_PROGRAM_ID / *_KEYPAIR_PATH lines into .env

pnpm --filter @pennyboi/scripts mock-fee-feed  # terminal A: feed fees
pnpm --filter @pennyboi/scripts sweep --loop   # terminal B: sweep + cross thresholds
pnpm --filter @pennyboi/eyes start             # terminal C: build briefings on crossing
# ...plus brain, hands, mouth
```

For a real cron instead of `--loop`, schedule the one-shot form, e.g.:

```
*/5 * * * * cd /path/to/pennyboi && pnpm --filter @pennyboi/scripts sweep >> logs/sweep.log 2>&1
```

Tuning knobs (env, optional) are listed in `.env.example` under "Vault params".
