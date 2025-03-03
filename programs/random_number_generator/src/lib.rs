
use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::RandomnessAccountData;

declare_id!("Cr1KAf6PqLd3zQA7WoYVnmkZfokvDQuL7hrZy3k7LH5b");

#[program]
pub mod switchboard_randomness {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let randomness_state = &mut ctx.accounts.randomness_state;
        randomness_state.latest_result = false;
        randomness_state.randomness_account = Pubkey::default();
        randomness_state.bump = ctx.bumps.randomness_state;
        randomness_state.authorized_user = ctx.accounts.user.key();

        Ok(())
    }

    // Request randomness
    pub fn request_randomness(
        ctx: Context<RequestRandomness>,
        randomness_account: Pubkey,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let randomness_state = &mut ctx.accounts.randomness_state;
        
        let randomness_data =
            RandomnessAccountData::parse(ctx.accounts.randomness_account_data.data.borrow())
                .unwrap();

        if randomness_data.seed_slot != clock.slot - 1 {
            msg!("seed_slot: {}", randomness_data.seed_slot);
            msg!("slot: {}", clock.slot);
            return Err(ErrorCode::RandomnessAlreadyRevealed.into());
        }
        
        // Track the commited values so you know they don't request randomness multiple times
        randomness_state.commit_slot = randomness_data.seed_slot;

        // Store randomness account
        randomness_state.randomness_account = randomness_account;

        // Log the request
        msg!("Randomness requested. Commit slot: {}", randomness_state.commit_slot);
        Ok(())
    }

    // Get randomness result
    pub fn get_randomness(ctx: Context<GetRandomness>) -> Result<()> {
        let clock: Clock = Clock::get()?;
        let randomness_state = &mut ctx.accounts.randomness_state;
        
        // Call the switchboard on-demand parse function to get the randomness data
        let randomness_data =
            RandomnessAccountData::parse(ctx.accounts.randomness_account_data.data.borrow())
                .unwrap();
                
        if randomness_data.seed_slot != randomness_state.commit_slot {
            return Err(ErrorCode::RandomnessExpired.into());
        }
        
        // Call the switchboard on-demand get_value function to get the revealed random value
        let revealed_random_value = randomness_data
            .get_value(&clock)
            .map_err(|_| ErrorCode::RandomnessNotResolved)?;

        // Store the revealed random value
        randomness_state.latest_result = revealed_random_value[0] % 2 == 0;
        randomness_state.random_value = revealed_random_value[0] as u128;

        msg!("Randomness value: {}", randomness_state.random_value);
        msg!("Boolean result: {}", randomness_state.latest_result);

        Ok(())
    }
}

// === State Account ===
#[account]
pub struct RandomnessState {
    authorized_user: Pubkey,
    latest_result: bool,          // Boolean result derived from the random value
    random_value: u128,           // Raw random value
    randomness_account: Pubkey,   // Reference to the Switchboard randomness account
    bump: u8,
    commit_slot: u64,             // The slot at which the randomness was committed
}

// === Instructions ===
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init,
        payer = user,
        seeds = [b"randomnessState".as_ref(), user.key().as_ref()],
        space = 8 + 32 + 1 + 16 + 32 + 1 + 8,
        bump)]
    pub randomness_state: Account<'info, RandomnessState>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    #[account(mut,
        seeds = [b"randomnessState".as_ref(), user.key().as_ref()],
        bump = randomness_state.bump)]
    pub randomness_state: Account<'info, RandomnessState>,
    #[account(constraint = user.key() == randomness_state.authorized_user @ ErrorCode::Unauthorized)]
    pub user: Signer<'info>,
    /// CHECK: The account's data is validated manually within the handler.
    pub randomness_account_data: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetRandomness<'info> {
    #[account(mut,
        seeds = [b"randomnessState".as_ref(), user.key().as_ref()],
        bump = randomness_state.bump)]
    pub randomness_state: Account<'info, RandomnessState>,
    #[account(constraint = user.key() == randomness_state.authorized_user @ ErrorCode::Unauthorized)]
    pub user: Signer<'info>,
    /// CHECK: The account's data is validated manually within the handler.
    pub randomness_account_data: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// === Errors ===
#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized access attempt.")]
    Unauthorized,
    #[msg("Randomness already revealed.")]
    RandomnessAlreadyRevealed,
    #[msg("Randomness not yet resolved.")]
    RandomnessNotResolved,
    #[msg("Randomness request expired.")]
    RandomnessExpired,
}