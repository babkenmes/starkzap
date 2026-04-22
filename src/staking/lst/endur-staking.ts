import {
  byteArray,
  CallData,
  Contract,
  type Call,
  type RpcProvider,
  uint256,
} from "starknet";
import { fromAddress, type Address } from "@/types/address";
import { Amount, type ExecuteOptions, resolveWalletAddress } from "@/types";
import { ABI as ERC20_ABI } from "@/abi/erc20";
import type { PoolMember } from "@/types/pool";
import type { WalletInterface } from "@/wallet/interface";
import type { Tx } from "@/tx";
import type { ChainId } from "@/types/config";
import type { StakingProvider } from "@/staking/interface";
import {
  getLSTConfig,
  getSupportedLSTAssets,
  type LSTConfig,
} from "@/staking/lst/presets";

const ENDUR_API_BASES: Record<string, string> = {
  SN_MAIN: "https://app.endur.fi",
  SN_SEPOLIA: "https://testnet.endur.fi",
};

function getEndurApiBase(chainId: ChainId): string {
  return ENDUR_API_BASES[chainId.toLiteral()] ?? "https://app.endur.fi";
}

interface LSTStatsItem {
  asset: string;
  tvlUsd: number;
  tvlAsset: number;
  apy: number;
  apyInPercentage: string;
}

export interface EndurStakingOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type EndurAPYResult = Partial<
  Record<string, { apy: number; apyInPercentage: string }>
>;

export type EndurTVLResult = Partial<
  Record<string, { tvlUsd: number; tvlAsset: number }>
>;

/**
 * LST staking module for Endur liquid staking on Starknet.
 *
 * Mirrors the `Staking` API so SDK users interact with one consistent
 * staking interface regardless of the underlying mechanism:
 * - `enter` / `stake` / `add` → ERC4626 `deposit`
 * - `exitIntent`              → ERC4626 `redeem`
 * - `exit`                    → ERC4626 `redeem` of full share balance
 * - `getPosition`             → LST share balance as a `PoolMember`
 * - `getCommission`           → `0` (yield is baked into the share price)
 *
 * Obtain an instance via `wallet.lstStaking("STRK")`.
 *
 * @example
 * ```ts
 * const lst = wallet.lstStaking("STRK");
 *
 * // Deposit
 * const tx = await lst.enter(wallet, Amount.parse("100", 18));
 * await tx.wait();
 *
 * // Check position
 * const position = await lst.getPosition(wallet);
 * console.log(`Shares: ${position?.staked.toFormatted()}`);
 *
 * // Redeem
 * const exitTx = await lst.exitIntent(wallet, position.staked);
 * await exitTx.wait();
 * ```
 */
export class EndurStaking implements StakingProvider {
  private readonly config: LSTConfig;
  private readonly provider: RpcProvider;
  private readonly chainId: ChainId;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  private constructor(
    config: LSTConfig,
    provider: RpcProvider,
    chainId: ChainId,
    options?: EndurStakingOptions
  ) {
    this.config = config;
    this.provider = provider;
    this.chainId = chainId;
    this.fetcher =
      options?.fetcher ??
      ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
    this.timeoutMs = options?.timeoutMs ?? 15000;
  }

  /** The underlying asset symbol (e.g. "STRK", "WBTC") */
  get asset(): string {
    return this.config.symbol;
  }

  /** The LST share token symbol (e.g. "xSTRK", "xWBTC") */
  get lstSymbol(): string {
    return this.config.lstSymbol;
  }

  // ============================================================
  // Write operations — mirrors Staking API
  // ============================================================

  /**
   * Enter the LST vault as a new depositor (ERC4626 deposit).
   *
   * For LST vaults there is no membership gate — `enter`, `stake`, and `add`
   * all perform the same underlying deposit.
   */
  async enter(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx> {
    this.assertDecimalsMatch(amount);
    return wallet.execute(this.buildDepositCalls(wallet, amount), options);
  }

  /**
   * Stake assets in the LST vault (ERC4626 deposit).
   *
   * Equivalent to `enter` — provided for API parity with `Staking`.
   */
  async stake(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx> {
    return this.enter(wallet, amount, options);
  }

  /**
   * Add more assets to the LST vault (ERC4626 deposit).
   *
   * Equivalent to `enter` — provided for API parity with `Staking`.
   */
  async add(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx> {
    return this.enter(wallet, amount, options);
  }

  /**
   * Deposit with a specific validator address.
   */
  async enterToValidator(
    wallet: WalletInterface,
    amount: Amount,
    validatorAddress: string,
    options?: ExecuteOptions
  ): Promise<Tx> {
    const addr = validatorAddress?.trim();
    if (!addr) {
      throw new Error("enterToValidator requires a non-empty validatorAddress");
    }
    this.assertDecimalsMatch(amount);

    const approveCall = this.buildApproveCall(wallet, amount);
    const depositCall: Call = {
      contractAddress: this.config.lstAddress,
      entrypoint: "deposit_to_validator",
      calldata: CallData.compile([
        uint256.bnToUint256(amount.toBase()),
        wallet.address,
        fromAddress(addr),
      ]),
    };
    return wallet.execute([approveCall, depositCall], options);
  }

  /**
   * Deposit with a referral code.
   */
  async enterWithReferral(
    wallet: WalletInterface,
    amount: Amount,
    referralCode: string,
    options?: ExecuteOptions
  ): Promise<Tx> {
    const code = referralCode?.trim();
    if (!code) {
      throw new Error("enterWithReferral requires a non-empty referralCode");
    }
    this.assertDecimalsMatch(amount);

    const approveCall = this.buildApproveCall(wallet, amount);
    const depositCall: Call = {
      contractAddress: this.config.lstAddress,
      entrypoint: "deposit_with_referral",
      calldata: CallData.compile([
        uint256.bnToUint256(amount.toBase()),
        wallet.address,
        byteArray.byteArrayFromString(code),
      ]),
    };
    return wallet.execute([approveCall, depositCall], options);
  }

  /**
   * Initiate an exit by redeeming a specific amount of LST shares (ERC4626 redeem).
   *
   * Unlike delegation pool staking, LST redemption is immediate — there is no
   * exit window. This method mirrors `exitIntent` from `Staking` for API parity.
   *
   * @param amount - Amount of LST shares to redeem
   */
  async exitIntent(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx> {
    this.assertDecimalsMatch(amount);
    return wallet.execute([this.buildRedeemCall(wallet, amount)], options);
  }

  /**
   * Redeem the wallet's full LST share balance (ERC4626 redeem).
   *
   * Queries the current position and redeems everything. Mirrors `exit` from
   * `Staking` for API parity.
   *
   * @throws Error if the wallet holds no LST shares
   */
  async exit(wallet: WalletInterface, options?: ExecuteOptions): Promise<Tx> {
    const position = await this.getPosition(wallet);
    if (!position || position.staked.isZero()) {
      throw new Error(
        `No ${this.config.lstSymbol} shares to redeem for wallet ${wallet.address}.`
      );
    }
    return wallet.execute(
      [this.buildRedeemCall(wallet, position.staked)],
      options
    );
  }

  /**
   * Not applicable for LST vaults — yield is reflected in the share price.
   *
   * @throws Always throws; use `exit` or `exitIntent` to realise gains.
   */
  async claimRewards(
    _wallet: WalletInterface,
    _options?: ExecuteOptions
  ): Promise<Tx> {
    throw new Error(
      `claimRewards is not applicable for ${this.config.lstSymbol}. ` +
        `LST yield is baked into the share price — use exitIntent() or exit() to realise gains.`
    );
  }

  // ============================================================
  // Read operations — mirrors Staking API
  // ============================================================

  /**
   * Check whether the wallet holds any LST shares.
   */
  async isMember(wallet: WalletInterface): Promise<boolean> {
    const position = await this.getPosition(wallet);
    return position !== null && !position.staked.isZero();
  }

  /**
   * Get the wallet's LST position as a `PoolMember`.
   *
   * - `staked`  — LST share balance
   * - `rewards` — always zero (yield is in the share price)
   * - `total`   — same as `staked`
   *
   * Returns `null` if the wallet holds no shares.
   */
  async getPosition(
    walletOrAddress: WalletInterface | Address
  ): Promise<PoolMember | null> {
    const address = resolveWalletAddress(walletOrAddress);

    const lstContract = new Contract({
      abi: ERC20_ABI,
      address: this.config.lstAddress,
      providerOrAccount: this.provider,
    }).typedv2(ERC20_ABI);

    const rawBalance = await lstContract.balance_of(address);
    const balanceBN =
      typeof rawBalance === "bigint"
        ? rawBalance
        : uint256.uint256ToBN(rawBalance as { low: bigint; high: bigint });

    const lstToken = {
      name: this.config.lstSymbol,
      address: this.config.lstAddress,
      decimals: this.config.decimals,
      symbol: this.config.lstSymbol,
    };

    const shares = Amount.fromRaw(balanceBN, lstToken);

    if (shares.isZero()) return null;

    const zero = Amount.fromRaw(0n, lstToken);

    return {
      staked: shares,
      rewards: zero,
      total: shares,
      unpooling: zero,
      unpoolTime: null,
      commissionPercent: 0,
      rewardAddress: address,
    };
  }

  /**
   * Returns `0` — LST vaults have no validator commission.
   *
   * Provided for API parity with `Staking`.
   */
  async getCommission(): Promise<number> {
    return 0;
  }

  // ============================================================
  // LST-specific read operations
  // ============================================================

  /**
   * Get current APY data for this asset from the Endur API.
   */
  async getAPY(): Promise<EndurAPYResult> {
    const items = await this.fetchStats();
    const item = items.find(
      (i) => i.asset.toLowerCase() === this.config.symbol.toLowerCase()
    );
    if (!item) return {};
    return {
      [item.asset]: { apy: item.apy, apyInPercentage: item.apyInPercentage },
    };
  }

  /**
   * Get current TVL data for this asset from the Endur API.
   */
  async getTVL(): Promise<EndurTVLResult> {
    const items = await this.fetchStats();
    const item = items.find(
      (i) => i.asset.toLowerCase() === this.config.symbol.toLowerCase()
    );
    if (!item) return {};
    return { [item.asset]: { tvlUsd: item.tvlUsd, tvlAsset: item.tvlAsset } };
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private buildApproveCall(wallet: WalletInterface, amount: Amount): Call {
    const assetToken = {
      name: this.config.symbol,
      address: this.config.assetAddress,
      decimals: this.config.decimals,
      symbol: this.config.symbol,
    };
    return wallet
      .erc20(assetToken)
      .populateApprove(this.config.lstAddress, amount);
  }

  private buildDepositCalls(wallet: WalletInterface, amount: Amount): Call[] {
    const depositCall: Call = {
      contractAddress: this.config.lstAddress,
      entrypoint: "deposit",
      calldata: CallData.compile([
        uint256.bnToUint256(amount.toBase()),
        wallet.address,
      ]),
    };
    return [this.buildApproveCall(wallet, amount), depositCall];
  }

  private buildRedeemCall(wallet: WalletInterface, amount: Amount): Call {
    return {
      contractAddress: this.config.lstAddress,
      entrypoint: "redeem",
      calldata: CallData.compile([
        uint256.bnToUint256(amount.toBase()),
        wallet.address,
        wallet.address,
      ]),
    };
  }

  private assertDecimalsMatch(amount: Amount): void {
    if (amount.getDecimals() !== this.config.decimals) {
      throw new Error(
        `Amount decimals mismatch: expected ${this.config.decimals} for ${this.config.symbol}, got ${amount.getDecimals()}`
      );
    }
  }

  private async fetchStats(): Promise<LSTStatsItem[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const apiBase = getEndurApiBase(this.chainId);

    const res = await this.fetcher(`${apiBase}/api/lst/stats`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      throw new Error(
        `Endur LST stats API failed: ${res.status} ${res.statusText}`
      );
    }

    const raw = await res.json();
    return this.parseStats(raw);
  }

  private parseStats(raw: unknown): LSTStatsItem[] {
    if (!Array.isArray(raw)) {
      throw new Error(
        `Endur LST stats API returned unexpected shape: expected array, got ${typeof raw}`
      );
    }

    const supported = new Set(
      getSupportedLSTAssets(this.chainId).map((s) => s.toLowerCase())
    );
    const valid: LSTStatsItem[] = [];

    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (item === null || typeof item !== "object") continue;

      const obj = item as Record<string, unknown>;
      const { asset, apy, apyInPercentage, tvlUsd, tvlAsset } = obj;

      if (
        typeof asset !== "string" ||
        typeof apy !== "number" ||
        typeof apyInPercentage !== "string" ||
        typeof tvlUsd !== "number" ||
        typeof tvlAsset !== "number"
      ) {
        continue;
      }

      if (!supported.has(asset.toLowerCase())) continue;
      valid.push({ asset, apy, apyInPercentage, tvlUsd, tvlAsset });
    }

    return valid;
  }

  // ============================================================
  // Factory
  // ============================================================

  /**
   * Create an `EndurStaking` instance for the given asset and chain.
   *
   * @throws Error if the asset is not supported on the chain
   */
  static from(
    asset: string,
    provider: RpcProvider,
    chainId: ChainId,
    options?: EndurStakingOptions
  ): EndurStaking {
    const config = getLSTConfig(chainId, asset);
    if (!config) {
      const supported = getSupportedLSTAssets(chainId).join(", ");
      throw new Error(
        `Unsupported LST asset "${asset}" on ${chainId.toLiteral()}. Supported: ${supported || "none"}.`
      );
    }
    return new EndurStaking(config, provider, chainId, options);
  }
}
