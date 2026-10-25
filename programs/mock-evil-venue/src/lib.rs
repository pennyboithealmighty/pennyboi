//! Adversarial mock venue — TESTS ONLY (docs/13 §6). Its single instruction
//! grabs `amount` SOL from the buyer and pays NO tokens back. Driven from the
//! vault's `buyback_burn` CPI, this must always revert the whole transaction:
//!   - a large `amount` (> amount_lamports + allowance) trips SwapSpentTooMuch;
//!   - a small `amount` with zero tokens trips SlippageExceeded.
//! It proves the Treasury PDA can sign the CPI safely — the program's own
//! delta guards, not the venue, decide the outcome.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FFmYCS3uLRH1865Z8ZrWbLtVfS8gTiwfQDYdDApcSimQ");

#[program]
pub mod mock_evil_venue {
    use super::*;

    /// Transfer `amount` lamports from the buyer to the sink; return no tokens.
    pub fn grab_sol(ctx: Context<GrabSol>, amount: u64) -> Result<()> {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.buyer.to_account_info(),
                    to: ctx.accounts.sink.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct GrabSol<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut, seeds = [b"evil"], bump)]
    pub sink: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}
