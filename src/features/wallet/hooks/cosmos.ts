import { DeliverTxResponse, ExecuteResult, IndexedTx } from '@cosmjs/cosmwasm-stargate';
import { useChain, useChains } from '@cosmos-kit/react';
import { ProviderType, TypedTransactionReceipt, WarpTypedTransaction } from '@hyperlane-xyz/sdk';
import { HexString, ProtocolType, assert } from '@hyperlane-xyz/utils';
import { useCallback, useMemo } from 'react';
import { toast } from 'react-toastify';
import { PLACEHOLDER_COSMOS_CHAIN } from '../../../consts/values';
import { logger } from '../../../utils/logger';
import { getCosmosChainNames } from '../../chains/metadata';

import { useMultiProvider } from '../../chains/hooks';
import { useWarpCore } from '../../tokens/hooks';
import {
  AccountInfo,
  ActiveChainInfo,
  ChainAddress,
  ChainTransactionFns,
  WalletDetails,
} from './types';

export function useCosmosAccount(): AccountInfo {
  const cosmosChains = getCosmosChainNames(useWarpCore());
  const chainToContext = useChains(cosmosChains);
  return useMemo<AccountInfo>(() => {
    const addresses: Array<ChainAddress> = [];
    let publicKey: Promise<HexString> | undefined = undefined;
    let connectorName: string | undefined = undefined;
    let isReady = false;
    for (const [chainName, context] of Object.entries(chainToContext)) {
      if (!context.address) continue;
      addresses.push({ address: context.address, chainName });
      publicKey = context.getAccount().then((acc) => Buffer.from(acc.pubkey).toString('hex'));
      isReady = true;
      connectorName ||= context.wallet?.prettyName;
    }
    return {
      protocol: ProtocolType.Cosmos,
      addresses,
      publicKey,
      isReady,
    };
  }, [chainToContext]);
}

export function useCosmosWalletDetails() {
  const { wallet } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const { logo, prettyName } = wallet || {};

  return useMemo<WalletDetails>(
    () => ({
      name: prettyName,
      logoUrl: typeof logo === 'string' ? logo : undefined,
    }),
    [prettyName, logo],
  );
}

export function useCosmosConnectFn(): () => void {
  const { openView } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  return openView;
}

export function useCosmosDisconnectFn(): () => Promise<void> {
  const { disconnect, address } = useChain(PLACEHOLDER_COSMOS_CHAIN);
  const safeDisconnect = async () => {
    if (address) await disconnect();
  };
  return safeDisconnect;
}

export function useCosmosActiveChain(): ActiveChainInfo {
  return useMemo(() => ({}) as ActiveChainInfo, []);
}

export function useCosmosTransactionFns(): ChainTransactionFns {
  const multiProvider = useMultiProvider();

  const cosmosChains = getCosmosChainNames(useWarpCore());
  const chainToContext = useChains(cosmosChains);

  const onSwitchNetwork = useCallback(
    async (chainName: ChainName) => {
      const displayName = multiProvider.getChainMetadata(chainName).displayName || chainName;
      toast.warn(`Cosmos wallet must be connected to origin chain ${displayName}}`);
    },
    [multiProvider],
  );

  const onSendTx = useCallback(
    async ({
      tx,
      chainName,
      activeChainName,
    }: {
      tx: WarpTypedTransaction;
      chainName: ChainName;
      activeChainName?: ChainName;
    }) => {
      const chainContext = chainToContext[chainName];
      if (!chainContext?.address) throw new Error(`Cosmos wallet not connected for ${chainName}`);

      if (activeChainName && activeChainName !== chainName) await onSwitchNetwork(chainName);

      logger.debug(`Sending tx on chain ${chainName}`);
      const { getSigningCosmWasmClient, getSigningStargateClient } = chainContext;
      let result: ExecuteResult | DeliverTxResponse;
      let txDetails: IndexedTx | null;
      if (tx.type === ProviderType.CosmJsWasm) {
        const client = await getSigningCosmWasmClient();
        result = await client.executeMultiple(chainContext.address, [tx.transaction], 'auto');
        txDetails = await client.getTx(result.transactionHash);
      } else if (tx.type === ProviderType.CosmJs) {
        const client = await getSigningStargateClient();
        // The fee param of 'auto' here stopped working for Neutron-based IBC transfers
        // It seems the signAndBroadcast method uses a default fee multiplier of 1.4
        // https://github.com/cosmos/cosmjs/blob/e819a1fc0e99a3e5320d8d6667a08d3b92e5e836/packages/stargate/src/signingstargateclient.ts#L115
        // A multiplier of 1.6 was insufficient for Celestia -> Neutron|Cosmos -> XXX transfers, but 2 worked.
        result = await client.signAndBroadcast(chainContext.address, [tx.transaction], 2);
        txDetails = await client.getTx(result.transactionHash);
      } else {
        throw new Error(`Invalid cosmos provider type ${tx.type}`);
      }

      const confirm = async (): Promise<TypedTransactionReceipt> => {
        assert(txDetails, `Cosmos tx failed: ${JSON.stringify(result)}`);
        return {
          type: tx.type,
          receipt: { ...txDetails, transactionHash: result.transactionHash },
        };
      };
      return { hash: result.transactionHash, confirm };
    },
    [onSwitchNetwork, chainToContext],
  );

  return { sendTransaction: onSendTx, switchNetwork: onSwitchNetwork };
}
