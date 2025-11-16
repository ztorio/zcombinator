'use client';

import { SwapContent } from '@/components/SwapContent';
import { useSearchParams } from 'next/navigation';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_CONFIG } from './constants';
import { Token } from './types';
import { Suspense } from 'react';

// Helper function to map token address to Token type
function getTokenFromAddress(address: string): Token | null {
  try {
    const pubkey = new PublicKey(address);
    for (const [token, config] of Object.entries(TOKEN_CONFIG)) {
      if (config.mint.equals(pubkey)) {
        return token as Token;
      }
    }
  } catch {
    // Invalid address
  }
  return null;
}

function SwapPageContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get('token');
  const selectedToken = tokenParam ? getTokenFromAddress(tokenParam) : null;

  return <SwapContent initialToToken={selectedToken || undefined} />;
}

export default function SwapPage() {
  return (
    <Suspense fallback={<SwapContent />}>
      <SwapPageContent />
    </Suspense>
  );
}