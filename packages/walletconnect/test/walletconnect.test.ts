/*
Copyright 2018 - 2022 The Alephium Authors
This file is part of the alephium project.

The library is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

The library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with the library. If not, see <http://www.gnu.org/licenses/>.
*/
import { formatChain, parseChain, ProviderOptions, WalletConnectProvider } from '../src/index'
import { WalletClient } from './shared'
import { web3, node, verifySignedMessage, Project, groupOfAddress, ONE_ALPH, sleep } from '@alephium/web3'
import { PrivateKeyWallet } from '@alephium/web3-wallet'
import { SignClientTypes } from '@walletconnect/types'
import { Greeter, Main } from '../artifacts/ts'

const NETWORK_ID = 4
const CHAIN_GROUP = 0
const PORT = 22973
const RPC_URL = `http://localhost:${PORT}`

const TEST_RELAY_URL = process.env.TEST_RELAY_URL ? process.env.TEST_RELAY_URL : 'ws://localhost:5555'

const TEST_APP_METADATA = {
  name: 'Test App',
  description: 'Test App for WalletConnect',
  url: 'https://walletconnect.com/',
  icons: ['https://avatars.githubusercontent.com/u/37784886']
}

const TEST_WALLET_METADATA = {
  name: 'Test Wallet',
  description: 'Test Wallet for WalletConnect',
  url: 'https://walletconnect.com/',
  icons: ['https://avatars.githubusercontent.com/u/37784886']
}

const TEST_PROVIDER_OPTS: ProviderOptions = {
  networkId: NETWORK_ID,
  chainGroup: CHAIN_GROUP,

  metadata: TEST_APP_METADATA,
  logger: 'error',
  relayUrl: TEST_RELAY_URL
}

function getAccounts(): Record<string, PrivateKeyWallet> {
  const a = new PrivateKeyWallet({ privateKey: 'a642942e67258589cd2b1822c631506632db5a12aabcf413604e785300d762a5' })
  const b = PrivateKeyWallet.Random(1)
  const c = PrivateKeyWallet.Random(2)
  const d = PrivateKeyWallet.Random(3)
  return { a, b, c, d }
}

function getTestWalletClientOpts(accounts: Record<string, PrivateKeyWallet>) {
  return {
    networkId: NETWORK_ID,
    rpcUrl: RPC_URL,
    activePrivateKey: accounts.a.privateKey,
    relayUrl: TEST_RELAY_URL,
    metadata: TEST_WALLET_METADATA
  }
}

export const TEST_PROJECT_ID = process.env.TEST_PROJECT_ID ? process.env.TEST_PROJECT_ID : undefined

export const TEST_SIGN_CLIENT_OPTIONS: SignClientTypes.Options = {
  logger: 'error',
  relayUrl: TEST_RELAY_URL,
  projectId: TEST_PROJECT_ID,
  storageOptions: {
    database: ':memory:'
  },
  metadata: TEST_APP_METADATA
}

jest.setTimeout(30_000)

describe('Unit tests', function () {
  const expectedChainGroup0 = 2
  const expectedChainGroup1 = 1

  it('test formatChain & parseChain', () => {
    expect(formatChain(4, expectedChainGroup0)).toEqual('alephium:4/2')
    expect(formatChain(4, expectedChainGroup1)).toEqual('alephium:4/1')
    expect(formatChain(4, undefined)).toEqual('alephium:4/-1')
    expect(() => formatChain(4, -1)).toThrow()
    expect(parseChain('alephium:4/2')).toEqual({ networkId: 4, chainGroup: 2 })
    expect(parseChain('alephium:4/1')).toEqual({ networkId: 4, chainGroup: 1 })
    expect(parseChain('alephium:4/-1')).toEqual({ networkId: 4, chainGroup: undefined })
    expect(() => parseChain('alephium:4/-2')).toThrow()
  })

  it('should initialize providers', async () => {
    const provider0 = await WalletConnectProvider.init(TEST_PROVIDER_OPTS)
    expect(provider0.nodeProvider !== undefined).toEqual(true)
    expect(provider0.explorerProvider !== undefined).toEqual(true)
    const provider1 = await WalletConnectProvider.init({ ...TEST_PROVIDER_OPTS, methods: [] })
    expect(provider1.nodeProvider === undefined).toEqual(true)
    expect(provider1.explorerProvider === undefined).toEqual(true)
  })
})

describe('WalletConnectProvider with single chainGroup', function () {
  let provider: WalletConnectProvider
  let walletClient: WalletClient
  let walletAddress: string
  let accounts: Record<string, PrivateKeyWallet>

  beforeAll(async () => {
    web3.setCurrentNodeProvider(RPC_URL)
    provider = await WalletConnectProvider.init({
      ...TEST_PROVIDER_OPTS
    })
    accounts = getAccounts()
    const clientOpts = getTestWalletClientOpts(accounts)
    walletClient = await WalletClient.init(provider, clientOpts)
    walletAddress = walletClient.signer.address
    expect(walletAddress).toEqual(accounts.a.address)
    await provider.connect()
    expect(provider.permittedChain).toEqual('alephium:4/0')
    const selectetAddress = (await provider.getSelectedAccount()).address
    expect(selectetAddress).toEqual(accounts.a.address)
  })

  afterAll(async () => {
    if (!walletClient.disconnected) {
      // disconnect provider
      await Promise.all([
        new Promise<void>((resolve) => {
          provider.on('session_delete', () => {
            resolve()
          })
        }),
        walletClient.disconnect()
      ])
    }
    // expect provider to be disconnected
    expect(walletClient.client?.session.values.length).toEqual(0)
  })

  it('should forward requests', async () => {
    await provider.nodeProvider!.infos.getInfosVersion()
  })

  it('should sign', async () => {
    await verifySign(provider, walletClient, accounts)
  })

  it('accountChanged', async () => {
    // change to account within the same group
    const currentAddress = (await provider.getSelectedAccount()).address
    expect(currentAddress).toEqual(accounts.a.address)
    const newAccount = PrivateKeyWallet.Random(groupOfAddress(currentAddress))
    await verifyAccountsChange(newAccount.privateKey, newAccount.address, provider, walletClient)

    // change back to account a
    await verifyAccountsChange(accounts.a.privateKey, accounts.a.address, provider, walletClient)

    // change to account b, which is not supported
    expectThrowsAsync(
      async () => await walletClient.changeAccount(accounts.b.privateKey),
      'Error changing account, chain alephium:4/1 not permitted'
    )
  })

  it('networkChanged', async () => {
    // change to testnet
    await verifyNetworkChange(1, 'https://testnet-wallet.alephium.org', provider, walletClient)
  })
})

describe('WalletConnectProvider with arbitrary chainGroup', function () {
  let provider: WalletConnectProvider
  let walletClient: WalletClient
  let walletAddress: string
  let accounts: Record<string, PrivateKeyWallet>

  beforeAll(async () => {
    web3.setCurrentNodeProvider(RPC_URL)
    provider = await WalletConnectProvider.init({
      ...TEST_PROVIDER_OPTS,
      networkId: NETWORK_ID,
      chainGroup: undefined
    })
    accounts = getAccounts()
    const clientOpts = getTestWalletClientOpts(accounts)
    walletClient = await WalletClient.init(provider, clientOpts)
    walletAddress = walletClient.signer.address
    expect(walletAddress).toEqual(accounts.a.address)
    await provider.connect()
    expect(provider.permittedChain).toEqual('alephium:4/-1')
    const selectedAddress = (await provider.getSelectedAccount()).address
    expect(selectedAddress).toEqual(accounts.a.address)
  })

  afterAll(async () => {
    if (!walletClient.disconnected) {
      // disconnect provider
      await Promise.all([
        new Promise<void>((resolve) => {
          provider.on('session_delete', () => {
            resolve()
          })
        }),
        walletClient.disconnect()
      ])
    }
    // expect provider to be disconnected
    expect(walletClient.client?.session.values.length).toEqual(0)
  })

  it('should forward requests', async () => {
    await provider.nodeProvider!.infos.getInfosVersion()
  })

  it('should sign', async () => {
    await verifySign(provider, walletClient, accounts)
  })

  it('accountChanged', async () => {
    // change to account c
    await verifyAccountsChange(accounts.c.privateKey, accounts.c.address, provider, walletClient)

    // change to account b
    await verifyAccountsChange(accounts.b.privateKey, accounts.b.address, provider, walletClient)

    // change back to account a
    await verifyAccountsChange(accounts.a.privateKey, accounts.a.address, provider, walletClient)
  })
})

async function verifyNetworkChange(
  networkId: number,
  rpcUrl: string,
  provider: WalletConnectProvider,
  walletClient: WalletClient
) {
  await Promise.all([
    new Promise<void>((resolve, _reject) => {
      provider.on('session_delete', () => {
        resolve()
      })
    }),
    await walletClient.changeChain(networkId, rpcUrl)
  ])
}

async function verifyAccountsChange(
  privateKey: string,
  address: string,
  provider: WalletConnectProvider,
  walletClient: WalletClient
) {
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      provider.on('accountChanged', (account) => {
        try {
          expect(account.address).toEqual(address)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
    }),
    walletClient.changeAccount(privateKey)
  ])
}

async function verifySign(provider: WalletConnectProvider, walletClient: WalletClient, accounts) {
  let balance: node.Balance
  async function checkBalanceDecreasing() {
    await sleep(500)
    const balance1 = await web3.getCurrentNodeProvider().addresses.getAddressesAddressBalance(accounts.a.address)
    if (balance1.balance >= balance.balance || balance1.balance === '0') {
      await checkBalanceDecreasing()
    }
    balance = balance1
  }

  await Project.build({ errorOnWarnings: false })
  const selectedAddress = (await provider.getSelectedAccount()).address

  expect(selectedAddress).toEqual(accounts.a.address)

  balance = await web3.getCurrentNodeProvider().addresses.getAddressesAddressBalance(accounts.a.address)

  await provider.signAndSubmitTransferTx({
    signerAddress: accounts.a.address,
    destinations: [{ address: accounts.b.address, attoAlphAmount: ONE_ALPH }]
  })

  await checkBalanceDecreasing()

  const greeterResult = await Greeter.deploy(provider, {
    initialFields: { btcPrice: BigInt(1) }
  })
  await checkBalanceDecreasing()

  await Main.execute(provider, {
    initialFields: { greeterContractId: greeterResult.contractId }
  })
  await checkBalanceDecreasing()

  const message = 'Hello Alephium!'
  const signedMessage = await provider.signMessage({
    message,
    messageHasher: 'alephium',
    signerAddress: accounts.a.address
  })

  expect(verifySignedMessage(message, 'alephium', accounts.a.publicKey, signedMessage.signature)).toEqual(true)
}

function expectThrowsAsync(method: () => Promise<any>, errorMessage: string) {
  expect(method()).rejects.toThrow(errorMessage)
}
