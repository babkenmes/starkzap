import type { EthereumDepositFeeEstimation } from "@/bridge/ethereum";
import type { SolanaDepositFeeEstimation } from "@/bridge/solana/types";
import type { SolanaLayerSwapDepositFeeEstimation } from "@/bridge/solana/SolanaLayerSwapBridge";

export type BridgeDepositFeeEstimation =
  | EthereumDepositFeeEstimation
  | SolanaDepositFeeEstimation
  | SolanaLayerSwapDepositFeeEstimation;
