import { describe, expect, it, vi } from "vitest";
import { uint256, type RpcProvider } from "starknet";
import { fromAddress, Amount, ChainId } from "@/types";
import type { WalletInterface } from "@/wallet/interface";
import { EndurStaking } from "@/staking/lst";
import { getLSTConfig } from "@/staking/lst";

const mockTx = {
  hash: "0xmocktxhash",
  wait: vi.fn().mockResolvedValue(undefined),
};

const mockProvider = {} as RpcProvider;

function createMockWallet(chainId: ChainId = ChainId.MAINNET): WalletInterface {
  const mockErc20 = {
    populateApprove: vi.fn().mockReturnValue({
      contractAddress: "0xasset",
      entrypoint: "approve",
      calldata: [],
    }),
  };
  return {
    address: fromAddress(
      "0x0234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    ),
    execute: vi.fn().mockResolvedValue(mockTx),
    getChainId: () => chainId,
    erc20: vi.fn().mockReturnValue(mockErc20),
  } as unknown as WalletInterface;
}

describe("getLSTConfig", () => {
  it("should return STRK config for mainnet", () => {
    const config = getLSTConfig(ChainId.MAINNET, "STRK");
    expect(config).toBeDefined();
    expect(config!.symbol).toBe("STRK");
    expect(config!.lstSymbol).toBe("xSTRK");
  });

  it("should return WBTC config for mainnet", () => {
    const config = getLSTConfig(ChainId.MAINNET, "WBTC");
    expect(config).toBeDefined();
    expect(config!.symbol).toBe("WBTC");
  });

  it("should return undefined for unknown asset", () => {
    const config = getLSTConfig(ChainId.MAINNET, "UNKNOWN");
    expect(config).toBeUndefined();
  });

  it("should be case-insensitive", () => {
    expect(getLSTConfig(ChainId.MAINNET, "strk")).toBeDefined();
    expect(getLSTConfig(ChainId.MAINNET, "wbTC")).toBeDefined();
  });

  it("should return Sepolia configs", () => {
    const strk = getLSTConfig(ChainId.SEPOLIA, "STRK");
    expect(strk).toBeDefined();
    const tbtc1 = getLSTConfig(ChainId.SEPOLIA, "TBTC1");
    expect(tbtc1).toBeDefined();
  });
});

describe("EndurStaking", () => {
  describe("EndurStaking.from", () => {
    it("should throw for unsupported asset", () => {
      expect(() =>
        EndurStaking.from("UNKNOWN", mockProvider, ChainId.MAINNET)
      ).toThrow("Unsupported LST asset");
    });

    it("should create instance for supported asset", () => {
      const lst = EndurStaking.from("STRK", mockProvider, ChainId.MAINNET);
      expect(lst.asset).toBe("STRK");
      expect(lst.lstSymbol).toBe("xSTRK");
    });
  });

  describe("getAPY with mocked fetcher", () => {
    it("should return APY for the asset", async () => {
      const wallet = createMockWallet();
      const lstStatsJson = [
        {
          asset: "STRK",
          apy: 0.1,
          apyInPercentage: "10%",
          tvlUsd: 1000,
          tvlAsset: 500,
        },
        {
          asset: "WBTC",
          apy: 0.05,
          apyInPercentage: "5%",
          tvlUsd: 100,
          tvlAsset: 2,
        },
      ];
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(lstStatsJson),
      });

      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId(), {
        fetcher: fetcher as typeof fetch,
      });

      const result = await lst.getAPY();

      expect(result["STRK"]).toEqual({ apy: 0.1, apyInPercentage: "10%" });
      expect(Object.keys(result)).toEqual(["STRK"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(
        "https://app.endur.fi/api/lst/stats",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it("should return empty object when asset not in response", async () => {
      const wallet = createMockWallet();
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId(), {
        fetcher: fetcher as typeof fetch,
      });

      const result = await lst.getAPY();
      expect(result).toEqual({});
    });

    it("should throw when LST stats API returns non-ok", async () => {
      const wallet = createMockWallet();
      const fetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId(), {
        fetcher: fetcher as typeof fetch,
      });

      await expect(lst.getAPY()).rejects.toThrow(
        "Endur LST stats API failed: 500 Internal Server Error"
      );
    });
  });

  describe("getTVL with mocked fetcher", () => {
    it("should return TVL for the asset", async () => {
      const wallet = createMockWallet();
      const lstStatsJson = [
        {
          asset: "STRK",
          tvlUsd: 1000,
          tvlAsset: 500,
          apy: 0.1,
          apyInPercentage: "10%",
        },
        {
          asset: "WBTC",
          tvlUsd: 100,
          tvlAsset: 2,
          apy: 0.05,
          apyInPercentage: "5%",
        },
      ];
      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(lstStatsJson),
      });

      const lst = EndurStaking.from("WBTC", mockProvider, wallet.getChainId(), {
        fetcher: fetcher as typeof fetch,
      });

      const result = await lst.getTVL();

      expect(result["WBTC"]).toEqual({ tvlUsd: 100, tvlAsset: 2 });
      expect(Object.keys(result)).toEqual(["WBTC"]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should throw when LST stats API returns non-ok", async () => {
      const wallet = createMockWallet();
      const fetcher = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId(), {
        fetcher: fetcher as typeof fetch,
      });

      await expect(lst.getTVL()).rejects.toThrow(
        "Endur LST stats API failed: 404 Not Found"
      );
    });
  });

  describe("enter (deposit)", () => {
    it("should call execute with approve and deposit calls", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());
      const amount = Amount.parse("100", 18);

      const tx = await lst.enter(wallet, amount);

      expect(wallet.execute).toHaveBeenCalledTimes(1);
      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls).toHaveLength(2);
      expect(calls[0].entrypoint).toBe("approve");
      expect(calls[1].entrypoint).toBe("deposit");
      const amountFromCalldata = uint256.uint256ToBN({
        low: BigInt(calls[1].calldata[0]),
        high: BigInt(calls[1].calldata[1]),
      });
      expect(amountFromCalldata).toBe(amount.toBase());
      expect(tx.hash).toBe("0xmocktxhash");
    });

    it("should throw on decimal mismatch", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(
        lst.enter(wallet, Amount.parse("100", 8)) // STRK has 18 decimals
      ).rejects.toThrow("Amount decimals mismatch");
    });
  });

  describe("stake and add (aliases for enter)", () => {
    it("stake should behave identically to enter", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await lst.stake(wallet, Amount.parse("100", 18));

      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls[1].entrypoint).toBe("deposit");
    });

    it("add should behave identically to enter", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await lst.add(wallet, Amount.parse("100", 18));

      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls[1].entrypoint).toBe("deposit");
    });
  });

  describe("enterToValidator (deposit_to_validator)", () => {
    it("should call execute with approve and deposit_to_validator calls", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());
      const validatorAddress =
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const tx = await lst.enterToValidator(
        wallet,
        Amount.parse("100", 18),
        validatorAddress
      );

      expect(wallet.execute).toHaveBeenCalledTimes(1);
      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls).toHaveLength(2);
      expect(calls[0].entrypoint).toBe("approve");
      expect(calls[1].entrypoint).toBe("deposit_to_validator");
      expect(tx.hash).toBe("0xmocktxhash");
    });

    it("should throw for empty validatorAddress", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(
        lst.enterToValidator(wallet, Amount.parse("100", 18), "")
      ).rejects.toThrow("requires a non-empty validatorAddress");
    });
  });

  describe("enterWithReferral (deposit_with_referral)", () => {
    it("should call execute with approve and deposit_with_referral calls", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      const tx = await lst.enterWithReferral(
        wallet,
        Amount.parse("100", 18),
        "ABC123"
      );

      expect(wallet.execute).toHaveBeenCalledTimes(1);
      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls).toHaveLength(2);
      expect(calls[0].entrypoint).toBe("approve");
      expect(calls[1].entrypoint).toBe("deposit_with_referral");
      expect(tx.hash).toBe("0xmocktxhash");
    });

    it("should throw for empty referralCode", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(
        lst.enterWithReferral(wallet, Amount.parse("100", 18), "")
      ).rejects.toThrow("requires a non-empty referralCode");

      await expect(
        lst.enterWithReferral(wallet, Amount.parse("100", 18), "   ")
      ).rejects.toThrow("requires a non-empty referralCode");
    });

    it("should throw on decimal mismatch", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(
        lst.enterWithReferral(wallet, Amount.parse("100", 8), "ABC123")
      ).rejects.toThrow("Amount decimals mismatch");
    });
  });

  describe("exitIntent (redeem)", () => {
    it("should call execute with redeem call", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      const tx = await lst.exitIntent(wallet, Amount.parse("50", 18));

      expect(wallet.execute).toHaveBeenCalledTimes(1);
      const [calls] = (wallet.execute as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(calls).toHaveLength(1);
      expect(calls[0].entrypoint).toBe("redeem");
      expect(tx.hash).toBe("0xmocktxhash");
    });

    it("should throw on decimal mismatch", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(
        lst.exitIntent(wallet, Amount.parse("50", 8))
      ).rejects.toThrow("Amount decimals mismatch");
    });
  });

  describe("getCommission", () => {
    it("should return 0", async () => {
      const lst = EndurStaking.from("STRK", mockProvider, ChainId.MAINNET);
      expect(await lst.getCommission()).toBe(0);
    });
  });

  describe("claimRewards", () => {
    it("should throw not applicable error", async () => {
      const wallet = createMockWallet();
      const lst = EndurStaking.from("STRK", mockProvider, wallet.getChainId());

      await expect(lst.claimRewards(wallet)).rejects.toThrow(
        "claimRewards is not applicable"
      );
    });
  });
});
