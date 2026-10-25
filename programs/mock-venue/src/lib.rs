//! Mock AMM venue — DEVNET / TESTS ONLY (docs/13 §6). A tiny constant-product
//! pool (SOL <-> one SPL token) with a single `buy` instruction, so the vault's
//! `buyback_burn` generic CPI, balance-delta guards, and SPL burn can run end to
//! end without Pump.fun / PumpSwap. NEVER put this on a mainnet whitelist.
//!
//! Pool layout (all PDAs of this program):
//!   pool_sol   [b"pool_sol"]     — SystemAccount, the SOL reserve
//!   pool_auth  [b"pool_auth"]    — authority that owns the token reserve
//!   pool_vault — token account owned by pool_auth, the token reserve
//! Reserves are read straight from the live balances (no stored state).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("Er4xBs7mvh138XYpZSAEQZfqJJgxSNKxGy6fwjLyFZzj");

#[program]
pub mod mock_venue {
    use super::*;

    /// Buy tokens with `amount_in` lamports at the constant-product price,
    /// enforcing `min_out`. Signed by the buyer (the vault's Treasury PDA via
    /// invoke_signed in the real path).
    pub fn buy(ctx: Context<Buy>, amount_in: u64, min_out: u64) -> Result<()> {
        let sol_reserve = ctx.accounts.pool_sol.lamports();
        let tok_reserve = ctx.accounts.pool_vault.amount;
        require!(amount_in > 0, MockError::BadAmount);

        // out = tok_reserve * amount_in / (sol_reserve + amount_in)   (x*y=k)
        let denom = (sol_reserve as u128)
            .checked_add(amount_in as u128)
            .ok_or(MockError::Overflow)?;
        let out = ((tok_reserve as u128)
            .checked_mul(amount_in as u128)
            .ok_or(MockError::Overflow)?
            / denom) as u64;
        require!(out >= min_out, MockError::Slippage);
        require!(out < tok_reserve, MockError::InsufficientLiquidity);

        // Buyer -> pool SOL (buyer signs; privilege inherited from the caller).
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.pool_sol.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Pool vault -> buyer ATA, signed by the pool authority PDA.
        let bump = ctx.bumps.pool_auth;
        let seeds: &[&[u8]] = &[b"pool_auth".as_ref(), &[bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.pool_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.pool_auth.to_account_info(),
                },
                &[seeds],
            ),
            out,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [b"pool_sol"], bump)]
    pub pool_sol: SystemAccount<'info>,

    /// CHECK: PDA authority over the token reserve; signs the payout.
    #[account(seeds = [b"pool_auth"], bump)]
    pub pool_auth: UncheckedAccount<'info>,

    #[account(mut)]
    pub pool_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_ata: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum MockError {
    #[msg("amount_in must be > 0")]
    BadAmount,
    #[msg("math overflow")]
    Overflow,
    #[msg("output below min_out")]
    Slippage,
    #[msg("not enough liquidity")]
    InsufficientLiquidity,
}
