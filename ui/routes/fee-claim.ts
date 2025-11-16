/*
 * Z Combinator - Solana Token Launchpad
 * Copyright (C) 2025 Spice Finance Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import nacl from 'tweetnacl';
import { Connection, Keypair, Transaction, PublicKey, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMint,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import { CpAmm, getTokenProgram, getUnClaimReward } from '@meteora-ag/cp-amm-sdk';
import rateLimit from 'express-rate-limit';

/**
 * Fee Claim Routes
 *
 * Express router for Meteora DAMM v2 fee claiming endpoints
 */

const router = Router();

// Rate limiter for fee claim endpoints
const feeClaimLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 requests per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many fee claim requests, please wait a moment.'
});

// In-memory storage for fee claim transactions
// Maps requestId -> transaction data
interface FeeClaimData {
  unsignedTransaction: string; // Single base58-encoded unsigned transaction
  poolAddress: string;
  tokenAMint: string;
  tokenBMint: string;
  lpOwnerAddress: string;
  feePayerAddress: string;
  destinationAddress: string;
  estimatedTokenAFees: string;
  estimatedTokenBFees: string;
  positionsCount: number;
  timestamp: number;
}
const feeClaimRequests = new Map<string, FeeClaimData>();

// Mutex locks for preventing concurrent fee claim processing
// Maps pool address -> Promise that resolves when processing is done
const feeClaimLocks = new Map<string, Promise<void>>();

/**
 * Acquire a fee claim lock for a specific pool
 * Prevents race conditions during fee claim processing
 *
 * @param poolAddress - The pool address to lock
 * @returns A function to release the lock
 */
async function acquireFeeClaimLock(poolAddress: string): Promise<() => void> {
  const key = poolAddress.toLowerCase();

  // Wait for any existing lock to be released
  while (feeClaimLocks.has(key)) {
    await feeClaimLocks.get(key);
  }

  // Create a new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  feeClaimLocks.set(key, lockPromise);

  // Return the release function
  return () => {
    feeClaimLocks.delete(key);
    releaseLock!();
  };
}

// Clean up expired requests every 5 minutes (requests expire after 10 minutes in confirm endpoint)
setInterval(() => {
  const FIFTEEN_MINUTES = 15 * 60 * 1000;
  const now = Date.now();
  for (const [requestId, data] of feeClaimRequests.entries()) {
    if (now - data.timestamp > FIFTEEN_MINUTES) {
      feeClaimRequests.delete(requestId);
    }
  }
}, 5 * 60 * 1000);

// ============================================================================
// POST /fee-claim/claim - Build fee claim transactions
// ============================================================================

router.post('/claim', feeClaimLimiter, async (req: Request, res: Response) => {
  try {
    const { payerPublicKey } = req.body;

    console.log('Fee claim request received:', { payerPublicKey });

    // Validate required fields
    if (!payerPublicKey) {
      return res.status(400).json({
        error: 'Missing required field: payerPublicKey'
      });
    }

    // Validate payer public key format
    let payerPubKey: PublicKey;
    try {
      payerPubKey = new PublicKey(payerPublicKey);
    } catch (error) {
      return res.status(400).json({
        error: 'Invalid payerPublicKey format'
      });
    }

    // Validate environment variables
    const RPC_URL = process.env.RPC_URL;
    const DAMM_POOL_ADDRESS = process.env.DAMM_POOL_ADDRESS;
    const PROTOCOL_PRIVATE_KEY = process.env.PROTOCOL_PRIVATE_KEY;
    const FEE_DESTINATION_ADDRESS = process.env.FEE_DESTINATION_ADDRESS;

    if (!RPC_URL || !DAMM_POOL_ADDRESS || !PROTOCOL_PRIVATE_KEY || !FEE_DESTINATION_ADDRESS) {
      return res.status(500).json({
        error: 'Server configuration incomplete. Missing required environment variables.'
      });
    }

    // Initialize connection and keypairs
    const connection = new Connection(RPC_URL, 'confirmed');
    const lpOwner = Keypair.fromSecretKey(bs58.decode(PROTOCOL_PRIVATE_KEY));
    const poolAddress = new PublicKey(DAMM_POOL_ADDRESS);
    const destinationAddress = new PublicKey(FEE_DESTINATION_ADDRESS);

    // Create CpAmm instance and get pool state
    const cpAmm = new CpAmm(connection);
    const poolState = await cpAmm.fetchPoolState(poolAddress);

    // Get user positions
    const userPositions = await cpAmm.getUserPositionByPool(poolAddress, lpOwner.publicKey);

    if (userPositions.length === 0) {
      return res.status(404).json({
        error: 'No positions found for the LP owner in this pool'
      });
    }

    // IMPORTANT: This endpoint only claims fees from the FIRST position
    // This is intentional to keep transaction size manageable and reduce complexity
    // If multiple positions exist, only the first position's fees will be claimed
    // Calculate total unclaimed fees using SDK helper
    let totalTokenAFees = new BN(0);
    let totalTokenBFees = new BN(0);

    for (const { positionState } of userPositions) {
      const unclaimedFees = getUnClaimReward(poolState, positionState);
      totalTokenAFees = totalTokenAFees.add(unclaimedFees.feeTokenA);
      totalTokenBFees = totalTokenBFees.add(unclaimedFees.feeTokenB);
    }

    // Check if there are any fees to claim
    if (totalTokenAFees.isZero() && totalTokenBFees.isZero()) {
      return res.status(400).json({
        error: 'No fees available to claim'
      });
    }

    // Get token programs for token A and B
    const tokenAMintInfo = await getMint(connection, poolState.tokenAMint);
    const tokenBMintInfo = await getMint(connection, poolState.tokenBMint);
    const tokenAProgram = getTokenProgram(tokenAMintInfo.tlvData.length > 0 ? 1 : 0);
    const tokenBProgram = getTokenProgram(tokenBMintInfo.tlvData.length > 0 ? 1 : 0);

    // Check if Token B is native SOL (wrapped SOL)
    // When claiming wrapped SOL fees from Meteora, the SDK automatically unwraps them to native SOL
    // This means we receive native SOL directly instead of wSOL tokens in an ATA
    const isTokenBNativeSOL = poolState.tokenBMint.equals(NATIVE_MINT);

    // Build single combined transaction with all claim + transfer instructions
    const combinedTx = new Transaction();
    combinedTx.feePayer = payerPubKey;

    const { blockhash } = await connection.getLatestBlockhash();
    combinedTx.recentBlockhash = blockhash;

    // Get LP owner's token accounts
    const tokenAAta = await getAssociatedTokenAddress(
      poolState.tokenAMint,
      lpOwner.publicKey
    );
    const tokenBAta = await getAssociatedTokenAddress(
      poolState.tokenBMint,
      lpOwner.publicKey
    );

    // Create LP owner's Token A ATA (required before claim)
    // Token A is always an SPL token, so we need an ATA to receive it
    combinedTx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payerPubKey,
        tokenAAta,
        lpOwner.publicKey,
        poolState.tokenAMint,
        tokenAProgram
      )
    );

    // Only create Token B ATA if it's NOT native SOL
    // If Token B is native SOL (NATIVE_MINT), the Meteora claim automatically unwraps it
    // to native SOL in the wallet, so no token account is needed
    if (!isTokenBNativeSOL) {
      combinedTx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payerPubKey,
          tokenBAta,
          lpOwner.publicKey,
          poolState.tokenBMint,
          tokenBProgram
        )
      );
    }

    // Add claim fee instructions for first position only
    const { position, positionNftAccount } = userPositions[0];
    const claimTx = await cpAmm.claimPositionFee({
      owner: lpOwner.publicKey,
      position,
      pool: poolAddress,
      positionNftAccount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram,
      tokenBProgram,
    });

    // Add all claim instructions to combined transaction
    combinedTx.add(...claimTx.instructions);

    // Recalculate fees for first position only (since we're only claiming from the first position)
    // This overwrites the total calculated earlier, ensuring we only transfer what was actually claimed
    const { positionState } = userPositions[0];
    const unclaimedFees = getUnClaimReward(poolState, positionState);
    totalTokenAFees = unclaimedFees.feeTokenA;
    totalTokenBFees = unclaimedFees.feeTokenB;

    // Get destination token accounts
    // Token A is always an SPL token, so we need the ATA address
    const destTokenAAta = await getAssociatedTokenAddress(
      poolState.tokenAMint,
      destinationAddress
    );
    // For native SOL transfers, the destination is the wallet address itself (not an ATA)
    // For SPL tokens, we need to get the ATA address
    const destTokenBAta = isTokenBNativeSOL ? destinationAddress : await getAssociatedTokenAddress(
      poolState.tokenBMint,
      destinationAddress
    );

    // Calculate 70% of claimed fees
    const tokenATransferAmount = totalTokenAFees.mul(new BN(70)).div(new BN(100));
    const tokenBTransferAmount = totalTokenBFees.mul(new BN(70)).div(new BN(100));

    // Add ATA creation instruction for Token A destination (always SPL token)
    // Token A is always an SPL token, so we need to ensure the destination has a token account
    if (!tokenATransferAmount.isZero()) {
      combinedTx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payerPubKey,
          destTokenAAta,
          destinationAddress,
          poolState.tokenAMint,
          tokenAProgram
        )
      );
    }

    // Add ATA creation instruction for Token B destination (only if it's NOT native SOL)
    // For native SOL, no ATA is needed since we transfer directly to the wallet
    // For SPL tokens, we need to create the destination's token account
    if (!tokenBTransferAmount.isZero() && !isTokenBNativeSOL) {
      combinedTx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payerPubKey,
          destTokenBAta,
          destinationAddress,
          poolState.tokenBMint,
          tokenBProgram
        )
      );
    }

    // Add transfer instruction for Token A (always an SPL token)
    // Transfer 70% of claimed Token A fees from LP owner to destination using SPL Token program
    if (!tokenATransferAmount.isZero()) {
      combinedTx.add(
        createTransferInstruction(
          tokenAAta,
          destTokenAAta,
          lpOwner.publicKey,
          BigInt(tokenATransferAmount.toString()),
          [],
          tokenAProgram
        )
      );
    }

    // Add transfer instruction for Token B
    // The transfer method depends on whether Token B is native SOL or an SPL token
    if (!tokenBTransferAmount.isZero()) {
      if (isTokenBNativeSOL) {
        // Transfer native SOL using SystemProgram.transfer
        // After Meteora unwraps the wSOL, we have native SOL in the wallet
        // So we use a regular SOL transfer (not SPL token transfer)
        combinedTx.add(
          SystemProgram.transfer({
            fromPubkey: lpOwner.publicKey,
            toPubkey: destinationAddress,
            lamports: Number(tokenBTransferAmount.toString())
          })
        );
      } else {
        // Transfer SPL token using Token Program
        // For non-SOL tokens, we use standard SPL token transfer between ATAs
        combinedTx.add(
          createTransferInstruction(
            tokenBAta,
            destTokenBAta,
            lpOwner.publicKey,
            BigInt(tokenBTransferAmount.toString()),
            [],
            tokenBProgram
          )
        );
      }
    }

    // Serialize the combined unsigned transaction
    const unsignedTransaction = bs58.encode(combinedTx.serialize({ requireAllSignatures: false }));

    // Generate unique request ID
    const requestId = crypto.randomBytes(16).toString('hex');

    console.log('✓ Fee claim transaction built successfully');
    console.log(`  Pool: ${poolAddress.toBase58()}`);
    console.log(`  Positions: ${userPositions.length} (claiming from position 1)`);
    console.log(`  Token A fees: ${totalTokenAFees.toString()}`);
    console.log(`  Token B fees: ${totalTokenBFees.toString()}`);
    console.log(`  70% split to: ${destinationAddress.toBase58()}`);
    console.log(`  Request ID: ${requestId}`);

    // Store transaction data in memory
    feeClaimRequests.set(requestId, {
      unsignedTransaction,
      poolAddress: poolAddress.toBase58(),
      tokenAMint: poolState.tokenAMint.toBase58(),
      tokenBMint: poolState.tokenBMint.toBase58(),
      lpOwnerAddress: lpOwner.publicKey.toBase58(),
      feePayerAddress: payerPubKey.toBase58(),
      destinationAddress: destinationAddress.toBase58(),
      estimatedTokenAFees: totalTokenAFees.toString(),
      estimatedTokenBFees: totalTokenBFees.toString(),
      positionsCount: 1,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      transaction: unsignedTransaction,
      requestId,
      poolAddress: poolAddress.toBase58(),
      tokenAMint: poolState.tokenAMint.toBase58(),
      tokenBMint: poolState.tokenBMint.toBase58(),
      isTokenBNativeSOL,
      totalPositions: userPositions.length,
      claimingPosition: 1,
      instructionsCount: combinedTx.instructions.length,
      estimatedFees: {
        tokenA: totalTokenAFees.toString(),
        tokenB: totalTokenBFees.toString(),
        tokenATransfer: tokenATransferAmount.toString(),
        tokenBTransfer: tokenBTransferAmount.toString(),
      },
      message: `Sign this transaction and submit to /fee-claim/confirm${isTokenBNativeSOL ? ' (Token B will be transferred as native SOL)' : ''}`
    });

  } catch (error) {
    console.error('Claim fees error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create fee claim transaction'
    });
  }
});

// ============================================================================
// POST /fee-claim/confirm - Confirm and submit fee claim transactions
// ============================================================================
/**
 * Security measures implemented:
 * 1. Lock system - Prevents concurrent claims for the same pool
 * 2. Blockhash validation - Prevents replay attacks
 * 3. Transaction structure validation - Prevents malicious instruction injection
 *    - Only allows specific program IDs (Token, ATA, ComputeBudget, Lighthouse, Meteora, System)
 *    - Validates instruction opcodes
 *    - Validates transfer authorities and destinations
 *    - Validates transfer amounts don't exceed expected values
 * 4. Fee payer signature verification - Ensures user authorized the transaction
 * 5. Request expiry - 10 minute timeout for pending claims
 * 6. Comprehensive logging - Transaction details logged for monitoring and troubleshooting
 *
 * No authorization required - destinations are hardcoded, fee payer only covers tx costs
 */

router.post('/confirm', feeClaimLimiter, async (req: Request, res: Response) => {
  let releaseLock: (() => void) | null = null;

  try {
    const { signedTransaction, requestId } = req.body;

    console.log('Fee claim confirm request received:', { requestId });

    // Validate required fields
    if (!signedTransaction || !requestId) {
      return res.status(400).json({
        error: 'Missing required fields: signedTransaction and requestId'
      });
    }

    // Retrieve the fee claim data from memory
    const feeClaimData = feeClaimRequests.get(requestId);
    if (!feeClaimData) {
      return res.status(400).json({
        error: 'Fee claim request not found or expired. Please call /fee-claim/claim first.'
      });
    }

    console.log('  Pool:', feeClaimData.poolAddress);

    // Acquire lock for this pool IMMEDIATELY to prevent race conditions
    releaseLock = await acquireFeeClaimLock(feeClaimData.poolAddress);
    console.log('  Lock acquired');

    // NOTE: No authorization check needed - destinations are hardcoded in environment variables
    // Transaction validation ensures funds can ONLY go to FEE_DESTINATION_ADDRESS (70%) and LP owner (30%)
    // Fee payer only covers transaction costs, cannot redirect funds to themselves
    // This allows anyone to trigger fee claims, which is the intended design

    // Check if request is not too old (10 minutes timeout)
    const TEN_MINUTES = 10 * 60 * 1000;
    if (Date.now() - feeClaimData.timestamp > TEN_MINUTES) {
      feeClaimRequests.delete(requestId);
      return res.status(400).json({
        error: 'Fee claim request expired. Please create a new request.'
      });
    }

    // Validate environment variables
    const RPC_URL = process.env.RPC_URL;
    const PROTOCOL_PRIVATE_KEY = process.env.PROTOCOL_PRIVATE_KEY;

    if (!RPC_URL || !PROTOCOL_PRIVATE_KEY) {
      return res.status(500).json({
        error: 'Server configuration incomplete'
      });
    }

    // Initialize connection and LP owner keypair
    const connection = new Connection(RPC_URL, 'confirmed');
    const lpOwnerKeypair = Keypair.fromSecretKey(bs58.decode(PROTOCOL_PRIVATE_KEY));

    // Deserialize and verify the transaction
    const expectedFeePayer = new PublicKey(feeClaimData.feePayerAddress);

    let transaction: Transaction;
    try {
      const transactionBuffer = bs58.decode(signedTransaction);
      transaction = Transaction.from(transactionBuffer);
    } catch (error) {
      return res.status(400).json({
        error: `Failed to deserialize transaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }

    // SECURITY: Validate transaction has recent blockhash to prevent replay attacks
    if (!transaction.recentBlockhash) {
      return res.status(400).json({
        error: 'Invalid transaction: missing blockhash'
      });
    }

    // Check if blockhash is still valid (within last 150 slots ~60 seconds)
    const isBlockhashValid = await connection.isBlockhashValid(
      transaction.recentBlockhash,
      { commitment: 'confirmed' }
    );

    if (!isBlockhashValid) {
      return res.status(400).json({
        error: 'Invalid transaction: blockhash is expired. Please create a new transaction.'
      });
    }

    // Verify the transaction hasn't been tampered with
    if (!transaction.feePayer) {
      return res.status(400).json({
        error: 'Transaction missing fee payer'
      });
    }

    // Verify fee payer matches expected payer
    if (!transaction.feePayer.equals(expectedFeePayer)) {
      return res.status(400).json({
        error: 'Transaction fee payer mismatch'
      });
    }

    // Check that LP owner is a required signer
    const lpOwnerIsRequired = transaction.instructions.some(ix =>
      ix.keys.some(key =>
        key.pubkey.equals(lpOwnerKeypair.publicKey) && key.isSigner
      )
    );

    if (!lpOwnerIsRequired) {
      return res.status(400).json({
        error: 'Transaction verification failed: LP owner signature not required'
      });
    }

    // Verify transaction contains instructions
    if (transaction.instructions.length === 0) {
      return res.status(400).json({
        error: 'Transaction verification failed: No instructions found'
      });
    }

    // Verify fee payer has signed
    const feePayerSignature = transaction.signatures.find(sig =>
      sig.publicKey.equals(transaction.feePayer!)
    );

    if (!feePayerSignature || !feePayerSignature.signature) {
      return res.status(400).json({
        error: 'Transaction verification failed: Fee payer has not signed'
      });
    }

    // Verify the fee payer signature is valid
    const messageData = transaction.serializeMessage();
    const feePayerSigValid = nacl.sign.detached.verify(
      messageData,
      feePayerSignature.signature,
      feePayerSignature.publicKey.toBytes()
    );

    if (!feePayerSigValid) {
      return res.status(400).json({
        error: 'Transaction verification failed: Invalid fee payer signature'
      });
    }

    // ========================================================================
    // CRITICAL SECURITY: Validate transaction structure
    // ========================================================================
    // Ensure only authorized instructions are present to prevent attacks

    console.log(`  Validating transaction structure (${transaction.instructions.length} instructions)...`);

    // Define safe program IDs that wallets may add for optimization
    const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId;
    const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
    const METEORA_CP_AMM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

    // Parse stored data for validation
    const lpOwnerAddress = new PublicKey(feeClaimData.lpOwnerAddress);
    const destinationAddress = new PublicKey(feeClaimData.destinationAddress);
    const tokenAMint = new PublicKey(feeClaimData.tokenAMint);
    const tokenBMint = new PublicKey(feeClaimData.tokenBMint);

    // Check if Token B is native SOL
    const isTokenBNativeSOL = tokenBMint.equals(NATIVE_MINT);

    // Validate ONLY allowed instruction types are present
    for (let i = 0; i < transaction.instructions.length; i++) {
      const instruction = transaction.instructions[i];
      const programId = instruction.programId;

      // Allow safe programs: TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, ComputeBudget, Lighthouse, Meteora CP AMM, and Meteora DAMM v2
      if (!programId.equals(TOKEN_PROGRAM_ID) &&
          !programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) &&
          !programId.equals(COMPUTE_BUDGET_PROGRAM_ID) &&
          !programId.equals(LIGHTHOUSE_PROGRAM_ID) &&
          !programId.equals(METEORA_CP_AMM_PROGRAM_ID) &&
          !programId.equals(METEORA_DAMM_V2_PROGRAM_ID) &&
          !programId.equals(SystemProgram.programId)) {
        return res.status(400).json({
          error: 'Invalid transaction: unauthorized program instruction detected',
          details: `Instruction ${i} uses unauthorized program: ${programId.toBase58()}`
        });
      }

      // Validate TOKEN_PROGRAM instructions
      if (programId.equals(TOKEN_PROGRAM_ID)) {
        const opcode = instruction.data[0];

        // Allow Transfer (3), CloseAccount (9), and TransferChecked (12) opcodes only
        if (opcode !== 3 && opcode !== 9 && opcode !== 12) {
          return res.status(400).json({
            error: 'Invalid transaction: unauthorized token instruction detected',
            details: `Instruction ${i} has invalid opcode: ${opcode}. Only Transfer (3), CloseAccount (9), and TransferChecked (12) allowed.`
          });
        }

        // Validate CloseAccount instructions
        if (opcode === 9) {
          // CloseAccount: accounts are [account, destination, authority]
          if (instruction.keys.length >= 3) {
            const authority = instruction.keys[2].pubkey;
            const destination = instruction.keys[1].pubkey;

            // Authority must be LP owner
            if (!authority.equals(lpOwnerAddress)) {
              return res.status(400).json({
                error: 'Invalid transaction: close account authority must be LP owner',
                details: `Instruction ${i} authority ${authority.toBase58()} does not match LP owner ${lpOwnerAddress.toBase58()}`
              });
            }

            // Destination for rent refund must be LP owner or destination address
            if (!destination.equals(lpOwnerAddress) && !destination.equals(destinationAddress)) {
              return res.status(400).json({
                error: 'Invalid transaction: close account destination not authorized',
                details: `Instruction ${i} destination ${destination.toBase58()} must be LP owner or destination address`
              });
            }
          }
        }

        // Validate transfer instructions have correct authority (LP owner)
        // For Transfer: accounts are [source, destination, authority]
        // For TransferChecked: accounts are [source, mint, destination, authority]
        if (opcode === 3 || opcode === 12) {
          const authorityIndex = opcode === 3 ? 2 : 3;

          if (instruction.keys.length > authorityIndex) {
          const authority = instruction.keys[authorityIndex].pubkey;

          if (!authority.equals(lpOwnerAddress)) {
            return res.status(400).json({
              error: 'Invalid transaction: transfer authority must be LP owner',
              details: `Instruction ${i} authority ${authority.toBase58()} does not match LP owner ${lpOwnerAddress.toBase58()}`
            });
          }

          // Validate destination is the expected destination address or LP owner's ATA
          const destIndex = opcode === 3 ? 1 : 2;
          const destination = instruction.keys[destIndex].pubkey;

          // Get expected destination token accounts
          const destTokenAAta = await getAssociatedTokenAddress(tokenAMint, destinationAddress);
          const destTokenBAta = isTokenBNativeSOL ? destinationAddress : await getAssociatedTokenAddress(tokenBMint, destinationAddress);
          const lpTokenAAta = await getAssociatedTokenAddress(tokenAMint, lpOwnerAddress);
          const lpTokenBAta = isTokenBNativeSOL ? lpOwnerAddress : await getAssociatedTokenAddress(tokenBMint, lpOwnerAddress);

          // Destination must be one of: destination's Token A/B ATA, or LP owner's Token A/B ATA (for claims)
          const validDestinations = [
            destTokenAAta.toBase58(),
            destTokenBAta.toBase58(),
            lpTokenAAta.toBase58(),
            lpTokenBAta.toBase58()
          ];

          if (!validDestinations.includes(destination.toBase58())) {
            return res.status(400).json({
              error: 'Invalid transaction: transfer destination not authorized',
              details: `Instruction ${i} destination ${destination.toBase58()} is not in allowed list`
            });
          }

          // Validate transfer amounts don't exceed stored expected amounts
          const amountBytes = Buffer.from(instruction.data.subarray(1, 9));
          const transferAmount = new BN(amountBytes, 'le');

          // Determine which token is being transferred by checking destination
          const destinationKey = destination.toBase58();
          const isTokenATransfer = destinationKey === destTokenAAta.toBase58() || destinationKey === lpTokenAAta.toBase58();
          const isTokenBTransfer = destinationKey === destTokenBAta.toBase58() || destinationKey === lpTokenBAta.toBase58();

          // Validate amount against the appropriate token's expected fees
          if (isTokenATransfer) {
            const maxTokenAFees = new BN(feeClaimData.estimatedTokenAFees);
            if (transferAmount.gt(maxTokenAFees)) {
              return res.status(400).json({
                error: 'Invalid transaction: Token A transfer amount exceeds expected fees',
                details: `Instruction ${i} amount ${transferAmount.toString()} exceeds Token A fees ${maxTokenAFees.toString()}`
              });
            }
          } else if (isTokenBTransfer) {
            const maxTokenBFees = new BN(feeClaimData.estimatedTokenBFees);
            if (transferAmount.gt(maxTokenBFees)) {
              return res.status(400).json({
                error: 'Invalid transaction: Token B transfer amount exceeds expected fees',
                details: `Instruction ${i} amount ${transferAmount.toString()} exceeds Token B fees ${maxTokenBFees.toString()}`
              });
            }
          }
          }
        }
      }

      // Validate ASSOCIATED_TOKEN_PROGRAM instructions are only CreateIdempotent (opcode 1)
      if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
        if (instruction.data.length < 1 || instruction.data[0] !== 1) {
          return res.status(400).json({
            error: 'Invalid transaction: unauthorized ATA instruction detected',
            details: `Instruction ${i} has invalid ATA opcode: ${instruction.data[0]}`
          });
        }
      }

      // Validate SystemProgram instructions (for native SOL transfers)
      // SystemProgram is only used when Token B is native SOL (after Meteora unwraps wSOL)
      if (programId.equals(SystemProgram.programId)) {
        // Decode instruction type (first 4 bytes are instruction discriminator)
        const instructionType = instruction.data.readUInt32LE(0);

        // Allow Transfer (2) instruction only
        // This prevents other system operations like CreateAccount, Allocate, etc.
        if (instructionType !== 2) {
          return res.status(400).json({
            error: 'Invalid transaction: unauthorized system program instruction',
            details: `Instruction ${i} has invalid system instruction type: ${instructionType}`
          });
        }

        // Validate transfer is from LP owner and to authorized destination
        // For SystemProgram.transfer: keys[0] = from, keys[1] = to
        if (instruction.keys.length >= 2) {
          const from = instruction.keys[0].pubkey;
          const to = instruction.keys[1].pubkey;

          // Source must be the LP owner (who received the unwrapped SOL)
          if (!from.equals(lpOwnerAddress)) {
            return res.status(400).json({
              error: 'Invalid transaction: system transfer must be from LP owner',
              details: `Instruction ${i} from ${from.toBase58()} does not match LP owner ${lpOwnerAddress.toBase58()}`
            });
          }

          // Destination must be the hardcoded fee destination address (70% recipient)
          if (!to.equals(destinationAddress)) {
            return res.status(400).json({
              error: 'Invalid transaction: system transfer destination not authorized',
              details: `Instruction ${i} destination ${to.toBase58()} does not match expected ${destinationAddress.toBase58()}`
            });
          }

          // Validate transfer amount doesn't exceed Token B fees (only if Token B is native SOL)
          // Amount is encoded as 8 bytes starting at offset 4 (after the 4-byte instruction discriminator)
          if (isTokenBNativeSOL && instruction.data.length >= 12) {
            const amountBytes = Buffer.from(instruction.data.subarray(4, 12));
            const transferAmount = new BN(amountBytes, 'le');
            const maxTokenBFees = new BN(feeClaimData.estimatedTokenBFees);

            if (transferAmount.gt(maxTokenBFees)) {
              return res.status(400).json({
                error: 'Invalid transaction: SOL transfer amount exceeds expected Token B fees',
                details: `Instruction ${i} amount ${transferAmount.toString()} exceeds Token B fees ${maxTokenBFees.toString()}`
              });
            }
          }
        }
      }
    }

    console.log('  ✓ Transaction structure validated');

    // Add LP owner signature
    transaction.partialSign(lpOwnerKeypair);

    // Send the transaction
    console.log('  Sending transaction...');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    console.log('✓ Fee claim transaction sent');
    console.log(`  Signature: ${signature}`);
    console.log(`  Pool: ${feeClaimData.poolAddress}`);
    console.log(`  Token A: ${feeClaimData.tokenAMint}, Fees: ${feeClaimData.estimatedTokenAFees}`);
    console.log(`  Token B: ${feeClaimData.tokenBMint}, Fees: ${feeClaimData.estimatedTokenBFees}`);
    console.log(`  Destination: ${feeClaimData.destinationAddress} (70% split)`);
    console.log(`  Solscan: https://solscan.io/tx/${signature}`);

    // Wait for confirmation
    try {
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      });
      console.log(`✓ Fee claim confirmed: ${signature}`);
    } catch (error) {
      console.error(`⚠ Confirmation timeout for ${signature}:`, error);
      // Continue even if confirmation fails - transaction may still succeed
    }

    // Clean up the request from memory after successful submission
    feeClaimRequests.delete(requestId);

    res.json({
      success: true,
      signature,
      poolAddress: feeClaimData.poolAddress,
      tokenAMint: feeClaimData.tokenAMint,
      tokenBMint: feeClaimData.tokenBMint,
      destinationAddress: feeClaimData.destinationAddress,
      positionsCount: feeClaimData.positionsCount,
      estimatedFees: {
        tokenA: feeClaimData.estimatedTokenAFees,
        tokenB: feeClaimData.estimatedTokenBFees
      },
      message: 'Fee claim transaction submitted successfully'
    });

  } catch (error) {
    console.error('Confirm fee claim error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to confirm fee claim'
    });
  } finally {
    // Always release the lock, even if an error occurred
    if (releaseLock) {
      releaseLock();
    }
  }
});

export default router;
