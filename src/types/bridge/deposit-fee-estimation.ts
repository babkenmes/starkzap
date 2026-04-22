import type { EthereumDepositFeeEstimation } from "@/bridge/ethereum";
import type {
  HyperlaneFeeEstimate,
  SolanaLayerSwapDepositFeeEstimation,
} from "@/bridge/solana/types";

export type BridgeDepositFeeEstimation =
  | EthereumDepositFeeEstimation
  | HyperlaneFeeEstimate
  | SolanaLayerSwapDepositFeeEstimation;
