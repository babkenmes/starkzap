// ============================================================
// LayerSwap API response models (Ls-prefixed)
// ============================================================

/** Network type as reported by the LayerSwap API. */
export type LsNetworkType =
  | "evm"
  | "starknet"
  | "solana"
  | "cosmos"
  | "ton"
  | "bitcoin"
  | (string & {});

/** Token descriptor from the LayerSwap API. */
export interface LsToken {
  readonly symbol: string;
  readonly display_asset?: string;
  readonly logo: string;
  readonly contract: string | null;
  readonly decimals: number;
  readonly price_in_usd: number;
  readonly precision: number;
  readonly listing_date: string;
  readonly group?: string;
}

/** Network descriptor from the LayerSwap API. */
export interface LsNetwork {
  readonly name: string;
  readonly display_name: string;
  readonly logo: string;
  readonly chain_id: string | null;
  readonly type: LsNetworkType;
  readonly transaction_explorer_template: string;
  readonly account_explorer_template: string;
  readonly deposit_methods?: readonly string[];
  readonly tokens?: readonly LsToken[];
  readonly token?: LsToken;
  readonly metadata?: {
    readonly listing_date: string;
    readonly evm_oracle_contract?: string;
    readonly evm_multicall_contract?: string;
  };
}

/** Route entry: a network with its available tokens (returned by /sources, /destinations). */
export type LsRoute = LsNetwork & {
  readonly tokens: readonly LsToken[];
};

/** Min/max transfer limits for a route. */
export interface LsLimits {
  readonly min_amount: number;
  readonly max_amount: number;
  readonly min_amount_in_usd?: number;
  readonly max_amount_in_usd?: number;
}

/** Swap quote with fee breakdown. */
export interface LsQuote {
  readonly source_network: LsNetwork;
  readonly source_token: LsToken;
  readonly destination_network: LsNetwork;
  readonly destination_token: LsToken;
  readonly requested_amount: number;
  readonly receive_amount: number;
  readonly min_receive_amount: number;
  readonly total_fee: number;
  readonly total_fee_in_usd: number;
  readonly blockchain_fee: number;
  readonly service_fee: number;
  readonly avg_completion_time: string;
  readonly slippage?: number;
  readonly refuel_in_source?: number;
  readonly rate?: number;
  readonly fee_discount?: number;
}

/** Wrapper returned by /api/v2/quote. */
export interface LsQuoteResponse {
  readonly quote: LsQuote;
  readonly refuel: unknown;
  readonly reward: unknown;
}

/** Swap lifecycle status values. */
export type LsSwapStatus =
  | "created"
  | "user_transfer_pending"
  | "user_transfer_delayed"
  | "ls_transfer_pending"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "pending_refund"
  | "refunded";

/** On-chain transaction associated with a swap. */
export interface LsTransaction {
  readonly type: "input" | "output" | "refuel" | "refund";
  readonly from: string;
  readonly to: string;
  readonly created_date: string;
  readonly amount: number;
  readonly transaction_hash: string;
  readonly confirmations: number;
  readonly max_confirmations: number;
  readonly usd_value: number;
  readonly usd_price: number;
  readonly status: "completed" | "failed" | "initiated" | "pending";
}

/** Deposit action the user must execute to complete a swap. */
export interface LsDepositAction {
  readonly type: "transfer" | "manual_transfer";
  readonly to_address?: string;
  readonly amount: number;
  readonly amount_in_base_units: string;
  readonly order: number;
  readonly network: LsNetwork;
  readonly token: LsToken;
  readonly fee_token?: LsToken;
  readonly call_data: string | null;
  readonly gas_limit?: string;
}

/** Swap object as returned by the API. */
export interface LsSwap {
  readonly id: string;
  readonly created_date: string;
  readonly status: LsSwapStatus;
  readonly source_network: LsNetwork;
  readonly source_token: LsToken;
  readonly destination_network: LsNetwork;
  readonly destination_token: LsToken;
  readonly destination_address: string;
  readonly requested_amount: number;
  readonly fail_reason: string | null;
  readonly use_deposit_address: boolean;
  readonly metadata: {
    readonly reference_id?: string | null;
    readonly app?: string | null;
    readonly sequence_number: number;
  };
  readonly transactions: readonly LsTransaction[];
}

/** Wrapper returned by POST /api/v2/swaps. */
export interface LsSwapResponse {
  readonly swap: LsSwap;
  readonly deposit_actions: readonly LsDepositAction[];
  readonly quote: LsQuote;
  readonly refuel: unknown;
  readonly reward: unknown;
}

/** Wrapper for all LayerSwap API responses. */
export interface LsApiResponse<T> {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly metadata?: Record<string, unknown>;
  } | null;
  readonly data: T | null;
}

// ============================================================
// SDK-facing request types
// ============================================================

/** Parameters for querying a swap quote or route limits. */
export interface LayerSwapQuoteRequest {
  readonly sourceNetwork: string;
  readonly sourceToken: string;
  readonly destinationNetwork: string;
  readonly destinationToken: string;
  readonly amount: number;
  readonly refuel?: boolean;
}

/** Parameters for creating a new swap. */
export interface LayerSwapCreateRequest {
  readonly sourceNetwork: string;
  readonly sourceToken: string;
  readonly destinationNetwork: string;
  readonly destinationToken: string;
  readonly amount: number;
  readonly destinationAddress: string;
  readonly sourceAddress?: string;
  readonly refuel?: boolean;
  readonly slippage?: string;
  readonly referenceId?: string;
}

// ============================================================
// Error
// ============================================================

/** Error thrown when the LayerSwap API returns an error response. */
export class LayerSwapApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "LayerSwapApiError";
  }
}
