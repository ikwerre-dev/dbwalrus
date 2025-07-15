import express, { Request, Response } from 'express'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { WalrusClient } from '@mysten/walrus'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { coinWithBalance } from '@mysten/sui/transactions'
import { Signer } from '@mysten/sui/dist/cjs/cryptography'
import { parseStructTag } from '@mysten/sui/utils'
import CryptoJS from 'crypto-js'

const app = express()
const port = 39260

app.use(express.json())
app.use(express.text())


const useFundedKeyPair = false;

const NETWORK = "testnet";
const MAX_RETRIES = 1;
const RETRY_DELAY = 1000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


const client = new SuiClient({
    url: getFullnodeUrl(NETWORK),
    network: NETWORK,
}).$extend(
    WalrusClient.experimental_asClientExtension({
        uploadRelay: {
            host: 'https://upload-relay.testnet.walrus.space',
            sendTip: {
                max: 1_000,
            },
        },
    }),
);

function loadKeypairFromKeystore(): Ed25519Keypair {
    try {
        const privateKeyBase64 = 'ACTnZKIcWKK1iyewI5OWmeXMZ19n9OhY5vVrF8iReVKF';
        const privateKeyBytes = Buffer.from(privateKeyBase64, 'base64');
        return Ed25519Keypair.fromSecretKey(privateKeyBytes.slice(1));
    } catch (error) {
        console.error('Failed to load keypair from keystore:', error);
        console.log('Falling back to new keypair generation');
        return new Ed25519Keypair();
    }
}

let keypair: Ed25519Keypair;

if (useFundedKeyPair) {
    console.log('using funded')
    keypair = Ed25519Keypair.fromSecretKey(
        'suiprivkey1qzmcxscyglnl9hnq82crqsuns0q33frkseks5jw0fye3tuh83l7e6ajfhxx',
    );
} else {
    console.log('not using funded')

    keypair = loadKeypairFromKeystore();
}

app.get('/', (req: Request, res: Response) => {
    res.send('DBWalrus - SQL Data Blob Storage on Walrus');
});

app.get('/balance', async (req: Request, res: Response) => {
    try {
        const address = keypair.getPublicKey().toSuiAddress()

        const balance = await client.getBalance({
            owner: address,
        })

        const allBalances = await client.getAllBalances({
            owner: address,
        })

        const walBalance = allBalances.find(b =>
            b.coinType.includes('::wal::WAL')
        )

        res.json({
            address,
            network: NETWORK,
            balances: {
                sui: {
                    amount: balance.totalBalance,
                    formatted: (parseInt(balance.totalBalance) / 1_000_000_000).toFixed(9) + ' SUI'
                },
                wal: walBalance ? {
                    amount: walBalance.totalBalance,
                    coinType: walBalance.coinType,
                    formatted: (parseInt(walBalance.totalBalance) / 1_000_000_000).toFixed(9) + ' WAL'
                } : {
                    amount: '0',
                    formatted: '0 WAL',
                    note: 'No WAL tokens found'
                },
                all: allBalances
            }
        })
    } catch (error) {
        console.error('Error fetching balance:', error)
        res.status(500).json({
            error: 'Failed to fetch balance',
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})


async function saveSqlBlob(data: unknown, keypair: Signer, encryptionKey?: { key: string; salt: string; iterations: number }): Promise<{ blobId: string; timeSpent: number, blobObject: any, encryptionKey?: { key: string; salt: string; iterations: number } }> {
    const startTime = Date.now();
    let lastError: Error | null = null;
    console.log('start saving blob')
    console.log(startTime)
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            let dataToStore = typeof data === 'string' ? data : JSON.stringify(data);
            let returnedEncryptionKey: { key: string; salt: string; iterations: number } | undefined;
            console.log('before encrption')
            if (encryptionKey) {
                dataToStore = encryptDataAdvanced(dataToStore, encryptionKey);
                returnedEncryptionKey = encryptionKey;
            }
            console.log('current time: ',(Date.now() - startTime) / 1000)

            const file = new TextEncoder().encode(dataToStore);

            const { blobId, blobObject } = await client.walrus.writeBlob({
                blob: file,
                deletable: true,
                epochs: 3,
                signer: keypair,
            });

            console.log(blobId, blobObject);
            console.log('Blob saved successfully with ID:', blobId);

            const timeSpent = (Date.now() - startTime) / 1000;

            const modifiedBlobObject = {
                ...blobObject,
                size: (parseInt(blobObject.size) / (1024 * 1024)).toFixed(6) + ' MB',
                storage: {
                    ...blobObject.storage,
                    storage_size: (parseInt(blobObject.storage.storage_size) / (1024 * 1024)).toFixed(2) + ' MB'
                }
            };

            return { blobObject: modifiedBlobObject, blobId, timeSpent, encryptionKey: returnedEncryptionKey };
        } catch (error) {
            lastError = error as Error;
            console.error(`Attempt ${i + 1} failed:`, error);
            console.log('failed time: ',(Date.now() - startTime) / 1000)

            if (i < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY * Math.pow(2, i);
                console.log(`Retrying in ${delay}ms...`);
                await wait(delay);
            }
        }
    }

    throw new Error(`Failed to save blob after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function retrieveBlob(blobId: string) {
    const blobBytes = await client.walrus.readBlob({ blobId });
    return new Blob([new Uint8Array(blobBytes)]);
}



app.post('/upload-sql', async (req: Request, res: Response) => {
    try {
        const { data, encryptionKey } = req.body;
        console.log('data gotten')
        if (!data || !encryptionKey) {
            return res.status(400).json({ error: 'Data and encryptionKey is required in request body' });
        }
        console.log('data parsed')
        if (!encryptionKey.key || !encryptionKey.salt || !encryptionKey.iterations) {
            return res.status(400).json({
                error: 'encryptionKey must be an object with key, salt, and iterations properties'
            });
        }
        console.log('before save blob')
        const result = await saveSqlBlob(data, keypair, encryptionKey);
        res.json(result);
    } catch (error) {
        console.error('Error uploading SQL data:', error);
        res.status(500).json({
            error: 'Failed to upload SQL data',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

app.post('/retrieve-sql/:blobId', async (req: Request, res: Response) => {
    try {
        const { blobId } = req.params;
        const { encryptionKey } = req.body;

        if (!blobId) {
            return res.status(400).json({ error: 'Blob ID is required' });
        }

        const blob = await retrieveBlob(blobId);
        const textDecoder = new TextDecoder('utf-8');
        const rawData = textDecoder.decode(await blob.arrayBuffer());

        let decryptedData: string | null = null;

        if (encryptionKey) {
            try {
                decryptedData = decryptDataAdvanced(rawData, encryptionKey.key);
            } catch (error) {
                return res.status(400).json({
                    error: 'Failed to decrypt data',
                    details: 'Invalid encryption key or corrupted data'
                });
            }
        }

        res.json({
            success: true,
            blobId,
            rawData,
            decryptedData,
            encrypted: !!encryptionKey,
            message: 'SQL data retrieved successfully from Walrus'
        });
    } catch (error) {
        console.error('Error retrieving SQL data:', error);
        res.status(500).json({
            error: 'Failed to retrieve SQL data',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});


app.get('/wallet-info', (req: Request, res: Response) => {
    res.json({
        address: keypair.getPublicKey().toSuiAddress(),
        network: NETWORK,
        message: 'Wallet information for Walrus operations'
    })
})

interface WalrusPackageConfig {
    systemObjectId: string;
    stakingPoolId: string;
    subsidiesObjectId?: string;
    exchangeIds?: string[];
}

const WALRUS_PACKAGE_CONFIG = {
    systemObjectId: '0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af',
    stakingPoolId: '0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3',
    subsidiesObjectId: '0xda799d85db0429765c8291c594d334349ef5bc09220e79ad397b30106161a0af',
    exchangeIds: [
        '0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073',
        '0x19825121c52080bb1073662231cfea5c0e4d905fd13e95f21e9a018f2ef41862',
        '0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5',
        '0x8d63209cf8589ce7aef8f262437163c67577ed09f3e636a9d8e0813843fb8bf1'
    ]
} satisfies WalrusPackageConfig;

app.post('/swap-sui-to-wal', async (req: Request, res: Response) => {
    try {
        const { amount } = req.body

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' })
        }

        const address = keypair.getPublicKey().toSuiAddress()

        const suiBalance = await client.getBalance({
            owner: address,
            coinType: '0x2::sui::SUI'
        })

        const requestedAmount = BigInt(Math.floor(amount * 1_000_000_000))

        if (BigInt(suiBalance.totalBalance) < requestedAmount) {
            return res.status(400).json({
                error: 'Insufficient SUI balance',
                required: requestedAmount.toString(),
                available: suiBalance.totalBalance
            })
        }

        const tx = new Transaction()

        const exchange = await client.getObject({
            id: WALRUS_PACKAGE_CONFIG.exchangeIds[0],
            options: {
                showType: true,
            },
        })

        if (!exchange.data?.type) {
            throw new Error('Exchange type not found')
        }

        const exchangePackageId = parseStructTag(exchange.data.type).address

        const wal = tx.moveCall({
            package: exchangePackageId,
            module: 'wal_exchange',
            function: 'exchange_all_for_wal',
            arguments: [
                tx.object(WALRUS_PACKAGE_CONFIG.exchangeIds[0]),
                coinWithBalance({
                    balance: requestedAmount,
                }),
            ],
        })

        tx.transferObjects([wal], address)

        const { digest } = await client.signAndExecuteTransaction({
            transaction: tx,
            signer: keypair,
            options: {
                showObjectChanges: true,
                showBalanceChanges: true,
                showEffects: true
            }
        })

        const { effects } = await client.waitForTransaction({
            digest,
            options: {
                showEffects: true,
            },
        })

        const allBalances = await client.getAllBalances({
            owner: address,
        })

        const walBalance = allBalances.find(b =>
            b.coinType.includes('::wal::WAL')
        )

        res.json({
            success: true,
            transactionDigest: digest,
            suiAmount: amount,
            exchangePackageId,
            status: effects?.status?.status,
            newWalBalance: walBalance ? walBalance.totalBalance : '0',
            walCoinType: walBalance?.coinType,
            message: 'SUI to WAL swap completed successfully'
        })
    } catch (error) {
        console.error('Error swapping SUI to WAL:', error)
        res.status(500).json({
            error: 'Failed to swap SUI to WAL',
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
})




function generateAdvancedEncryptionKey(): { key: string; salt: string; iterations: number } {
    const salt = CryptoJS.lib.WordArray.random(32);
    const entropy = CryptoJS.lib.WordArray.random(64);
    const iterations = 100000 + Math.floor(Math.random() * 50000);
    const key = CryptoJS.PBKDF2(entropy.toString(), salt, {
        keySize: 256 / 32,
        iterations: iterations,
        hasher: CryptoJS.algo.SHA512
    });

    return {
        key: key.toString(),
        salt: salt.toString(),
        iterations
    };
}

function encryptDataAdvanced(data: string, keyData: { key: string; salt: string; iterations: number }): string {
    const iv = CryptoJS.lib.WordArray.random(16);
    const key = CryptoJS.enc.Hex.parse(keyData.key);
    const encrypted = CryptoJS.AES.encrypt(data, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    const metadata = JSON.stringify({ salt: keyData.salt, iterations: keyData.iterations });
    return CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(metadata)) + ':' + iv.toString() + ':' + encrypted.toString();
}

function decryptDataAdvanced(encryptedData: string, key: string): string {
    const parts = encryptedData.split(':');
    const metadata = JSON.parse(CryptoJS.enc.Base64.parse(parts[0]).toString(CryptoJS.enc.Utf8));
    const iv = CryptoJS.enc.Hex.parse(parts[1]);
    const encrypted = parts[2];
    const keyWordArray = CryptoJS.enc.Hex.parse(key);
    const decrypted = CryptoJS.AES.decrypt(encrypted, keyWordArray, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    return decrypted.toString(CryptoJS.enc.Utf8);
}

async function deleteBlob(blobObjectId: string) {
    try {
        const result = await client.walrus.executeDeleteBlobTransaction({
            signer: keypair,
            blobObjectId: blobObjectId,
        });
        return result;
    } catch (error) {
        throw new Error(`Failed to delete blob: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

app.delete('/delete-blob/:blobObjectId', async (req: Request, res: Response) => {
    try {
        const { blobObjectId } = req.params;

        if (!blobObjectId) {
            return res.status(400).json({ error: 'Blob object ID is required' });
        }

        const result = await deleteBlob(blobObjectId);

        res.json({
            success: true,
            blobObjectId,
            result,
            message: 'Blob deleted successfully from Walrus'
        });
    } catch (error) {
        console.error('Error deleting blob:', error);
        res.status(500).json({
            error: 'Failed to delete blob',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

app.get('/generate-advanced-encryption-key', (req: Request, res: Response) => {
    try {
        const encryptionKeyData = generateAdvancedEncryptionKey();
        res.json({
            success: true,
            encryptionKey: encryptionKeyData,
            message: 'Advanced encryption key generated successfully'
        });
    } catch (error) {
        console.error('Error generating advanced encryption key:', error);
        res.status(500).json({
            error: 'Failed to generate advanced encryption key',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

app.get('/generate-encryption-key', (req: Request, res: Response) => {
    try {
        const encryptionKey = generateAdvancedEncryptionKey();
        res.json({
            success: true,
            encryptionKey,
            message: 'Encryption key generated successfully'
        });
    } catch (error) {
        console.error('Error generating encryption key:', error);
        res.status(500).json({
            error: 'Failed to generate encryption key',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

app.listen(port, () => {
    console.log(`DBWalrus server running at http://localhost:${port}`)
    console.log(`Wallet address: ${keypair.getPublicKey().toSuiAddress()}`)
    console.log('Connected to Walrus testnet')
})
