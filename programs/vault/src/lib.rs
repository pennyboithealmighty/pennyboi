//! Pennyboi the Almighty — "The Divine Allowance" vault program (v0.1).
//!
//! The Law. No person and no AI holds a key that can drain the treasury; the
//! program owns it. The restricted `agent` key can ONLY call the capped menu
//! instructions (burn / airdrop / bounty), one per threshold crossing, each with
//! a hard cap and a cooldown that live in code and cannot be bypassed. See
//! docs/03-vault-spec.md.
//!
//! Safety:
//! - Checked math everywhere (no silent u64 overflow).
//! - An event is emitted for every state change.
//! - Recipients must be system accounts (never program accounts).
//! - Escape hatch and config changes are timelocked and public on-chain.
//!
//! NOTE: the program id below is a placeholder. After `anchor build`, run
//! `anchor keys sync` to rewrite it here and in Anchor.toml.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("GC7kdK4aEX9YsYSpiZ4VFJDw6Q8MtAPQgqjEjpSnVrac");

/// Absolute on-chain ceiling for airdrop recipients. Even a (timelocked) config
/// update cannot raise `airdrop_max_recipients` above this.
pub const HARD_MAX_RECIPIENTS: u8 = 20;
/// Max bounty memo length (bytes). Shows on Solscan.
pub const MEMO_MAX_LEN: usize = 140;

#[program]
pub mod vault {
    use super::*;

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    /// Create the Config PDA and record the agent, token mint, caps, cooldowns,
    /// threshold and escape timelock. `admin` is the deploy wallet and is only
    /// ever used for the (timelocked) escape hatch and config updates.
    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        validate_bounds(
            params.threshold_lamports,
            params.airdrop_max_recipients,
            params.burn_cooldown_secs,
            params.airdrop_cooldown_secs,
            params.bounty_cooldown_secs,
            params.escape_timelock_secs,
            params.max_banked_actions,
            params.idle_floor_secs,
        )?;

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.agent = params.agent;
        config.token_mint = params.token_mint;

        config.threshold_lamports = params.threshold_lamports;
        // Count only growth from here on; ignore any pre-existing balance.
        config.last_threshold_balance = ctx.accounts.treasury.lamports();
        config.threshold_step = 0;
        config.actions_available = 0;
        config.max_banked_actions = params.max_banked_actions;

        config.burn_cap_lamports = params.burn_cap_lamports;
        config.airdrop_cap_lamports = params.airdrop_cap_lamports;
        config.airdrop_max_recipients = params.airdrop_max_recipients;
        config.bounty_cap_lamports = params.bounty_cap_lamports;

        config.burn_cooldown_secs = params.burn_cooldown_secs;
        config.airdrop_cooldown_secs = params.airdrop_cooldown_secs;
        config.bounty_cooldown_secs = params.bounty_cooldown_secs;

        config.last_burn_ts = 0;
        config.last_airdrop_ts = 0;
        config.last_bounty_ts = 0;

        config.idle_floor_secs = params.idle_floor_secs;
        config.last_action_ts = 0;

        config.escape_timelock_secs = params.escape_timelock_secs;
        config.pending_withdraw = None;
        config.pending_config = None;

        config.bump = ctx.bumps.config;
        config.treasury_bump = ctx.bumps.treasury;
        config.fees_bump = ctx.bumps.fees;

        Ok(())
    }

    // ---------------------------------------------------------------------
    // The Menu (agent-only, flag-gated, capped, cooled down)
    // ---------------------------------------------------------------------

    /// A) burn — v0.1: transfer up to `burn_cap` SOL from the Treasury to the
    /// burn-route PDA and emit `Burned`. The actual swap-into-token + token burn
    /// is a CPI added in a later step; the route PDA stands in for it so the
    /// program compiles and tests without a DEX dependency.
    // TODO(swap): replace the transfer-to-burn-route with a Pump.fun bonding-curve
    // (pre-graduation) or Raydium/Jupiter (post-graduation) swap CPI, then burn the
    // received tokens. Set a min-out slippage so the burn can't be sandwiched.
    pub fn burn(ctx: Context<Burn>, amount_lamports: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;

        require!(config.actions_available > 0, VaultError::ActionNotAvailable);
        require!(
            amount_lamports <= config.burn_cap_lamports,
            VaultError::CapExceeded
        );
        require_cooldown(now, config.last_burn_ts, config.burn_cooldown_secs)?;

        // Treasury -> burn route, signed by the treasury PDA seeds.
        let treasury_bump = ctx.accounts.config.treasury_bump;
        let seeds: &[&[u8]] = &[b"treasury".as_ref(), &[treasury_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.burn_route.to_account_info(),
                },
                &[seeds],
            ),
            amount_lamports,
        )?;

        let config = &mut ctx.accounts.config;
        config.last_burn_ts = now;
        config.actions_available = config.actions_available.saturating_sub(1);
        config.last_action_ts = now;

        emit!(Burned {
            sol_spent: amount_lamports,
            tokens_burned: 0, // v0.1: no swap yet
        });
        Ok(())
    }

    /// B) airdrop — pay SOL to a list of holders. Recipients are passed as
    /// `remaining_accounts` in the same order as `recipients`; each must be a
    /// system account and match the declared pubkey.
    pub fn airdrop<'info>(
        ctx: Context<'info, Airdrop<'info>>,
        recipients: Vec<Pubkey>,
        amounts: Vec<u64>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;

        require!(config.actions_available > 0, VaultError::ActionNotAvailable);
        require!(
            recipients.len() == amounts.len(),
            VaultError::RecipientAmountMismatch
        );
        require!(!recipients.is_empty(), VaultError::EmptyAirdrop);
        require!(
            recipients.len() <= config.airdrop_max_recipients as usize,
            VaultError::TooManyRecipients
        );
        require!(
            ctx.remaining_accounts.len() == recipients.len(),
            VaultError::RecipientAmountMismatch
        );

        // Sum must not exceed the cap (checked add guards overflow).
        let mut total: u64 = 0;
        for a in amounts.iter() {
            total = total.checked_add(*a).ok_or(VaultError::MathOverflow)?;
        }
        require!(
            total <= config.airdrop_cap_lamports,
            VaultError::CapExceeded
        );

        let treasury_bump = ctx.accounts.config.treasury_bump;
        let seeds: &[&[u8]] = &[b"treasury".as_ref(), &[treasury_bump]];

        for i in 0..recipients.len() {
            let acct = &ctx.remaining_accounts[i];
            // Must be exactly the declared recipient, and a plain system account.
            require_keys_eq!(acct.key(), recipients[i], VaultError::InvalidRecipient);
            require!(
                acct.owner == &system_program::ID,
                VaultError::InvalidRecipient
            );
            require!(!acct.executable, VaultError::InvalidRecipient);

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.treasury.to_account_info(),
                        to: acct.to_account_info(),
                    },
                    &[seeds],
                ),
                amounts[i],
            )?;
        }

        let config = &mut ctx.accounts.config;
        config.last_airdrop_ts = now;
        config.actions_available = config.actions_available.saturating_sub(1);
        config.last_action_ts = now;

        emit!(Airdropped {
            count: recipients.len() as u8,
            total,
        });
        Ok(())
    }

    /// C) bounty — send a capped amount to a single address with a public memo
    /// (the "offering" being funded).
    pub fn bounty(
        ctx: Context<Bounty>,
        to: Pubkey,
        amount_lamports: u64,
        memo: String,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;

        require!(config.actions_available > 0, VaultError::ActionNotAvailable);
        require!(
            amount_lamports <= config.bounty_cap_lamports,
            VaultError::CapExceeded
        );
        require!(memo.as_bytes().len() <= MEMO_MAX_LEN, VaultError::MemoTooLong);
        require_keys_eq!(
            ctx.accounts.recipient.key(),
            to,
            VaultError::InvalidRecipient
        );
        require_cooldown(now, config.last_bounty_ts, config.bounty_cooldown_secs)?;

        let treasury_bump = ctx.accounts.config.treasury_bump;
        let seeds: &[&[u8]] = &[b"treasury".as_ref(), &[treasury_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[seeds],
            ),
            amount_lamports,
        )?;

        let config = &mut ctx.accounts.config;
        config.last_bounty_ts = now;
        config.actions_available = config.actions_available.saturating_sub(1);
        config.last_action_ts = now;

        emit!(BountyPaid {
            to,
            amount: amount_lamports,
            memo,
        });
        Ok(())
    }

    // ---------------------------------------------------------------------
    // Sweep (permissionless) + threshold logic
    // ---------------------------------------------------------------------

    /// Anyone may call. Moves everything above the rent-exempt minimum from the
    /// FeeReceiver PDA into the Treasury, then runs the threshold check. Because
    /// it is permissionless, no one has to trust the team to forward fees.
    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let rent_min = Rent::get()?.minimum_balance(0);
        let fees_balance = ctx.accounts.fees.lamports();

        if fees_balance > rent_min {
            let sweepable = fees_balance - rent_min;
            let fees_bump = ctx.accounts.config.fees_bump;
            let seeds: &[&[u8]] = &[b"fees".as_ref(), &[fees_bump]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.fees.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                    &[seeds],
                ),
                sweepable,
            )?;
        }

        // Post-CPI the Treasury AccountInfo reflects the new balance.
        let new_balance = ctx.accounts.treasury.lamports();
        let config = &mut ctx.accounts.config;
        let threshold = config.threshold_lamports;
        let max_banked = config.max_banked_actions;

        // Bank one act per whole threshold crossed. Walk last_threshold_balance
        // up one step at a time so the count is exact; bound the loop by
        // max_banked_actions so a huge balance can't run it unboundedly.
        let mut crossings: u16 = 0;
        while new_balance >= config.last_threshold_balance.saturating_add(threshold)
            && crossings < max_banked
        {
            config.last_threshold_balance = config.last_threshold_balance.saturating_add(threshold);
            crossings = crossings.saturating_add(1);
        }
        if crossings > 0 {
            config.actions_available = config
                .actions_available
                .saturating_add(crossings)
                .min(max_banked);
            config.threshold_step = config
                .threshold_step
                .checked_add(crossings as u64)
                .ok_or(VaultError::MathOverflow)?;
            emit!(ThresholdCrossed {
                balance: new_balance,
                step: config.threshold_step,
                granted: crossings,
                banked: config.actions_available,
            });
        }

        // Idle floor: during quiet, funded spells grant one act so he never goes
        // fully silent — only if the vault can afford the smallest cap.
        if config.actions_available == 0 {
            let min_cap = config
                .burn_cap_lamports
                .min(config.airdrop_cap_lamports)
                .min(config.bounty_cap_lamports);
            let ready = config
                .last_action_ts
                .checked_add(config.idle_floor_secs)
                .ok_or(VaultError::MathOverflow)?;
            if new_balance >= min_cap && now >= ready {
                config.actions_available = 1;
                emit!(IdleFloorGranted {
                    balance: new_balance,
                    since: config.last_action_ts,
                });
            }
        }

        Ok(())
    }

    // ---------------------------------------------------------------------
    // Escape hatch (admin, timelocked) — NOT agent-callable
    // ---------------------------------------------------------------------

    pub fn request_withdraw(
        ctx: Context<AdminOnly>,
        amount: u64,
        to: Pubkey,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let unlock_ts = now
            .checked_add(config.escape_timelock_secs)
            .ok_or(VaultError::MathOverflow)?;
        config.pending_withdraw = Some(PendingWithdraw {
            amount,
            to,
            unlock_ts,
        });
        emit!(WithdrawRequested {
            amount,
            to,
            unlock_ts,
        });
        Ok(())
    }

    pub fn execute_withdraw(ctx: Context<ExecuteWithdraw>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pending = ctx
            .accounts
            .config
            .pending_withdraw
            .clone()
            .ok_or(VaultError::NoPendingWithdraw)?;

        require!(now >= pending.unlock_ts, VaultError::TimelockNotExpired);
        require_keys_eq!(
            ctx.accounts.recipient.key(),
            pending.to,
            VaultError::InvalidRecipient
        );

        let treasury_bump = ctx.accounts.config.treasury_bump;
        let seeds: &[&[u8]] = &[b"treasury".as_ref(), &[treasury_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[seeds],
            ),
            pending.amount,
        )?;

        ctx.accounts.config.pending_withdraw = None;
        emit!(WithdrawExecuted {
            amount: pending.amount,
            to: pending.to,
        });
        Ok(())
    }

    pub fn cancel_withdraw(ctx: Context<AdminOnly>) -> Result<()> {
        require!(
            ctx.accounts.config.pending_withdraw.is_some(),
            VaultError::NoPendingWithdraw
        );
        ctx.accounts.config.pending_withdraw = None;
        emit!(WithdrawCancelled {});
        Ok(())
    }

    // ---------------------------------------------------------------------
    // Admin param updates (timelocked) — same 72h pattern so caps/cooldowns
    // cannot be silently raised.
    // ---------------------------------------------------------------------

    pub fn request_config_update(
        ctx: Context<AdminOnly>,
        params: ConfigUpdateParams,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;

        // Resolve each field now (unspecified fields keep their current value),
        // then validate the resulting set against the hard bounds.
        let resolved = PendingConfig {
            threshold_lamports: params
                .threshold_lamports
                .unwrap_or(config.threshold_lamports),
            burn_cap_lamports: params.burn_cap_lamports.unwrap_or(config.burn_cap_lamports),
            airdrop_cap_lamports: params
                .airdrop_cap_lamports
                .unwrap_or(config.airdrop_cap_lamports),
            airdrop_max_recipients: params
                .airdrop_max_recipients
                .unwrap_or(config.airdrop_max_recipients),
            bounty_cap_lamports: params
                .bounty_cap_lamports
                .unwrap_or(config.bounty_cap_lamports),
            burn_cooldown_secs: params
                .burn_cooldown_secs
                .unwrap_or(config.burn_cooldown_secs),
            airdrop_cooldown_secs: params
                .airdrop_cooldown_secs
                .unwrap_or(config.airdrop_cooldown_secs),
            bounty_cooldown_secs: params
                .bounty_cooldown_secs
                .unwrap_or(config.bounty_cooldown_secs),
            escape_timelock_secs: params
                .escape_timelock_secs
                .unwrap_or(config.escape_timelock_secs),
            max_banked_actions: params
                .max_banked_actions
                .unwrap_or(config.max_banked_actions),
            idle_floor_secs: params.idle_floor_secs.unwrap_or(config.idle_floor_secs),
            unlock_ts: now
                .checked_add(config.escape_timelock_secs)
                .ok_or(VaultError::MathOverflow)?,
        };

        validate_bounds(
            resolved.threshold_lamports,
            resolved.airdrop_max_recipients,
            resolved.burn_cooldown_secs,
            resolved.airdrop_cooldown_secs,
            resolved.bounty_cooldown_secs,
            resolved.escape_timelock_secs,
            resolved.max_banked_actions,
            resolved.idle_floor_secs,
        )?;

        let unlock_ts = resolved.unlock_ts;
        config.pending_config = Some(resolved);
        emit!(ConfigUpdateRequested { unlock_ts });
        Ok(())
    }

    pub fn execute_config_update(ctx: Context<AdminOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let pending = config
            .pending_config
            .clone()
            .ok_or(VaultError::NoPendingConfig)?;

        require!(now >= pending.unlock_ts, VaultError::TimelockNotExpired);

        config.threshold_lamports = pending.threshold_lamports;
        config.burn_cap_lamports = pending.burn_cap_lamports;
        config.airdrop_cap_lamports = pending.airdrop_cap_lamports;
        config.airdrop_max_recipients = pending.airdrop_max_recipients;
        config.bounty_cap_lamports = pending.bounty_cap_lamports;
        config.burn_cooldown_secs = pending.burn_cooldown_secs;
        config.airdrop_cooldown_secs = pending.airdrop_cooldown_secs;
        config.bounty_cooldown_secs = pending.bounty_cooldown_secs;
        config.escape_timelock_secs = pending.escape_timelock_secs;
        config.max_banked_actions = pending.max_banked_actions;
        config.idle_floor_secs = pending.idle_floor_secs;
        config.pending_config = None;

        emit!(ConfigUpdated {});
        Ok(())
    }

    pub fn cancel_config_update(ctx: Context<AdminOnly>) -> Result<()> {
        require!(
            ctx.accounts.config.pending_config.is_some(),
            VaultError::NoPendingConfig
        );
        ctx.accounts.config.pending_config = None;
        emit!(ConfigUpdateCancelled {});
        Ok(())
    }

    /// Optional (v0.2 per spec): burn the admin entirely once stable. After this,
    /// the escape hatch and config updates can never run again.
    pub fn renounce_admin(ctx: Context<AdminOnly>) -> Result<()> {
        require!(
            ctx.accounts.config.pending_withdraw.is_none()
                && ctx.accounts.config.pending_config.is_none(),
            VaultError::PendingActionExists
        );
        ctx.accounts.config.admin = Pubkey::default();
        emit!(AdminRenounced {});
        Ok(())
    }
}

// =========================================================================
// Shared checks
// =========================================================================

/// `now >= last_ts + cooldown` (checked).
fn require_cooldown(now: i64, last_ts: i64, cooldown: i64) -> Result<()> {
    let ready = last_ts
        .checked_add(cooldown)
        .ok_or(VaultError::MathOverflow)?;
    require!(now >= ready, VaultError::CooldownActive);
    Ok(())
}

/// Hard bounds enforced at init and on every config update.
fn validate_bounds(
    threshold_lamports: u64,
    airdrop_max_recipients: u8,
    burn_cooldown_secs: i64,
    airdrop_cooldown_secs: i64,
    bounty_cooldown_secs: i64,
    escape_timelock_secs: i64,
    max_banked_actions: u16,
    idle_floor_secs: i64,
) -> Result<()> {
    require!(threshold_lamports > 0, VaultError::InvalidParams);
    require!(
        airdrop_max_recipients > 0 && airdrop_max_recipients <= HARD_MAX_RECIPIENTS,
        VaultError::InvalidParams
    );
    require!(
        burn_cooldown_secs >= 0
            && airdrop_cooldown_secs >= 0
            && bounty_cooldown_secs >= 0
            && escape_timelock_secs >= 0,
        VaultError::InvalidParams
    );
    require!(max_banked_actions > 0, VaultError::InvalidParams);
    require!(idle_floor_secs >= 0, VaultError::InvalidParams);
    Ok(())
}

// =========================================================================
// Accounts
// =========================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    /// Treasury PDA — holds SOL, owned by the System Program, no private key.
    #[account(seeds = [b"treasury"], bump)]
    pub treasury: SystemAccount<'info>,

    /// FeeReceiver PDA — Pump.fun creator fees land here, swept into Treasury.
    #[account(seeds = [b"fees"], bump)]
    pub fees: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Burn<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = agent)]
    pub config: Account<'info, Config>,

    pub agent: Signer<'info>,

    #[account(mut, seeds = [b"treasury"], bump = config.treasury_bump)]
    pub treasury: SystemAccount<'info>,

    /// Burn-route PDA (v0.1 stand-in for the swap-and-burn CPI target).
    #[account(mut, seeds = [b"burn"], bump)]
    pub burn_route: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Airdrop<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = agent)]
    pub config: Account<'info, Config>,

    pub agent: Signer<'info>,

    #[account(mut, seeds = [b"treasury"], bump = config.treasury_bump)]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
    // Recipient system accounts are passed as `remaining_accounts`, in order.
}

#[derive(Accounts)]
pub struct Bounty<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = agent)]
    pub config: Account<'info, Config>,

    pub agent: Signer<'info>,

    #[account(mut, seeds = [b"treasury"], bump = config.treasury_bump)]
    pub treasury: SystemAccount<'info>,

    /// Bounty recipient; must be a plain system account and match the `to` arg.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    // Permissionless: no signer constraint. Anyone can forward fees.
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [b"treasury"], bump = config.treasury_bump)]
    pub treasury: SystemAccount<'info>,

    #[account(mut, seeds = [b"fees"], bump = config.fees_bump)]
    pub fees: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Admin-only, no fund movement (request/cancel withdraw, config update, renounce).
#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteWithdraw<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"treasury"], bump = config.treasury_bump)]
    pub treasury: SystemAccount<'info>,

    /// Must equal the pending withdraw's `to`.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

// =========================================================================
// State
// =========================================================================

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub agent: Pubkey,
    pub token_mint: Pubkey,

    pub threshold_lamports: u64,
    pub last_threshold_balance: u64,
    pub threshold_step: u64,

    // Banked acts owed (replaces the old action_available bool). A sweep banks
    // one per threshold crossed (and the idle floor can grant one); each menu
    // call consumes one. Cooldowns still pace how fast they're spent.
    pub actions_available: u16,
    pub max_banked_actions: u16,

    pub burn_cap_lamports: u64,
    pub airdrop_cap_lamports: u64,
    pub airdrop_max_recipients: u8,
    pub bounty_cap_lamports: u64,

    pub burn_cooldown_secs: i64,
    pub airdrop_cooldown_secs: i64,
    pub bounty_cooldown_secs: i64,

    pub last_burn_ts: i64,
    pub last_airdrop_ts: i64,
    pub last_bounty_ts: i64,

    // Idle floor: if no act in `idle_floor_secs` AND the vault can afford the
    // smallest cap, sweep() grants one act so he never goes fully silent.
    pub idle_floor_secs: i64,
    pub last_action_ts: i64,

    pub escape_timelock_secs: i64,
    pub pending_withdraw: Option<PendingWithdraw>,
    pub pending_config: Option<PendingConfig>,

    pub bump: u8,
    pub treasury_bump: u8,
    pub fees_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PendingWithdraw {
    pub amount: u64,
    pub to: Pubkey,
    pub unlock_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct PendingConfig {
    pub threshold_lamports: u64,
    pub burn_cap_lamports: u64,
    pub airdrop_cap_lamports: u64,
    pub airdrop_max_recipients: u8,
    pub bounty_cap_lamports: u64,
    pub burn_cooldown_secs: i64,
    pub airdrop_cooldown_secs: i64,
    pub bounty_cooldown_secs: i64,
    pub escape_timelock_secs: i64,
    pub max_banked_actions: u16,
    pub idle_floor_secs: i64,
    pub unlock_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeParams {
    pub agent: Pubkey,
    pub token_mint: Pubkey,
    pub threshold_lamports: u64,
    pub burn_cap_lamports: u64,
    pub airdrop_cap_lamports: u64,
    pub airdrop_max_recipients: u8,
    pub bounty_cap_lamports: u64,
    pub burn_cooldown_secs: i64,
    pub airdrop_cooldown_secs: i64,
    pub bounty_cooldown_secs: i64,
    pub escape_timelock_secs: i64,
    pub max_banked_actions: u16,
    pub idle_floor_secs: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigUpdateParams {
    pub threshold_lamports: Option<u64>,
    pub burn_cap_lamports: Option<u64>,
    pub airdrop_cap_lamports: Option<u64>,
    pub airdrop_max_recipients: Option<u8>,
    pub bounty_cap_lamports: Option<u64>,
    pub burn_cooldown_secs: Option<i64>,
    pub airdrop_cooldown_secs: Option<i64>,
    pub bounty_cooldown_secs: Option<i64>,
    pub escape_timelock_secs: Option<i64>,
    pub max_banked_actions: Option<u16>,
    pub idle_floor_secs: Option<i64>,
}

// =========================================================================
// Events (what Pennyboi's "eyes" narrate from)
// =========================================================================

#[event]
pub struct ThresholdCrossed {
    pub balance: u64,
    pub step: u64,
    pub granted: u16,
    pub banked: u16,
}

#[event]
pub struct IdleFloorGranted {
    pub balance: u64,
    pub since: i64,
}

#[event]
pub struct Burned {
    pub sol_spent: u64,
    pub tokens_burned: u64,
}

#[event]
pub struct Airdropped {
    pub count: u8,
    pub total: u64,
}

#[event]
pub struct BountyPaid {
    pub to: Pubkey,
    pub amount: u64,
    pub memo: String,
}

#[event]
pub struct WithdrawRequested {
    pub amount: u64,
    pub to: Pubkey,
    pub unlock_ts: i64,
}

#[event]
pub struct WithdrawExecuted {
    pub amount: u64,
    pub to: Pubkey,
}

#[event]
pub struct WithdrawCancelled {}

#[event]
pub struct ConfigUpdateRequested {
    pub unlock_ts: i64,
}

#[event]
pub struct ConfigUpdated {}

#[event]
pub struct ConfigUpdateCancelled {}

#[event]
pub struct AdminRenounced {}

// =========================================================================
// Errors
// =========================================================================

#[error_code]
pub enum VaultError {
    #[msg("No banked acts; wait for a threshold crossing or the idle floor.")]
    ActionNotAvailable,
    #[msg("Amount exceeds the per-action cap.")]
    CapExceeded,
    #[msg("Action is still on cooldown.")]
    CooldownActive,
    #[msg("recipients and amounts length mismatch.")]
    RecipientAmountMismatch,
    #[msg("Airdrop has no recipients.")]
    EmptyAirdrop,
    #[msg("Too many recipients for this airdrop.")]
    TooManyRecipients,
    #[msg("Recipient must be a plain system account and match the declared key.")]
    InvalidRecipient,
    #[msg("Memo exceeds the maximum length.")]
    MemoTooLong,
    #[msg("Checked math overflow.")]
    MathOverflow,
    #[msg("No pending withdraw.")]
    NoPendingWithdraw,
    #[msg("No pending config update.")]
    NoPendingConfig,
    #[msg("Timelock has not expired yet.")]
    TimelockNotExpired,
    #[msg("Invalid parameters.")]
    InvalidParams,
    #[msg("A pending action exists; resolve it first.")]
    PendingActionExists,
}
