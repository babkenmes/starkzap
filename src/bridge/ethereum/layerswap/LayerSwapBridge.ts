import { EthereumBridge } from "@/bridge/ethereum/EthereumBridge";
import type { BridgeDepositOptions } from "@/bridge/types/BridgeInterface";
import { LayerSwapApi } from "@/bridge/ethereum/layerswap/LayerSwapApi";
import type {
  LayerSwapApiConfig,
  LsDepositAction,
} from "@/bridge/ethereum/layerswap/types";
import type {
  EthereumWalletConfig,
  LayerSwapDepositFeeEstimation,
} from "@/bridge/ethereum/types";
import {
  type Address,
  Amount,
  type EthereumAddress,
  EthereumBridgeToken,
  type ExternalTransactionResponse,
} from "@/types";
import type { WalletInterface } from "@/wallet";
import type { StarkZapLogger } from "@/logger";

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
  private readonly sourceNetwork: string;
  private readonly destNetwork: string;

  constructor(
    bridgeToken: EthereumBridgeToken,
    config: EthereumWalletConfig,
    starknetWallet: WalletInterface,
    apiKey: string,
    logger: StarkZapLogger,
    apiConfig?: Omit<LayerSwapApiConfig, "apiKey">
  ) {
    super(bridgeToken, config, starknetWallet, logger);
    this.api = new LayerSwapApi({ apiKey, ...apiConfig });
    const mainnet = starknetWallet.getChainId().isMainnet();
    this.sourceNetwork = mainnet ? "ETHEREUM_MAINNET" : "ETHEREUM_SEPOLIA";
    this.destNetwork = mainnet ? "STARKNET_MAINNET" : "STARKNET_SEPOLIA";
  }

  async deposit(
    recipient: Address,
    amount: Amount,
    _options?: BridgeDepositOptions
  ): Promise<ExternalTransactionResponse> {
    const signerAddress = await this.config.signer.getAddress();

    const response = await this.api.createSwap({
      sourceNetwork: this.sourceNetwork,
      sourceToken: this.bridgeToken.symbol,
      destinationNetwork: this.destNetwork,
      destinationToken: this.bridgeToken.symbol,
      amount: amount.toUnit(),
      destinationAddress: recipient,
      sourceAddress: signerAddress,
      refundAddress: signerAddress,
    });

    const swap = response.swap;

    const actions =
      response.deposit_actions.length > 0
        ? response.deposit_actions
        : await this.api.getDepositActions(swap.id, signerAddress);
    const action = actions.find(
      (a) => a.network.name === this.sourceNetwork && a.type === "transfer"
    );

    if (!action) {
      throw new Error(
        `No transfer deposit action for swap "${swap.id}" on network "${this.sourceNetwork}".`
      );
    }

    const { hash } = await this.executeEvmDepositAction(action);

    try {
      await this.api.speedUpDeposit(swap.id, hash);
    } catch {
      // Non-critical — LayerSwap will detect the deposit on its own.
    }

    return { hash };
  }

  async getDepositFeeEstimate(
    _options?: BridgeDepositOptions
  ): Promise<LayerSwapDepositFeeEstimation> {
    const quote = await this.api.getQuote({
      sourceNetwork: this.sourceNetwork,
      sourceToken: this.bridgeToken.symbol,
      destinationNetwork: this.destNetwork,
      destinationToken: this.bridgeToken.symbol,
      amount: "0",
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
