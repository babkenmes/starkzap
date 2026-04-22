import type { Address, Amount, ExecuteOptions } from "@/types";
import type { PoolMember } from "@/types/pool";
import type { Tx } from "@/tx";
import type { WalletInterface } from "@/wallet/interface";

/**
 * Common staking surface shared by delegation-pool staking and LST staking.
 *
 * LST staking does not support claiming rewards separately; yield is reflected
 * in the share price. Delegation-pool staking adds `claimRewards()`.
 */
export interface StakingProvider {
  enter(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx>;
  stake(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx>;
  add(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx>;
  exitIntent(
    wallet: WalletInterface,
    amount: Amount,
    options?: ExecuteOptions
  ): Promise<Tx>;
  exit(wallet: WalletInterface, options?: ExecuteOptions): Promise<Tx>;
  isMember(wallet: WalletInterface): Promise<boolean>;
  getPosition(
    walletOrAddress: WalletInterface | Address
  ): Promise<PoolMember | null>;
  getCommission(): Promise<number>;
}

export interface ClaimableStaking extends StakingProvider {
  claimRewards(wallet: WalletInterface, options?: ExecuteOptions): Promise<Tx>;
}
