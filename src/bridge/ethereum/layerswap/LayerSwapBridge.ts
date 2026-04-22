import { EthereumBridge } from "@/bridge/ethereum/EthereumBridge";
import type { BridgeDepositOptions } from "@/bridge/types/BridgeInterface";
import { LayerSwapApi } from "@/bridge/ethereum/layerswap/LayerSwapApi";
import type {
  LayerSwapApiConfig,
  LsDepositAction,
} from "@/bridge/ethereum/layerswap/types";
import type {
  EthereumDepositFeeEstimation,
  EthereumWalletConfig,
} from "@/bridge/ethereum/types";
import {
  type Address,
  Amount,
  type EthereumAddress,
  EthereumBridgeToken,
  type ExternalTransactionResponse,
} from "@/types";
import type { WalletInterface } from "@/wallet";

/** Fee estimation returned by LayerSwap, extending the base Ethereum fee shape. */
export type LayerSwapDepositFeeEstimation = EthereumDepositFeeEstimation & {
  /** LayerSwap service fee portion. */
  serviceFee: Amount;
  /** Amount the recipient will receive after fees. */
  receiveAmount: Amount;
  /** Estimated completion time (e.g. "00:02:00"). */
  avgCompletionTime: string;
};

const STARKNET_NETWORK_NAMES: Record<string, string> = {
  SN_MAIN: "STARKNET_MAINNET",
  SN_SEPOLIA: "STARKNET_SEPOLIA",
};

const ETHEREUM_NETWORK_NAMES: Record<string, string> = {
  SN_MAIN: "ETHEREUM_MAINNET",
  SN_SEPOLIA: "ETHEREUM_SEPOLIA",
};

/**
 * LayerSwap bridge provider for cross-chain deposits via the LayerSwap API.
 *
 * Handles Ethereum → Starknet transfers. The deposit flow:
 * 1. Creates a swap on LayerSwap API
 * 2. Retrieves deposit actions (EVM transactions to execute)
 * 3. Executes the deposit on Ethereum via the connected signer
 * 4. Notifies LayerSwap for faster detection
 *
 * Routed by {@link BridgeOperator} when `token.protocol === Protocol.LAYERSWAP`.
 */
export class LayerSwapBridge extends EthereumBridge {
  private readonly api: LayerSwapApi;

  constructor(
    bridgeToken: EthereumBridgeToken,
    config: EthereumWalletConfig,
    starknetWallet: WalletInterface,
    apiKey: string,
    apiConfig?: Omit<LayerSwapApiConfig, "apiKey">
  ) {
    super(bridgeToken, config, starknetWallet, []);
    this.api = new LayerSwapApi({ apiKey, ...apiConfig });
  }

  async deposit(
    recipient: Address,
    amount: Amount,
    _options?: BridgeDepositOptions
  ): Promise<ExternalTransactionResponse> {
    const sourceNetwork = this.getSourceNetworkName();
    const destNetwork = this.getDestNetworkName();
    const signerAddress = await this.config.signer.getAddress();

    // 1. Create swap on LayerSwap (response includes deposit actions)
    const response = await this.api.createSwap({
      sourceNetwork,
      sourceToken: this.bridgeToken.symbol,
      destinationNetwork: destNetwork,
      destinationToken: this.bridgeToken.symbol,
      amount: Number(amount.toUnit()),
      destinationAddress: recipient,
      sourceAddress: signerAddress,
    });

    const swap = response.swap;

    // 2. Get deposit actions (from response or fetch separately if needed)
    const actions =
      response.deposit_actions.length > 0
        ? response.deposit_actions
        : await this.api.getDepositActions(swap.id, signerAddress);
    const sourceActions = actions
      .filter((a) => a.network.name === sourceNetwork)
      .sort((a, b) => a.order - b.order);

    if (sourceActions.length === 0) {
      throw new Error(
        `No deposit actions found for swap "${swap.id}" on network "${sourceNetwork}".`
      );
    }

    // 3. Execute deposit actions on Ethereum
    let lastHash = "";
    for (const action of sourceActions) {
      const response = await this.executeEvmDepositAction(action);
      lastHash = response.hash;
    }

    // 4. Speed up detection
    try {
      await this.api.speedUpDeposit(swap.id, lastHash);
    } catch {
      // Non-critical — LayerSwap will detect the deposit on its own.
    }

    return { hash: lastHash };
  }

  async getDepositFeeEstimate(
    _options?: BridgeDepositOptions
  ): Promise<LayerSwapDepositFeeEstimation> {
    const sourceNetwork = this.getSourceNetworkName();
    const destNetwork = this.getDestNetworkName();

    const quote = await this.api.getQuote({
      sourceNetwork,
      sourceToken: this.bridgeToken.symbol,
      destinationNetwork: destNetwork,
      destinationToken: this.bridgeToken.symbol,
      amount: 1,
    });

    const decimals = this.bridgeToken.decimals;
    const symbol = this.bridgeToken.symbol;

    const zeroEth = Amount.fromRaw(0n, 18, "ETH");

    return {
      // EthereumDepositFeeEstimation base fields
      l1Fee: Amount.parse(String(quote.blockchain_fee), decimals, symbol),
      l2Fee: zeroEth,
      approvalFee: zeroEth,
      // LayerSwap-specific fields
      serviceFee: Amount.parse(String(quote.service_fee), decimals, symbol),
      receiveAmount: Amount.parse(
        String(quote.receive_amount),
        decimals,
        symbol
      ),
      avgCompletionTime: quote.avg_completion_time,
    };
  }

  async getAvailableDepositBalance(account: EthereumAddress): Promise<Amount> {
    const isNativeEth =
      this.bridgeToken.address === "0x0000000000000000000000000000000000000000";

    if (isNativeEth) {
      const balance = await this.config.provider.getBalance!(account);
      return Amount.fromRaw(
        balance,
        this.bridgeToken.decimals,
        this.bridgeToken.symbol
      );
    }

    return super.getAvailableDepositBalance(account);
  }

  // LayerSwap handles approvals within deposit actions.
  protected async getAllowanceSpender(): Promise<EthereumAddress | null> {
    return null;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private getSourceNetworkName(): string {
    const literal = this.starknetWallet.getChainId().toLiteral();
    const name = ETHEREUM_NETWORK_NAMES[literal];
    if (!name) {
      throw new Error(
        `No LayerSwap Ethereum network mapping for Starknet chain "${literal}".`
      );
    }
    return name;
  }

  private getDestNetworkName(): string {
    const literal = this.starknetWallet.getChainId().toLiteral();
    const name = STARKNET_NETWORK_NAMES[literal];
    if (!name) {
      throw new Error(
        `No LayerSwap Starknet network mapping for chain "${literal}".`
      );
    }
    return name;
  }

  private async executeEvmDepositAction(
    action: LsDepositAction
  ): Promise<ExternalTransactionResponse> {
    if (!action.to_address) {
      throw new Error(
        `Deposit action (order ${action.order}) has no to_address.`
      );
    }

    const tx: Record<string, unknown> = {
      to: action.to_address,
      value: BigInt(action.amount_in_base_units),
    };

    if (action.call_data) {
      tx["data"] = action.call_data;
      // For ERC20 token transfers, the amount is encoded in the calldata
      // and msg.value should be 0. For native ETH, the value is still
      // sent as msg.value alongside the calldata (swap reference ID).
      if (action.type !== "transfer") {
        tx["value"] = 0n;
      }
    }

    if (action.gas_limit) {
      tx["gasLimit"] = BigInt(action.gas_limit);
    }

    const response = await this.config.signer.sendTransaction(tx);
    const receipt = await response.wait();
    if (!receipt?.status) {
      throw new Error(
        `LayerSwap deposit action (order ${action.order}) failed on-chain.`
      );
    }

    return { hash: response.hash };
  }
}
