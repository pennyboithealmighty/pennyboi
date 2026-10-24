// pm2 process manager config for the week-long devnet dry run.
// Runs all four services plus the looping fee feed and sweep, with
// restart-on-crash and per-process logs under logs/.
//
//   mkdir -p logs
//   pm2 start ecosystem.config.cjs      # start the whole dry run
//   pm2 status                          # see all six processes
//   pm2 logs                            # tail everything (Ctrl+C to detach)
//   pm2 logs pb-brain                   # just the Brain
//   pm2 restart pb-eyes                 # restart one
//   pm2 stop all / pm2 delete all       # stop / remove
//   pm2 save && pm2 startup             # survive a reboot (follow its printout)
//
// See RUNBOOK-dryrun.md for funding, tuning, and monitoring.

const path = require("node:path");
const root = __dirname;

function app(name, args, env = {}) {
  return {
    name,
    cwd: root,
    script: "pnpm",
    args,
    interpreter: "none", // run the pnpm binary directly, not via node
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000, // 5s backoff between restarts
    time: true, // timestamp every log line
    out_file: path.join(root, "logs", `${name}.out.log`),
    error_file: path.join(root, "logs", `${name}.err.log`),
    env,
  };
}

module.exports = {
  apps: [
    // Services (downstream first; order doesn't matter — the first threshold is
    // minutes away, by which point all are up).
    app("pb-mouth", "--filter @pennyboi/mouth start"),
    app("pb-hands", "--filter @pennyboi/hands start"),
    app("pb-brain", "--filter @pennyboi/brain start"),
    // Eyes polls when no Helius key is set; force polling for the dry run.
    app("pb-eyes", "--filter @pennyboi/eyes start", { HELIUS_API_KEY: "" }),

    // Automation: fee feed (loops by default) + sweep loop.
    app("pb-feed", "--filter @pennyboi/scripts mock-fee-feed"),
    app("pb-sweep", "--filter @pennyboi/scripts sweep:loop"),
  ],
};
