'use client';
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

import { TextInput } from '@/components/TextInput';
import { useWallet } from '@/components/WalletProvider';
import { useState, useMemo, useRef, useEffect } from 'react';
import { useTheme } from '@/contexts/ThemeContext';
import { Keypair, Transaction, Connection } from '@solana/web3.js';
import { useSignTransaction } from '@privy-io/react-auth/solana';
import { useRouter } from 'next/navigation';
import bs58 from 'bs58';

export default function LaunchPage() {
  const { activeWallet, externalWallet } = useWallet();
  const { signTransaction } = useSignTransaction();
  const router = useRouter();
  const { theme } = useTheme();
  const textColor = theme === 'dark' ? '#ffffff' : '#0a0a0a';
  const inputBg = theme === 'dark' ? '#222222' : '#ffffff';
  const inputBorder = theme === 'dark' ? '#1C1C1C' : '#e5e5e5';
  const placeholderColor = theme === 'dark' ? 'rgba(164,164,164,0.8)' : 'rgba(164,164,164,0.8)';

  // Detect mobile screen size for placeholder text
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const [formData, setFormData] = useState({
    name: '',
    ticker: '',
    caEnding: '',
    image: '',
    imageFilename: '',
    imageFile: null as File | null,
    website: '',
    twitter: '',
    discord: '',
    github: '',
    description: '',
    creatorTwitter: '',
    creatorGithub: '',
    presale: false,
    presaleTokens: [''],
    quoteToken: 'ZC' as 'SOL' | 'ZC'
  });

  const [isLaunching, setIsLaunching] = useState(false);
  const [isGeneratingCA, setIsGeneratingCA] = useState(false);
  const [transactionSignature, setTransactionSignature] = useState<string | null>(null);
  const cancelGenerationRef = useRef(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [createdTokenInfo, setCreatedTokenInfo] = useState<{
    name: string;
    symbol: string;
    tokenAddress: string;
    image?: string;
  } | null>(null);

  // Validation functions
  const validateName = (name: string) => {
    // Required field, max 32 characters
    return name.length > 0 && name.length <= 32;
  };

  const validateTicker = (ticker: string) => {
    // Required field, max 10 characters
    return ticker.length > 0 && ticker.length <= 10;
  };

  const validateCAEnding = (caEnding: string) => {
    // Optional field - valid if empty or up to 3 characters
    if (caEnding.length > 3) return false;

    // Check for invalid Base58 characters: 0, O, I, l
    const invalidChars = /[0OIl]/;
    return !invalidChars.test(caEnding);
  };

  const validateWebsite = (website: string) => {
    // Optional field - valid if empty or valid URL
    if (!website) return true;
    try {
      // If no protocol, try adding https://
      const urlToTest = website.match(/^https?:\/\//) ? website : `https://${website}`;
      new URL(urlToTest);
      return true;
    } catch {
      return false;
    }
  };

  const validateTwitter = (twitter: string) => {
    // Optional field - valid if empty or Twitter/X URL (profile or tweet)
    if (!twitter) return true;
    // Accept with or without protocol
    const urlToTest = twitter.match(/^https?:\/\//) ? twitter : `https://${twitter}`;
    return /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+(\/status\/\d+)?\/?(\?.*)?$/.test(urlToTest);
  };

  const validateCreatorTwitter = (twitter: string) => {
    // Optional field - valid if empty or Twitter/X profile URL
    if (!twitter) return true;
    // Accept with or without protocol
    const urlToTest = twitter.match(/^https?:\/\//) ? twitter : `https://${twitter}`;
    return /^https?:\/\/(www\.)?(twitter|x)\.com\/[A-Za-z0-9_]+\/?(\?.*)?$/.test(urlToTest);
  };

  const validateCreatorGithub = (github: string) => {
    // Optional field - valid if empty or GitHub profile URL
    if (!github) return true;
    // Accept with or without protocol
    const urlToTest = github.match(/^https?:\/\//) ? github : `https://${github}`;
    return /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9-]+\/?$/.test(urlToTest);
  };

  const validateDescription = (description: string) => {
    // Optional field - valid if empty or under 280 characters
    return description.length <= 280;
  };

  const validateSolanaAddress = (address: string) => {
    // Optional field - valid if empty
    if (!address) return true;
    // Check if it's a valid base58 address (typically 32-44 characters)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    return base58Regex.test(address);
  };

  // Track field validity
  const fieldValidity = useMemo(() => ({
    name: validateName(formData.name),
    ticker: validateTicker(formData.ticker),
    caEnding: validateCAEnding(formData.caEnding),
    website: validateWebsite(formData.website),
    twitter: validateTwitter(formData.twitter),
    description: validateDescription(formData.description),
    image: !!formData.image,
    creatorTwitter: validateCreatorTwitter(formData.creatorTwitter),
    creatorGithub: validateCreatorGithub(formData.creatorGithub),
    presaleTokens: !formData.presale || formData.presaleTokens.every(t => validateSolanaAddress(t))
  }), [formData]);

  // Check if basic info is valid (name, ticker, image are required)
  const isBasicInfoValid = useMemo(() => {
    return fieldValidity.name &&
           fieldValidity.ticker &&
           fieldValidity.image;
  }, [fieldValidity]);

  // Check if form is valid (only name, ticker, image are required)
  const isFormValid = useMemo(() => {
    return fieldValidity.name &&
           fieldValidity.ticker &&
           fieldValidity.caEnding &&
           fieldValidity.website &&
           fieldValidity.twitter &&
           fieldValidity.description &&
           fieldValidity.image &&
           fieldValidity.creatorTwitter &&
           fieldValidity.creatorGithub &&
           fieldValidity.presaleTokens;
  }, [fieldValidity]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleAddPresaleToken = () => {
    if (formData.presaleTokens.length < 5) {
      setFormData(prev => ({
        ...prev,
        presaleTokens: [...prev.presaleTokens, '']
      }));
    }
  };

  const handleRemovePresaleToken = (index: number) => {
    setFormData(prev => {
      const newTokens = prev.presaleTokens.filter((_, i) => i !== index);
      return {
        ...prev,
        presaleTokens: newTokens.length === 0 ? [''] : newTokens
      };
    });
  };

  const handlePresaleTokenChange = (index: number, value: string) => {
    setFormData(prev => ({
      ...prev,
      presaleTokens: prev.presaleTokens.map((token, i) => i === index ? value : token)
    }));
  };


  const generateTokenKeypair = async (caEnding?: string) => {
    // Generate keypair with optional custom ending

    if (!caEnding) {
      // Generate a simple keypair if no CA ending specified
      const keypair = Keypair.generate();
      const address = keypair.publicKey.toString();
      // Simple keypair generated successfully
      return { keypair, address };
    }

    // Searching for keypair with custom ending

    // Generate keypairs until we find one ending with the specified CA ending
    let keypair: Keypair;
    let attempts = 0;
    const maxAttempts = 10000000; // Limit attempts to prevent infinite loop

    do {
      // Check for cancellation
      if (cancelGenerationRef.current) {
        // Generation cancelled by user
        throw new Error('Generation cancelled');
      }

      keypair = Keypair.generate();
      attempts++;

      // Update progress every 10000 attempts
      if (attempts % 10000 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    } while (!keypair.publicKey.toString().endsWith(caEnding) && attempts < maxAttempts && !cancelGenerationRef.current);

    // Check if cancelled after the loop
    if (cancelGenerationRef.current) {
      // Generation cancelled by user after loop
      throw new Error('Generation cancelled');
    }

    const finalAddress = keypair.publicKey.toString();
    // Found matching keypair successfully

    return { keypair, address: finalAddress };
  };

  const handleCancel = () => {
    // Cancel button clicked
    cancelGenerationRef.current = true;
  };

  const handleLaunch = async () => {
    if (!isBasicInfoValid || isLaunching || isGeneratingCA || !externalWallet || !activeWallet) return;

    cancelGenerationRef.current = false; // Reset cancel flag

    try {
      // For presales, we don't generate the keypair here
      let keypair: Keypair | null = null;

      if (!formData.presale) {
        // Only generate keypair for non-presale launches
        const hasCAEnding = formData.caEnding && formData.caEnding.length > 0;

        if (hasCAEnding) {
          setIsGeneratingCA(true);
        }

        const result = await generateTokenKeypair(hasCAEnding ? formData.caEnding : undefined);
        keypair = result.keypair;

        if (hasCAEnding) {
          setIsGeneratingCA(false);
        }
      }

      setIsLaunching(true);

      // Step 1: Upload metadata
      const metadata = {
        name: formData.name,
        symbol: formData.ticker,
        description: formData.description || undefined,
        image: formData.image || undefined,
        website: formData.website ? (formData.website.match(/^https?:\/\//) ? formData.website : `https://${formData.website}`) : undefined,
        twitter: formData.twitter ? (formData.twitter.match(/^https?:\/\//) ? formData.twitter : `https://${formData.twitter}`) : undefined,
        discord: formData.discord ? (formData.discord.match(/^https?:\/\//) ? formData.discord : `https://${formData.discord}`) : undefined,
        github: formData.github ? (formData.github.match(/^https?:\/\//) ? formData.github : `https://${formData.github}`) : undefined,
        caEnding: formData.caEnding || undefined,
        creatorTwitter: formData.creatorTwitter ? (formData.creatorTwitter.match(/^https?:\/\//) ? formData.creatorTwitter : `https://${formData.creatorTwitter}`) : undefined,
        creatorGithub: formData.creatorGithub ? (formData.creatorGithub.match(/^https?:\/\//) ? formData.creatorGithub : `https://${formData.creatorGithub}`) : undefined,
      };

      const metadataResponse = await fetch('/api/upload-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      });

      const metadataData = await metadataResponse.json();

      if (!metadataResponse.ok) {
        throw new Error(metadataData.error || 'Metadata upload failed');
      }

      // Step 2: Check if presale - if so, create presale record and redirect
      if (formData.presale) {
        const presaleResponse = await fetch('/api/presale', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: formData.name,
            symbol: formData.ticker,
            uri: metadataData.url,
            creatorWallet: externalWallet.toString(),
            presaleTokens: formData.presaleTokens.filter(t => t.trim()),
            caEnding: formData.caEnding || undefined,
            creatorTwitter: formData.creatorTwitter ? (formData.creatorTwitter.match(/^https?:\/\//) ? formData.creatorTwitter : `https://${formData.creatorTwitter}`) : undefined,
            creatorGithub: formData.creatorGithub ? (formData.creatorGithub.match(/^https?:\/\//) ? formData.creatorGithub : `https://${formData.creatorGithub}`) : undefined,
          }),
        });

        const presaleData = await presaleResponse.json();

        if (!presaleResponse.ok) {
          throw new Error(presaleData.error || 'Presale creation failed');
        }

        // Redirect to presale page
        router.push(`/presale/${presaleData.tokenAddress}`);
        return;
      }

      // Step 2: Create launch transaction (for normal launches)
      if (!keypair) {
        throw new Error('Keypair not generated for normal launch');
      }

      const launchResponse = await fetch('/api/launch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          baseMintPublicKey: keypair.publicKey.toString(),
          name: formData.name,
          symbol: formData.ticker,
          uri: metadataData.url,
          payerPublicKey: externalWallet.toString(),
          quoteToken: formData.quoteToken,
        }),
      });

      const launchData = await launchResponse.json();

      if (!launchResponse.ok) {
        throw new Error(launchData.error || 'Transaction creation failed');
      }

      // Step 3: Sign transaction following Phantom's recommended order
      // Per Phantom docs: wallet signs first, then additional signers
      const transactionBuffer = bs58.decode(launchData.transaction);
      const transaction = Transaction.from(transactionBuffer);

      // 1. Phantom wallet signs first (user is fee payer)
      const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

      const { signedTransaction: signedTxBytes } = await signTransaction({
        transaction: serializedTransaction,
        wallet: activeWallet!
      });

      const walletSignedTx = Transaction.from(signedTxBytes);

      // 2. Additional signer (base mint keypair) signs after
      walletSignedTx.partialSign(keypair);

      // 3. Send the fully signed transaction
      const connection = new Connection(process.env.NEXT_PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com');
      const signature = await connection.sendRawTransaction(
        walletSignedTx.serialize(),
        {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        }
      );

      const signedTransaction = { signature };

      setTransactionSignature(signedTransaction.signature);
      // Transaction sent successfully

      // Step 4: Confirm transaction and record in database
      const confirmResponse = await fetch('/api/launch/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transactionSignature: signedTransaction.signature,
          baseMint: launchData.baseMint,
          name: formData.name,
          symbol: formData.ticker,
          uri: metadataData.url,
          creatorWallet: externalWallet.toString(),
          creatorTwitter: formData.creatorTwitter || undefined,
          creatorGithub: formData.creatorGithub || undefined,
        }),
      });

      await confirmResponse.json();

      if (!confirmResponse.ok) {
        // Failed to confirm launch
      } else {
        // Launch confirmed and recorded in database
        // Show success modal with token info
        setCreatedTokenInfo({
          name: formData.name,
          symbol: formData.ticker,
          tokenAddress: launchData.baseMint,
          image: formData.image || undefined,
        });
        setShowSuccessModal(true);
      }

    } catch (error) {
      // Launch error occurred
      if (error instanceof Error && error.message === 'Generation cancelled') {
        // Launch cancelled - no metadata will be uploaded
      } else {
        alert(`Failed to launch token: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } finally {
      setIsLaunching(false);
      setIsGeneratingCA(false);
      cancelGenerationRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-[40px] w-full pl-[20px]">
      {/* Top Group: Main Token Info + Additional Info (Quote Token, Presale) */}
      <div className="flex flex-col lg:flex-row gap-[80px] items-start lg:items-center w-full">
        {/* Left: Main Token Info */}
        <div className="flex flex-col gap-[16px] items-start w-full lg:w-[476px]">
          <h2 className="font-medium text-[24px] leading-[1.2] tracking-[-0.24px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
            Main token info
          </h2>

          {/* Token Image and Name/Ticker */}
          <div className="flex flex-col sm:flex-row gap-[20px] items-start sm:items-center w-full">
            {/* Token Image */}
            <div className="flex flex-col gap-[10px] items-start">
              <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                token Image*
              </label>
              <div className="relative w-[156px] h-[156px]">
                {formData.image ? (
                  <div
                    className="w-full h-full rounded-[16px] border border-[#403d6d] border-dashed bg-[#d1cfe7] cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) {
                          // Create preview using FileReader
                          const reader = new FileReader();
                          reader.onload = (e) => {
                            const result = e.target?.result as string;
                            if (result) {
                              setFormData(prev => ({ ...prev, image: result, imageFilename: file.name, imageFile: file }));
                            }
                          };
                          reader.readAsDataURL(file);
                          
                          // Upload to server in background
                          const formDataObj = new FormData();
                          formDataObj.append('file', file);
                          formDataObj.append('name', formData.name || 'token');
                          try {
                            const response = await fetch('/api/upload', {
                              method: 'POST',
                              body: formDataObj,
                            });
                            const data = await response.json();
                            if (response.ok && data.url && !data.url.includes('z-pfp.jpg')) {
                              // Only update if we got a real URL (not mock)
                              setFormData(prev => ({ ...prev, image: data.url, imageFilename: file.name }));
                            }
                          } catch (error) {
                            console.error('Upload error:', error);
                          }
                        }
                      };
                      input.click();
                    }}
                  >
                    <img src={formData.image} alt="Token" className="w-full h-full object-cover rounded-[16px]" />
                  </div>
                ) : (
                  <div
                    className="w-full h-full rounded-[16px] border-[#403d6d] border-dashed cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-center"
                    style={{
                      backgroundColor: theme === 'dark' ? '#35343F' : '#d1cfe7',
                      border: '2px dashed #403d6d',
                    }}
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.onchange = async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (file) {
                          // Create preview using FileReader
                          const reader = new FileReader();
                          reader.onload = (e) => {
                            const result = e.target?.result as string;
                            if (result) {
                              setFormData(prev => ({ ...prev, image: result, imageFilename: file.name, imageFile: file }));
                            }
                          };
                          reader.readAsDataURL(file);
                          
                          // Upload to server in background
                          const formDataObj = new FormData();
                          formDataObj.append('file', file);
                          formDataObj.append('name', formData.name || 'token');
                          try {
                            const response = await fetch('/api/upload', {
                              method: 'POST',
                              body: formDataObj,
                            });
                            const data = await response.json();
                            if (response.ok && data.url && !data.url.includes('z-pfp.jpg')) {
                              // Only update if we got a real URL (not mock)
                              setFormData(prev => ({ ...prev, image: data.url, imageFilename: file.name }));
                            }
                          } catch (error) {
                            console.error('Upload error:', error);
                          }
                        }
                      };
                      input.click();
                    }}
                  >
                    <p className="font-normal text-[14px] leading-[20px] text-center whitespace-pre-wrap" style={{ fontFamily: 'SF Pro Text, sans-serif', color: textColor }}>
                      Click to select
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Name, Quote Token and Ticker */}
            <div className="flex flex-col gap-[20px] items-start w-full sm:w-auto">
              {/* Name and Quote Token */}
              <div className="flex flex-col sm:flex-row gap-[24px] items-start w-full">
                {/* Name */}
                <div className="flex flex-col items-start w-full sm:w-[300px]">
                  <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                    Name*
                  </label>
                  <TextInput
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleInputChange}
                    placeholder="Enter a name"
                    maxLength={32}
                    autoComplete="off"
                    hasError={formData.name ? !fieldValidity.name : false}
                    className="w-full"
                  />
                </div>

                {/* Quote Token */}
                <div className="flex flex-col gap-[10px] items-start">
                  <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                    Quote token
                  </label>
                  <div className="flex gap-[14px] items-start">
                    <button
                      onClick={() => setFormData(prev => ({ ...prev, quoteToken: 'ZC' }))}
                      className="rounded-[8px] px-3 py-2 h-[40px] transition-opacity"
                      style={{
                        fontFamily: 'Inter, sans-serif',
                        backgroundColor: formData.quoteToken === 'ZC' ? (theme === 'dark' ? '#5A5798' : '#403d6d') : (theme === 'dark' ? '#222222' : '#ffffff'),
                        color: theme === 'dark' ? '#ffffff' : (formData.quoteToken === 'ZC' ? '#ffffff' : '#0a0a0a'),
                        border: formData.quoteToken === 'ZC' ? '1px solid transparent' : `1px solid ${theme === 'dark' ? '#1C1C1C' : '#e5e5e5'}`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = formData.quoteToken === 'ZC'
                          ? (theme === 'dark' ? '#2F2D4F' : '#403d6d')
                          : (theme === 'dark' ? '#2a2a2a' : '#f6f6f7');
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = formData.quoteToken === 'ZC'
                          ? (theme === 'dark' ? '#5A5798' : '#403d6d')
                          : (theme === 'dark' ? '#222222' : '#ffffff');
                      }}
                    >
                      <span className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize">$ZC</span>
                    </button>
                    <button
                      onClick={() => setFormData(prev => ({ ...prev, quoteToken: 'SOL' }))}
                      className="rounded-[8px] px-3 py-2 h-[40px] transition-opacity"
                      style={{
                        fontFamily: 'Inter, sans-serif',
                        backgroundColor: formData.quoteToken === 'SOL' ? (theme === 'dark' ? '#5A5798' : '#403d6d') : (theme === 'dark' ? '#222222' : '#ffffff'),
                        color: theme === 'dark' ? '#ffffff' : (formData.quoteToken === 'SOL' ? '#ffffff' : '#0a0a0a'),
                        border: formData.quoteToken === 'SOL' ? '1px solid transparent' : `1px solid ${theme === 'dark' ? '#1C1C1C' : '#e5e5e5'}`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = formData.quoteToken === 'SOL'
                          ? (theme === 'dark' ? '#2F2D4F' : '#403d6d')
                          : (theme === 'dark' ? '#2a2a2a' : '#f6f6f7');
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = formData.quoteToken === 'SOL'
                          ? (theme === 'dark' ? '#5A5798' : '#403d6d')
                          : (theme === 'dark' ? '#222222' : '#ffffff');
                      }}
                    >
                      <span className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize">$SOL</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Ticker and Presale */}
              <div className="flex flex-col sm:flex-row gap-[24px] items-start sm:items-center w-full">
                {/* Ticker */}
                <div className="flex flex-col items-start w-full sm:w-[300px]">
                  <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                    Ticker*
                  </label>
                  <TextInput
                    type="text"
                    name="ticker"
                    value={formData.ticker}
                    onChange={handleInputChange}
                    placeholder="Enter a ticker"
                    maxLength={10}
                    autoComplete="off"
                    hasError={formData.ticker ? !fieldValidity.ticker : false}
                    className="w-full"
                  />
                </div>

                {/* Presale */}
                <div className="flex flex-col gap-[6px] items-start">
                  <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                    Presale
                  </label>
                  <div className="flex flex-col gap-[10px] items-start">
                    <div className="flex gap-[10px] items-center">
                      <button
                        onClick={() => setFormData(prev => ({ ...prev, presale: !prev.presale }))}
                        className="relative w-[40px] h-[22px] rounded-full transition-colors"
                        style={{
                          backgroundColor: formData.presale 
                            ? (theme === 'dark' ? '#5A5798' : '#403d6d')
                            : (theme === 'dark' ? '#222222' : '#e5e5e5'),
                          border: theme === 'dark' && !formData.presale ? '1px solid #1C1C1C' : 'none'
                        }}
                      >
                        <div
                          className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow-[0px_2px_4px_0px_rgba(39,39,39,0.1)] transition-transform ${
                            formData.presale ? 'translate-x-[18px]' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      {formData.presale && formData.presaleTokens.length > 0 && (
                        <div className="flex gap-[10px] items-center">
                          <TextInput
                            type="text"
                            value={formData.presaleTokens[0] || ''}
                            onChange={(e) => handlePresaleTokenChange(0, e.target.value)}
                            placeholder="Enter CA here"
                            className="w-[168px]"
                            style={{ fontFamily: 'SF Pro Text, sans-serif' }}
                          />
                          {formData.presaleTokens.length < 5 && (
                            <button
                              onClick={handleAddPresaleToken}
                              className="flex items-center justify-center w-[40px] h-[40px] rounded-[8px] transition-opacity cursor-pointer"
                              style={{
                                fontFamily: 'Inter, sans-serif',
                                backgroundColor: theme === 'dark' ? '#222222' : '#ffffff',
                                border: `1px solid ${theme === 'dark' ? '#1C1C1C' : '#e5e5e5'}`,
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = theme === 'dark' ? '#2a2a2a' : '#f6f6f7';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = theme === 'dark' ? '#222222' : '#ffffff';
                              }}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: theme === 'dark' ? '#ffffff' : '#0a0a0a' }}>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {formData.presale && formData.presaleTokens.length > 1 && (
                      <div className="flex flex-col gap-[10px] items-start ml-[50px]">
                        {formData.presaleTokens.slice(1).map((token, index) => (
                          <div key={index + 1} className="flex gap-[10px] items-center">
                            <TextInput
                              type="text"
                              value={token}
                              onChange={(e) => handlePresaleTokenChange(index + 1, e.target.value)}
                              placeholder="Enter CA here"
                              className="w-[168px]"
                              style={{ fontFamily: 'SF Pro Text, sans-serif' }}
                            />
                            <button
                              onClick={() => handleRemovePresaleToken(index + 1)}
                              className="flex items-center justify-center w-[40px] h-[40px] rounded-[8px] transition-opacity cursor-pointer"
                              style={{
                                fontFamily: 'Inter, sans-serif',
                                backgroundColor: theme === 'dark' ? '#222222' : '#ffffff',
                                border: `1px solid ${theme === 'dark' ? '#1C1C1C' : '#e5e5e5'}`,
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = theme === 'dark' ? '#2a2a2a' : '#f6f6f7';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = theme === 'dark' ? '#222222' : '#ffffff';
                              }}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: theme === 'dark' ? '#ffffff' : '#0a0a0a' }}>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                            {index === formData.presaleTokens.length - 2 && formData.presaleTokens.length < 5 && (
                              <button
                                onClick={handleAddPresaleToken}
                                className="flex items-center justify-center w-[40px] h-[40px] rounded-[8px] transition-opacity cursor-pointer"
                                style={{
                                  fontFamily: 'Inter, sans-serif',
                                  backgroundColor: theme === 'dark' ? '#222222' : '#ffffff',
                                  border: `1px solid ${theme === 'dark' ? '#1C1C1C' : '#e5e5e5'}`,
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.backgroundColor = theme === 'dark' ? '#2a2a2a' : '#f6f6f7';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.backgroundColor = theme === 'dark' ? '#222222' : '#ffffff';
                                }}
                              >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: theme === 'dark' ? '#ffffff' : '#0a0a0a' }}>
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Group: Socials */}
      <div className="flex flex-col items-start w-full">
        {/* Socials */}
        <div className="flex flex-col gap-[24px] items-start w-full">
          <div className="flex flex-col gap-[16px] items-start w-full">
            <h3 className="font-medium text-[24px] leading-[1.2] tracking-[-0.24px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
              Socials
            </h3>
          
            {/* Socials Row 1: Website, X, and Dev X Profile URL */}
            <div className="flex flex-row items-start gap-[20px] w-full">
              {/* Website */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  Website
                </label>
                <TextInput
                  type="url"
                  name="website"
                  value={formData.website}
                  onChange={handleInputChange}
                  placeholder="zcombinator.io"
                  autoComplete="off"
                  hasError={formData.website ? !fieldValidity.website : false}
                  className="w-full"
                />
              </div>

              {/* X */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  X
                </label>
                <TextInput
                  type="text"
                  name="twitter"
                  value={formData.twitter}
                  onChange={handleInputChange}
                  placeholder="x.com"
                  autoComplete="off"
                  hasError={formData.twitter ? !fieldValidity.twitter : false}
                  className="w-full"
                />
              </div>

              {/* Dev X Profile URL */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  Dev X Profile URL
                </label>
                <TextInput
                  type="text"
                  name="creatorTwitter"
                  value={formData.creatorTwitter}
                  onChange={handleInputChange}
                  placeholder="x.com/dev"
                  autoComplete="off"
                  hasError={formData.creatorTwitter ? !fieldValidity.creatorTwitter : false}
                  className="w-full"
                />
              </div>
            </div>

            {/* Socials Row 2: Discord, GitHub, and Dev GitHub Profile URL */}
            <div className="flex flex-row items-start gap-[20px] w-full">
              {/* Discord */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  Discord
                </label>
                <TextInput
                  type="text"
                  name="discord"
                  value={formData.discord || ''}
                  onChange={handleInputChange}
                  placeholder="discord.com"
                  autoComplete="off"
                  className="w-full"
                />
              </div>

              {/* GitHub */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  GitHub
                </label>
                <TextInput
                  type="text"
                  name="github"
                  value={formData.github || ''}
                  onChange={handleInputChange}
                  placeholder="Github.com"
                  autoComplete="off"
                  className="w-full"
                />
              </div>

              {/* Dev GitHub Profile URL */}
              <div className="flex flex-col items-start w-[220px]">
                <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize mb-[10px]" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                  Dev GitHub Profile URL
                </label>
                <TextInput
                  type="text"
                  name="creatorGithub"
                  value={formData.creatorGithub}
                  onChange={handleInputChange}
                  placeholder="Github.com/dev"
                  autoComplete="off"
                  hasError={formData.creatorGithub ? !fieldValidity.creatorGithub : false}
                  className="w-full"
                />
              </div>
            </div>

            {/* Description */}
            <div className="flex flex-col gap-[20px] h-[128px] items-start" style={{ width: 'calc(220px * 3 + 20px * 2)' }}>
              <label className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize" style={{ fontFamily: 'Inter, sans-serif', color: textColor }}>
                Description
              </label>
              <textarea
                name="description"
                value={formData.description}
                onChange={handleInputChange}
                placeholder="Enter your description here..."
                maxLength={280}
                rows={4}
                className={`w-full h-full rounded-[8px] px-[9px] py-2 text-[16px] leading-[24px] focus:outline-none focus:border-[#403d6d] resize-none ${
                  formData.description && !fieldValidity.description
                    ? 'border-red-400'
                    : ''
                } ${theme === 'dark' ? 'placeholder:text-[rgba(164,164,164,0.8)]' : 'placeholder:text-[rgba(164,164,164,0.8)]'}`}
                style={{
                  fontFamily: 'Inter, sans-serif',
                  backgroundColor: inputBg,
                  border: `1px solid ${formData.description && !fieldValidity.description ? '#ef4444' : inputBorder}`,
                  color: textColor,
                }}
              />
            </div>

            {/* Launch Button */}
            <div className="flex items-center justify-center py-5" style={{ width: 'calc(220px * 3 + 20px * 2)' }}>
              <button
                onClick={externalWallet && isBasicInfoValid ? handleLaunch : undefined}
                disabled={!externalWallet || !isBasicInfoValid || isLaunching || isGeneratingCA}
                className="w-full rounded-[8px] px-4 py-3 transition-opacity disabled:cursor-not-allowed"
                style={{
                  fontFamily: 'Inter, sans-serif',
                  backgroundColor: (!externalWallet || !isBasicInfoValid || isLaunching || isGeneratingCA)
                    ? (theme === 'dark' ? '#404040' : '#f1f3f9')
                    : (theme === 'dark' ? '#5A5798' : '#403d6d'),
                  color: theme === 'dark' ? '#ffffff' : (!externalWallet || !isBasicInfoValid ? '#0a0a0a' : '#ffffff'),
                }}
                onMouseEnter={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.backgroundColor = theme === 'dark' ? '#2F2D4F' : '#403d6d';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!e.currentTarget.disabled) {
                    e.currentTarget.style.backgroundColor = theme === 'dark' ? '#5A5798' : '#403d6d';
                  }
                }}
              >
                <span className="font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize">
                  {isGeneratingCA || isLaunching
                    ? 'Creating...'
                    : !externalWallet
                    ? 'Enter Main info first'
                    : !isBasicInfoValid
                    ? 'Enter Main info first'
                    : 'Launch'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Transaction Success Message */}
      {transactionSignature && (
        <div className="mt-6 px-5">
          <p className="text-lg text-green-400" style={{ fontFamily: 'Inter, sans-serif' }}>
            Success!{' '}
            <a
              href={`https://solscan.io/tx/${transactionSignature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-green-300 underline"
            >
              Transaction
            </a>
          </p>
        </div>
      )}

      {/* Cancel Button for CA Generation */}
      {isGeneratingCA && (
        <div className="px-5">
          <button
            onClick={handleCancel}
            className="text-[16px] text-[#717182] hover:text-[#0a0a0a] transition-colors cursor-pointer"
            style={{ fontFamily: 'Inter, sans-serif' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Success Modal */}
      {showSuccessModal && createdTokenInfo && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowSuccessModal(false)}>
          <div className="bg-[#ffffff] rounded-[12px] p-[24px] max-w-[500px] w-full mx-5 flex flex-col gap-[20px]" onClick={(e) => e.stopPropagation()} style={{ fontFamily: 'Inter, sans-serif' }}>
            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="font-medium text-[24px] leading-[1.2] tracking-[-0.24px] text-[#0a0a0a]" style={{ fontFamily: 'Inter, sans-serif' }}>
                Token successfully created
              </h2>
              <button
                onClick={() => setShowSuccessModal(false)}
                className="text-[#717182] hover:text-[#0a0a0a] transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Token Info */}
            <div className="flex flex-col gap-[16px]">
              {/* Token Image and Name */}
              <div className="flex gap-[14px] items-center">
                <div className="bg-[#030213] rounded-[12px] w-[64px] h-[64px] flex items-center justify-center shrink-0 overflow-hidden">
                  {createdTokenInfo.image ? (
                    <img
                      src={createdTokenInfo.image}
                      alt={createdTokenInfo.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-[40px] h-[40px] rounded-[8px] bg-[#403d6d]" />
                  )}
                </div>
                <div className="flex flex-col gap-[4px]">
                  <p className="font-medium text-[20px] leading-[1.4] text-[#0a0a0a]" style={{ fontFamily: 'Inter, sans-serif' }}>
                    {createdTokenInfo.name}
                  </p>
                  <p className="font-medium text-[14px] leading-[1.4] text-[#717182] uppercase" style={{ fontFamily: 'Inter, sans-serif' }}>
                    {createdTokenInfo.symbol}
                  </p>
                </div>
              </div>

              {/* Token Address */}
              <div className="flex flex-col gap-[8px]">
                <p className="font-semibold text-[14px] leading-[1.4] text-[#0a0a0a]" style={{ fontFamily: 'Inter, sans-serif' }}>
                  Token Address:
                </p>
                <div className="flex gap-[8px] items-center">
                  <p className="font-normal text-[14px] leading-[1.4] text-[#717182] break-all" style={{ fontFamily: 'Inter, sans-serif' }}>
                    {createdTokenInfo.tokenAddress}
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(createdTokenInfo.tokenAddress);
                    }}
                    className="text-[#717182] hover:text-[#0a0a0a] transition-colors shrink-0"
                    title="Copy address"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-[12px] items-center justify-end">
              <button
                onClick={() => setShowSuccessModal(false)}
                className="bg-[#ffffff] border border-[#e5e5e5] rounded-[8px] px-4 py-3 text-[#0a0a0a] font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize transition-colors hover:bg-[#f6f6f7]"
                style={{ fontFamily: 'Inter, sans-serif' }}
              >
                Close
              </button>
              <button
                onClick={() => {
                  setShowSuccessModal(false);
                  router.push('/portfolio');
                }}
                className="bg-[#403d6d] rounded-[8px] px-4 py-3 text-white font-semibold text-[16px] leading-[16px] tracking-[0.32px] capitalize transition-opacity hover:opacity-90"
                style={{ fontFamily: 'Inter, sans-serif' }}
              >
                View in Portfolio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
