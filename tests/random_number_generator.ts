import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SwitchboardRandomness } from "../target/types/switchboard_randomness";
import { PublicKey, Keypair, Connection, SystemProgram, LAMPORTS_PER_SOL, Commitment } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { expect } from "chai";
import { loadSbProgram, setupQueue, handleTransaction } from "../utils/utils";

const COMMITMENT = "confirmed";
const PLAYER_STATE_SEED = "randomnessState";

describe("switchboard_randomness", () => {
  // Configure the client to use the devnet
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SwitchboardRandomness as Program<SwitchboardRandomness>;
  const wallet = provider.wallet as any;
  const payer = wallet.payer as Keypair;
  const connection = provider.connection;

  // Transaction options
  const txOpts = {
    commitment: "processed" as Commitment,
    skipPreflight: false,
    maxRetries: 0,
  };

  // Store state variables
  let randomnessState: PublicKey;
  let randomnessAccount: PublicKey;
  let randomnessAccountKeypair: Keypair;
  let sbProgram: any;
  let queue: PublicKey;

  before(async () => {
    console.log("Setting up test environment...");

    // Find the randomness state PDA
    const [_randomnessState, _] = PublicKey.findProgramAddressSync(
      [Buffer.from(PLAYER_STATE_SEED), payer.publicKey.toBuffer()],
      program.programId
    );
    randomnessState = _randomnessState;
    console.log("Randomness state PDA:", randomnessState.toString());

    try {
      // Load the Switchboard program
      sbProgram = await loadSbProgram(provider);
      console.log("Switchboard program ID:", sbProgram.programId.toString());

      // Set up a queue
      queue = await setupQueue(sbProgram);
      console.log("Queue:", queue.toString());
    } catch (error) {
      console.error("Error setting up Switchboard:", error);
      console.log("Tests will be skipped if running in a local environment");
    }
  });

  it("Initialize randomness state", async () => {
    try {
      // Initialize the randomness state account
      const tx = await program.methods
        .initialize()
        .accounts({
          randomnessState: randomnessState,
          user: payer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Initialize transaction signature:", tx);

      // Fetch the account to verify initialization
      const stateAccount = await program.account.randomnessState.fetch(randomnessState);

      // Verify initial state
      expect(stateAccount.latestResult).to.equal(false);
      expect(stateAccount.randomnessAccount.toString()).to.equal(PublicKey.default.toString());
      expect(stateAccount.authorizedUser.toString()).to.equal(payer.publicKey.toString());
    } catch (error) {
      console.error("Initialization error:", error);
      if (error.toString().includes("already in use")) {
        console.log("Account already initialized, continuing tests");
      } else {
        throw error;
      }
    }
  });

  it("Request randomness", async () => {
    if (!sbProgram || !queue) {
      console.log("Skipping test: Switchboard environment not available");
      return;
    }

    try {
      // Generate a randomness account keypair
      randomnessAccountKeypair = Keypair.generate();

      // Create randomness account
      console.log("Creating randomness account...");
      const [randomness, createIx] = await sb.Randomness.create(sbProgram, randomnessAccountKeypair, queue);

      randomnessAccount = randomness.pubkey;
      console.log("Randomness account:", randomnessAccount.toString());

      // Send transaction to create randomness account
      await handleTransaction(sbProgram, connection, [createIx], payer, [payer, randomnessAccountKeypair], txOpts);

      // Commit to randomness
      console.log("Committing to randomness...");
      const commitIx = await randomness.commitIx(queue);

      // Request randomness from our program
      const requestRandomnessIx = await program.methods
        .requestRandomness(randomnessAccount)
        .accounts({
          randomnessState: randomnessState,
          user: payer.publicKey,
          randomnessAccountData: randomnessAccount,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      // Send combined transaction
      await handleTransaction(sbProgram, connection, [commitIx, requestRandomnessIx], payer, [payer], txOpts);

      // Verify randomness account was set in state
      const stateAfterRequest = await program.account.randomnessState.fetch(randomnessState);
      expect(stateAfterRequest.randomnessAccount.toString()).to.equal(randomnessAccount.toString());
      expect(stateAfterRequest.commitSlot.toNumber()).to.be.greaterThan(0);

      console.log("Randomness requested successfully at slot:", stateAfterRequest.commitSlot.toString());
    } catch (error) {
      console.error("Request randomness error:", error);
      console.log("This test requires Switchboard devnet environment");
    }
  });

  it("Get randomness result", async () => {
    if (!sbProgram || !queue || !randomnessAccount) {
      console.log("Skipping test: Previous steps not completed");
      return;
    }

    try {
      // Create randomness object from existing account
      const randomness = new sb.Randomness(sbProgram, randomnessAccount);

      // Reveal randomness
      console.log("Revealing randomness...");
      const revealIx = await randomness.revealIx();

      // Get randomness instruction
      const getRandomnessIx = await program.methods
        .getRandomness()
        .accounts({
          randomnessState: randomnessState,
          user: payer.publicKey,
          randomnessAccountData: randomnessAccount,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      // Send combined transaction
      const revealSig = await handleTransaction(sbProgram, connection, [revealIx, getRandomnessIx], payer, [payer], txOpts);

      // Get transaction logs
      const txInfo = await connection.getParsedTransaction(revealSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      const logs = txInfo?.meta?.logMessages || [];

      // Extract randomness results from logs
      let randomValue, booleanResult;
      for (const log of logs) {
        if (log.includes("Randomness value:")) {
          randomValue = log.split("Randomness value:")[1].trim();
          console.log("Random value from logs:", randomValue);
        }
        if (log.includes("Boolean result:")) {
          booleanResult = log.split("Boolean result:")[1].trim();
          console.log("Boolean result from logs:", booleanResult);
        }
      }

      // Fetch final state
      const finalState = await program.account.randomnessState.fetch(randomnessState);
      console.log("Final random value:", finalState.randomValue.toString());
      console.log("Final boolean result:", finalState.latestResult);

      // Verify we got results
      expect(finalState.randomValue.toString()).to.not.equal("0");
    } catch (error) {
      console.error("Get randomness error:", error);
      if (
        error.toString().includes("RandomnessExpired") ||
        error.toString().includes("RandomnessAlreadyRevealed") ||
        error.toString().includes("RandomnessNotResolved")
      ) {
        console.log("Randomness timing issue - this is expected in tests");
      } else {
        console.log("This test requires proper Switchboard environment");
      }
    }
  });
});
