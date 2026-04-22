import type {
  BridgeDepositOptions,
  BridgeInterface,
} from "@/bridge/types/BridgeInterface";
import { LayerSwapApi } from "@/bridge/ethereum/layerswap/LayerSwapApi";
import type {
  LayerSwapApiConfig,
  LsDepositAction,
} from "@/bridge/ethereum/layerswap/types";
import type { SolanaWalletConfig } from "@/bridge/solana/types";
import {
  type Address,
  Amount,
  type ExternalTransactionResponse,
  type SolanaAddress,
  type SolanaBridgeToken,
} from "@/types";
import type { WalletInterface } from "@/wallet";
import { loadSolanaWeb3 } from "@/connect/solanaWeb3Runtime";

export type SolanaLayerSwapDepositFeeEstimation = {
  /** Total fee charged by LayerSwap. */
  totalFee: Amount;
  /** Blockchain fee portion. */
  blockchainFee: Amount;
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

const SOLANA_NETWORK_NAMES: Record<string, string> = {
  SN_MAIN: "SOLANA_MAINNET",
  SN_SEPOLIA: "SOLANA_DEVNET",
};

/**
 * LayerSwap bridge provider for Solana → Starknet deposits.
 *
 * The deposit flow:
 * 1. Creates a swap on LayerSwap API
 * 2. Retrieves deposit actions (Solana transactions to execute)
 * 3. Builds and signs SOL/SPL transfers via the connected wallet
 * 4. Notifies LayerSwap for faster detection
 *
 * Routed by {@link BridgeOperator} when `token.protocol === Protocol.LAYERSWAP`
 * and `token.chain === ExternalChain.SOLANA`.
 */
export class SolanaLayerSwapBridge implements BridgeInterface<SolanaAddress> {
  private readonly api: LayerSwapApi;

  constructor(
    private readonly bridgeToken: SolanaBridgeToken,
    private readonly config: SolanaWalletConfig,
    readonly starknetWallet: WalletInterface,
    apiKey: string,
    apiConfig?: Omit<LayerSwapApiConfig, "apiKey">
  ) {
    this.api = new LayerSwapApi({ apiKey, ...apiConfig });
  }

  async deposit(
    recipient: Address,
    amount: Amount,
    _options?: BridgeDepositOptions
  ): Promise<ExternalTransactionResponse> {
    const sourceNetwork = this.getSourceNetworkName();
    const destNetwork = this.getDestNetworkName();

    const response = await this.api.createSwap({
      sourceNetwork,
      sourceToken: this.bridgeToken.symbol,
      destinationNetwork: destNetwork,
      destinationToken: this.bridgeToken.symbol,
      amount: Number(amount.toUnit()),
      destinationAddress: recipient,
      sourceAddress: this.config.address,
    });

    const swap = response.swap;

    const actions =
      response.deposit_actions.length > 0
        ? response.deposit_actions
        : await this.api.getDepositActions(swap.id, this.config.address);
    const sourceActions = actions
      .filter((a) => a.network.name === sourceNetwork)
      .sort((a, b) => a.order - b.order);

    if (sourceActions.length === 0) {
      throw new Error(
        `No deposit actions found for swap "${swap.id}" on network "${sourceNetwork}".`
      );
    }

    let lastSignature = "";
    for (const action of sourceActions) {
      lastSignature = await this.executeSolanaDepositAction(action);
    }

    try {
      await this.api.speedUpDeposit(swap.id, lastSignature);
    } catch {
      // Non-critical — LayerSwap will detect the deposit on its own.
    }

    return { hash: lastSignature };
  }

  async getDepositFeeEstimate(
    _options?: BridgeDepositOptions
  ): Promise<SolanaLayerSwapDepositFeeEstimation> {
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

    return {
      totalFee: Amount.parse(String(quote.total_fee), decimals, symbol),
      blockchainFee: Amount.parse(
        String(quote.blockchain_fee),
        decimals,
        symbol
      ),
      serviceFee: Amount.parse(String(quote.service_fee), decimals, symbol),
      receiveAmount: Amount.parse(
        String(quote.receive_amount),
        decimals,
        symbol
      ),
      avgCompletionTime: quote.avg_completion_time,
    };
  }

  async getAvailableDepositBalance(account: SolanaAddress): Promise<Amount> {
    const solanaWeb3 = await loadSolanaWeb3("LayerSwap balance query");
    const connection = this.config.connection as InstanceType<
      typeof solanaWeb3.Connection
    >;
    const publicKey = new solanaWeb3.PublicKey(account);

    const isNativeSOL =
      this.bridgeToken.address === "11111111111111111111111111111111";

    if (isNativeSOL) {
      const balance = await connection.getBalance(publicKey);
      return Amount.fromRaw(
        BigInt(balance),
        this.bridgeToken.decimals,
        this.bridgeToken.symbol
      );
    }

    // SPL token balance
    const tokenMint = new solanaWeb3.PublicKey(this.bridgeToken.address);
    const accounts = await connection.getTokenAccountsByOwner(publicKey, {
      mint: tokenMint,
    });

    if (accounts.value.length === 0) {
      return Amount.fromRaw(
        0n,
        this.bridgeToken.decimals,
        this.bridgeToken.symbol
      );
    }

    // Decode token account data to get the balance (offset 64, 8 bytes LE)
    const data = accounts.value[0]!.account.data;
    const buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as Uint8Array);
    const balance = buffer.readBigUInt64LE(64);

    return Amount.fromRaw(
      balance,
      this.bridgeToken.decimals,
      this.bridgeToken.symbol
    );
  }

  async getAllowance(): Promise<Amount | null> {
    return null;
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private getSourceNetworkName(): string {
    const literal = this.starknetWallet.getChainId().toLiteral();
    const name = SOLANA_NETWORK_NAMES[literal];
    if (!name) {
      throw new Error(
        `No LayerSwap Solana network mapping for Starknet chain "${literal}".`
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

  private async executeSolanaDepositAction(
    action: LsDepositAction
  ): Promise<string> {
    if (!action.to_address) {
      throw new Error(
        `Deposit action (order ${action.order}) has no to_address.`
      );
    }

    const solanaWeb3 = await loadSolanaWeb3("LayerSwap deposit");
    const connection = this.config.connection as InstanceType<
      typeof solanaWeb3.Connection
    >;
    const fromPubkey = new solanaWeb3.PublicKey(this.config.address);

    const transaction = action.call_data
      ? solanaWeb3.Transaction.from(Buffer.from(action.call_data, "base64"))
      : this.buildNativeTransfer(
          solanaWeb3,
          fromPubkey,
          new solanaWeb3.PublicKey(action.to_address),
          BigInt(action.amount_in_base_units)
        );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPubkey;

    return await this.config.provider.signAndSendTransaction(transaction);
  }

  private buildNativeTransfer(
    solanaWeb3: Awaited<ReturnType<typeof loadSolanaWeb3>>,
    fromPubkey: InstanceType<
      Awaited<ReturnType<typeof loadSolanaWeb3>>["PublicKey"]
    >,
    toPubkey: InstanceType<
      Awaited<ReturnType<typeof loadSolanaWeb3>>["PublicKey"]
    >,
    lamports: bigint
  ): InstanceType<Awaited<ReturnType<typeof loadSolanaWeb3>>["Transaction"]> {
    const tx = new solanaWeb3.Transaction();
    tx.add(
      solanaWeb3.SystemProgram.transfer({ fromPubkey, toPubkey, lamports })
    );
    return tx;
  }
}
