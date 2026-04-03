import type {
  LsApiResponse,
  LsDepositAction,
  LsLimits,
  LsNetwork,
  LsQuote,
  LsQuoteResponse,
  LsRoute,
  LsSwap,
  LsSwapResponse,
  LayerSwapCreateRequest,
  LayerSwapQuoteRequest,
} from "@/bridge/layerswap/types";
import { LayerSwapApiError } from "@/bridge/layerswap/types";

const DEFAULT_BASE_URL = "https://api.layerswap.io";

export interface LayerSwapApiConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Low-level HTTP client for the LayerSwap REST API v2.
 *
 * Maps 1:1 to the API surface. Does not carry SDK-specific state
 * (wallet, chain ID, etc.) — see {@link LayerSwapBridge} for the
 * higher-level bridge integration.
 */
export class LayerSwapApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: LayerSwapApiConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // ============================================================
  // Route discovery
  // ============================================================

  /**
   * Get available source networks and tokens.
   *
   * @param destination - Optional destination network filter.
   * @param destinationToken - Optional destination token filter.
   */
  async getSources(
    destination?: string,
    destinationToken?: string
  ): Promise<LsRoute[]> {
    const params = new URLSearchParams();
    if (destination) params.set("destination_network", destination);
    if (destinationToken) params.set("destination_token", destinationToken);
    return this.get<LsRoute[]>("/api/v2/sources", params);
  }

  /**
   * Get available destination networks and tokens.
   *
   * @param source - Optional source network filter.
   * @param sourceToken - Optional source token filter.
   */
  async getDestinations(
    source?: string,
    sourceToken?: string
  ): Promise<LsRoute[]> {
    const params = new URLSearchParams();
    if (source) params.set("source_network", source);
    if (sourceToken) params.set("source_token", sourceToken);
    return this.get<LsRoute[]>("/api/v2/destinations", params);
  }

  /** Get all available networks with their tokens. */
  async getNetworks(): Promise<LsNetwork[]> {
    return this.get<LsNetwork[]>("/api/v2/networks");
  }

  // ============================================================
  // Quote & limits
  // ============================================================

  /** Get min/max transfer limits for a route. */
  async getLimits(request: LayerSwapQuoteRequest): Promise<LsLimits> {
    return this.get<LsLimits>("/api/v2/limits", this.quoteParams(request));
  }

  /** Get a swap quote with fee breakdown. */
  async getQuote(request: LayerSwapQuoteRequest): Promise<LsQuote> {
    const response = await this.get<LsQuoteResponse>(
      "/api/v2/quote",
      this.quoteParams(request)
    );
    return response.quote;
  }

  // ============================================================
  // Swap lifecycle
  // ============================================================

  /** Create a new swap. Returns the full response including swap, deposit actions, and quote. */
  async createSwap(request: LayerSwapCreateRequest): Promise<LsSwapResponse> {
    return this.post<LsSwapResponse>("/api/v2/swaps", {
      source_network: request.sourceNetwork,
      source_token: request.sourceToken,
      destination_network: request.destinationNetwork,
      destination_token: request.destinationToken,
      amount: request.amount,
      destination_address: request.destinationAddress,
      ...(request.sourceAddress && { source_address: request.sourceAddress }),
      refuel: request.refuel ?? false,
      use_deposit_address: false,
      use_depository: false,
      ...(request.slippage && { slippage: request.slippage }),
      ...(request.referenceId && { reference_id: request.referenceId }),
    });
  }

  /** Get a swap by ID. */
  async getSwap(swapId: string): Promise<LsSwap> {
    const response = await this.get<LsSwapResponse>(
      `/api/v2/swaps/${encodeURIComponent(swapId)}`
    );
    return response.swap;
  }

  /** Get deposit actions for a swap. */
  async getDepositActions(
    swapId: string,
    sourceAddress?: string
  ): Promise<LsDepositAction[]> {
    const params = new URLSearchParams();
    if (sourceAddress) params.set("source_address", sourceAddress);
    return this.get<LsDepositAction[]>(
      `/api/v2/swaps/${encodeURIComponent(swapId)}/deposit_actions`,
      params
    );
  }

  /** Speed up deposit detection by providing the transaction hash. */
  async speedUpDeposit(swapId: string, transactionHash: string): Promise<void> {
    await this.post<unknown>(
      `/api/v2/swaps/${encodeURIComponent(swapId)}/deposit_speedup`,
      { transaction_id: transactionHash }
    );
  }

  // ============================================================
  // Internals
  // ============================================================

  private quoteParams(request: LayerSwapQuoteRequest): URLSearchParams {
    const params = new URLSearchParams();
    params.set("source_network", request.sourceNetwork);
    params.set("source_token", request.sourceToken);
    params.set("destination_network", request.destinationNetwork);
    params.set("destination_token", request.destinationToken);
    params.set("amount", String(request.amount));
    if (request.refuel) params.set("refuel", "true");
    return params;
  }

  private async get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const qs = params?.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });
    return this.unwrap<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.unwrap<T>(response);
  }

  private headers(): Record<string, string> {
    return { "X-LS-APIKEY": this.apiKey };
  }

  private async unwrap<T>(response: Response): Promise<T> {
    const json = (await response.json()) as LsApiResponse<T>;

    if (!response.ok || json.error) {
      throw new LayerSwapApiError(
        response.status,
        json.error?.code,
        json.error?.message ?? `LayerSwap API error (HTTP ${response.status})`
      );
    }

    if (json.data === null || json.data === undefined) {
      throw new LayerSwapApiError(
        response.status,
        undefined,
        "LayerSwap API returned empty data"
      );
    }

    return json.data;
  }
}
