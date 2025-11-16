import { NextRequest } from 'next/server';
import { PrivyClient } from '@privy-io/server-auth';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { createHash } from 'crypto';

// Validate required environment variables
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;

// Initialize Privy client only if credentials are available
// In mock mode, this will be null and functions will handle it gracefully
let privyClient: PrivyClient | null = null;

if (PRIVY_APP_ID && PRIVY_APP_SECRET) {
  try {
    privyClient = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET);
  } catch (error) {
    console.warn('Failed to initialize Privy client:', error);
  }
}

// Rate limiting store (in production, use Redis)
const rateLimitStore = new Map<string, { attempts: number; resetAt: number }>();

// Verification locks store (in production, use Redis)
const verificationLocks = new Map<string, number>();

export interface VerificationAuditLog {
  id?: number;
  event_type: 'verification_attempt' | 'verification_success' | 'verification_failed' | 'rate_limit_exceeded';
  token_address?: string;
  wallet_address?: string;
  social_twitter?: string;
  social_github?: string;
  ip_address?: string;
  user_agent?: string;
  error_message?: string;
  metadata?: Record<string, unknown>;
  created_at?: Date;
}

/**
 * Verify Privy authentication token and extract user data
 */
export async function verifyPrivyAuth(request: NextRequest) {
  if (!privyClient) {
    throw new Error('Privy client not initialized. NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set');
  }

  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid authorization header');
  }

  const token = authHeader.substring(7);

  try {
    // Verify the token with Privy
    const claims = await privyClient.verifyAuthToken(token);

    if (!claims) {
      throw new Error('Invalid authentication token');
    }

    // Get full user data from Privy
    const user = await privyClient.getUser(claims.userId);

    if (!user) {
      throw new Error('User not found');
    }

    // Extract social account data
    const twitterAccount = user.linkedAccounts?.find(account => account.type === 'twitter_oauth');
    const githubAccount = user.linkedAccounts?.find(account => account.type === 'github_oauth');

    // Extract wallet addresses
    const wallets = user.linkedAccounts?.filter(account => account.type === 'wallet') || [];
    const embeddedWallet = user.wallet?.address;
    const externalWallet = wallets[0]?.address;

    // Extract usernames from OAuth accounts
    const twitterUsername = (twitterAccount as { username?: string; name?: string } | undefined)?.username || (twitterAccount as { username?: string; name?: string } | undefined)?.name;
    const githubUsername = (githubAccount as { username?: string; name?: string } | undefined)?.username || (githubAccount as { username?: string; name?: string } | undefined)?.name;

    return {
      userId: claims.userId,
      twitterUsername,
      twitterVerified: !!twitterAccount,
      githubUsername,
      githubVerified: !!githubAccount,
      embeddedWallet,
      externalWallet,
      wallets: wallets.map(w => w.address)
    };
  } catch (error) {
    console.error('Error verifying Privy auth:', error);
    throw new Error('Authentication verification failed');
  }
}

/**
 * Check rate limiting for verification attempts
 */
export function checkRateLimit(identifier: string, maxAttempts = 5, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const record = rateLimitStore.get(identifier);

  if (!record || record.resetAt < now) {
    // Create new rate limit window
    rateLimitStore.set(identifier, {
      attempts: 1,
      resetAt: now + windowMs
    });
    return true;
  }

  if (record.attempts >= maxAttempts) {
    return false;
  }

  record.attempts++;
  return true;
}

/**
 * Acquire verification lock to prevent concurrent attempts
 */
export async function acquireVerificationLock(tokenAddress: string, timeoutMs = 30000): Promise<boolean> {
  const now = Date.now();
  const existingLock = verificationLocks.get(tokenAddress);

  if (existingLock && existingLock > now) {
    // Lock is still active
    return false;
  }

  // Acquire lock
  verificationLocks.set(tokenAddress, now + timeoutMs);
  return true;
}

/**
 * Release verification lock
 */
export function releaseVerificationLock(tokenAddress: string): void {
  verificationLocks.delete(tokenAddress);
}

/**
 * Generate challenge message for wallet signature verification
 */
export function generateChallengeMessage(
  walletAddress: string,
  twitterUsername?: string,
  githubUsername?: string
): { nonce: string; message: string; expiresAt: Date } {
  const nonce = createHash('sha256')
    .update(`${walletAddress}${Date.now()}${Math.random()}`)
    .digest('hex')
    .substring(0, 16);

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const socialParts = [];
  if (twitterUsername) socialParts.push(`Twitter: @${twitterUsername}`);
  if (githubUsername) socialParts.push(`GitHub: @${githubUsername}`);

  const message = [
    'Sign this message to verify your ownership of this wallet and linked social accounts.',
    '',
    'This request will NOT trigger any blockchain transaction or cost any gas fees.',
    '',
    `Wallet: ${walletAddress}`,
    socialParts.length > 0 ? socialParts.join('\n') : null,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`
  ].filter(Boolean).join('\n');

  return { nonce, message, expiresAt };
}

/**
 * Verify wallet signature
 */
export function verifyWalletSignature(
  message: string,
  signature: string,
  walletAddress: string
): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(signature, 'base64');
    const publicKey = new PublicKey(walletAddress);

    // Verify using nacl
    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBuffer()
    );
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

/**
 * Log audit event
 */
export async function logAuditEvent(
  pool: { query: (query: string, params: (string | null)[]) => Promise<unknown> },
  event: Omit<VerificationAuditLog, 'id' | 'created_at'>
): Promise<void> {
  const query = `
    INSERT INTO verification_audit_logs (
      event_type,
      token_address,
      wallet_address,
      social_twitter,
      social_github,
      ip_address,
      user_agent,
      error_message,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `;

  try {
    await pool.query(query, [
      event.event_type,
      event.token_address || null,
      event.wallet_address || null,
      event.social_twitter || null,
      event.social_github || null,
      event.ip_address || null,
      event.user_agent || null,
      event.error_message || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    ]);
  } catch (error) {
    console.error('Failed to log audit event:', error);
    // Don't throw - audit logging should not break the main flow
  }
}

/**
 * Get client IP address from request
 */
export function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}