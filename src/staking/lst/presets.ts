import type { ChainId } from "@/types/config";
import type { Address } from "@/types/address";
import { fromAddress } from "@/types/address";

export interface LSTConfig {
  readonly symbol: string;
  readonly lstSymbol: string;
  readonly assetAddress: Address;
  readonly lstAddress: Address;
  readonly decimals: number;
}

const SN_MAIN_LST: Record<string, LSTConfig> = {
  STRK: {
    symbol: "STRK",
    lstSymbol: "xSTRK",
    assetAddress: fromAddress(
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
    ),
    lstAddress: fromAddress(
      "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a"
    ),
    decimals: 18,
  },
  WBTC: {
    symbol: "WBTC",
    lstSymbol: "xWBTC",
    assetAddress: fromAddress(
      "0x3fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac"
    ),
    lstAddress: fromAddress(
      "0x6a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13"
    ),
    decimals: 8,
  },
  tBTC: {
    symbol: "tBTC",
    lstSymbol: "xtBTC",
    assetAddress: fromAddress(
      "0x4daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f"
    ),
    lstAddress: fromAddress(
      "0x43a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91"
    ),
    decimals: 18,
  },
  LBTC: {
    symbol: "LBTC",
    lstSymbol: "xLBTC",
    assetAddress: fromAddress(
      "0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4"
    ),
    lstAddress: fromAddress(
      "0x7dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0"
    ),
    decimals: 8,
  },
  solvBTC: {
    symbol: "solvBTC",
    lstSymbol: "xsBTC",
    assetAddress: fromAddress(
      "0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68"
    ),
    lstAddress: fromAddress(
      "0x580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9"
    ),
    decimals: 18,
  },
};

const SN_SEPOLIA_LST: Record<string, LSTConfig> = {
  STRK: {
    symbol: "STRK",
    lstSymbol: "xSTRK",
    assetAddress: fromAddress(
      "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
    ),
    lstAddress: fromAddress(
      "0x042de5b868da876768213c48019b8d46cd484e66013ae3275f8a4b97b31fc7eb"
    ),
    decimals: 18,
  },
  TBTC1: {
    symbol: "TBTC1",
    lstSymbol: "xBTC1",
    assetAddress: fromAddress(
      "0x044ad07751ad782288413c7db42c48e1c4f6195876bca3b6caef449bb4fb8d36"
    ),
    lstAddress: fromAddress(
      "0x036a2c3c56ae806b12a84bb253cbc1a009e3da5469e6a736c483303b864c8e2b"
    ),
    decimals: 8,
  },
  TBTC2: {
    symbol: "TBTC2",
    lstSymbol: "xBTC2",
    assetAddress: fromAddress(
      "0x07e97477601e5606359303cf50c050fd3ba94f66bd041f4ed504673ba2b81696"
    ),
    lstAddress: fromAddress(
      "0x0226324f63d994834e4729dd1bab443fe50af8e97c608b812ee1f950ceae68c7"
    ),
    decimals: 8,
  },
};

const PRESETS: Record<string, Record<string, LSTConfig>> = {
  SN_MAIN: SN_MAIN_LST,
  SN_SEPOLIA: SN_SEPOLIA_LST,
};

function buildLookup(
  chainConfig: Record<string, LSTConfig>
): Map<string, LSTConfig> {
  const m = new Map<string, LSTConfig>();
  for (const c of Object.values(chainConfig)) {
    m.set(c.symbol.toLowerCase(), c);
  }
  return m;
}

const LOOKUPS: Record<string, Map<string, LSTConfig>> = {
  SN_MAIN: buildLookup(SN_MAIN_LST),
  SN_SEPOLIA: buildLookup(SN_SEPOLIA_LST),
};

/**
 * Get supported LST asset symbols for a chain.
 */
export function getSupportedLSTAssets(chainId: ChainId): string[] {
  const chainConfig = PRESETS[chainId.toLiteral()];
  return chainConfig ? Object.keys(chainConfig) : [];
}

/**
 * Get LST configuration for the given chain and asset symbol.
 */
export function getLSTConfig(
  chainId: ChainId,
  assetSymbol: string
): LSTConfig | undefined {
  const lookup = LOOKUPS[chainId.toLiteral()];
  if (!lookup) return undefined;
  return lookup.get(assetSymbol.toLowerCase());
}
