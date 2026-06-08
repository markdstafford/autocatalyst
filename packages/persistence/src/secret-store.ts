import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

import { eq } from 'drizzle-orm';

import type { CreateSecretInput, SecretStore } from '@autocatalyst/core';
import { SecretStoreLockedError } from '@autocatalyst/core';
import type { CreateSecretResponse } from '@autocatalyst/api-contract';

import { secretStoreMetadata, secrets } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

const scryptAsync = promisify(scrypt);

const ENCRYPTION_VERSION = 'v1';
const METADATA_ID = 'default';
const KDF_NAME = 'scrypt';
const KDF_PARAMS = { cost: 16384, blockSize: 8, parallelization: 1, keyLength: 32 } as const;
const SENTINEL_PLAINTEXT = 'autocatalyst-secret-store-v1';
const MAX_HANDLE_RETRIES = 5;

export class SecretStoreUnlockError extends Error {
  constructor() {
    super('Failed to unlock secret store: invalid master secret or corrupted store.');
    this.name = 'SecretStoreUnlockError';
  }
}

interface RandomBytesProvider {
  (size: number): Buffer;
}

interface SqliteSecretStoreOptions {
  readonly randomBytes?: RandomBytesProvider;
}

export class SqliteSecretStore implements SecretStore {
  readonly #database;
  #encryptionKey: Buffer | null = null;
  readonly #randomBytes: RandomBytesProvider;

  constructor(database: SqliteDatabase, options: SqliteSecretStoreOptions = {}) {
    this.#database = asInternalSqliteDatabase(database);
    this.#randomBytes = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  }

  async unlock(masterSecret: string): Promise<void> {
    if (masterSecret.trim().length === 0) {
      throw new SecretStoreUnlockError();
    }

    // Idempotent: if already unlocked, skip
    if (this.#encryptionKey !== null) {
      return;
    }

    const existingMetadata = this.#database.drizzle
      .select()
      .from(secretStoreMetadata)
      .where(eq(secretStoreMetadata.id, METADATA_ID))
      .get();

    if (existingMetadata === undefined) {
      // First unlock: initialize store
      // Use nodeRandomBytes directly (not the injectable provider) for crypto material
      // generated during unlock — the injectable provider is reserved for handle generation.
      const salt = nodeRandomBytes(32);
      const key = await this.#deriveKey(masterSecret, salt, KDF_PARAMS);
      const sentinelNonce = nodeRandomBytes(12);
      const encrypted = this.#encrypt(key, sentinelNonce, Buffer.from(SENTINEL_PLAINTEXT, 'utf8'));

      this.#database.drizzle.insert(secretStoreMetadata).values({
        id: METADATA_ID,
        encryptionVersion: ENCRYPTION_VERSION,
        kdfName: KDF_NAME,
        kdfParamsJson: JSON.stringify(KDF_PARAMS),
        kdfSalt: salt.toString('base64'),
        sentinelNonce: sentinelNonce.toString('base64'),
        sentinelCiphertext: encrypted.ciphertext.toString('base64'),
        sentinelAuthTag: encrypted.authTag.toString('base64'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).run();

      this.#encryptionKey = key;
    } else {
      // Existing store: verify master secret via sentinel
      const salt = Buffer.from(existingMetadata.kdfSalt, 'base64');
      const params = JSON.parse(existingMetadata.kdfParamsJson) as typeof KDF_PARAMS;
      const key = await this.#deriveKey(masterSecret, salt, params);

      try {
        const sentinelNonce = Buffer.from(existingMetadata.sentinelNonce, 'base64');
        const sentinelCiphertext = Buffer.from(existingMetadata.sentinelCiphertext, 'base64');
        const sentinelAuthTag = Buffer.from(existingMetadata.sentinelAuthTag, 'base64');
        const decrypted = this.#decrypt(key, sentinelNonce, sentinelCiphertext, sentinelAuthTag);
        if (decrypted.toString('utf8') !== SENTINEL_PLAINTEXT) {
          throw new SecretStoreUnlockError();
        }
      } catch (error) {
        if (error instanceof SecretStoreUnlockError) throw error;
        // AES-GCM auth failure throws, treat as wrong master secret
        throw new SecretStoreUnlockError();
      }

      this.#encryptionKey = key;
    }
  }

  async createSecret(input: CreateSecretInput): Promise<CreateSecretResponse> {
    if (this.#encryptionKey === null) {
      throw new SecretStoreLockedError();
    }

    for (let attempt = 0; attempt < MAX_HANDLE_RETRIES; attempt++) {
      const handleBytes = this.#randomBytes(24);
      const handle = `sec_${handleBytes.toString('base64url')}`;

      const nonce = nodeRandomBytes(12);
      const encrypted = this.#encrypt(this.#encryptionKey, nonce, Buffer.from(input.value, 'utf8'));

      try {
        this.#database.drizzle.insert(secrets).values({
          handle,
          ciphertext: encrypted.ciphertext.toString('base64'),
          nonce: nonce.toString('base64'),
          authTag: encrypted.authTag.toString('base64'),
          encryptionVersion: ENCRYPTION_VERSION,
          createdAt: new Date().toISOString()
        }).run();
        return { handle };
      } catch {
        // Primary key collision: retry with fresh bytes
        if (attempt === MAX_HANDLE_RETRIES - 1) {
          throw new Error('Unable to allocate secret handle.');
        }
        continue;
      }
    }

    throw new Error('Unable to allocate secret handle.');
  }

  async #deriveKey(
    masterSecret: string,
    salt: Buffer,
    params: { cost: number; blockSize: number; parallelization: number; keyLength: number }
  ): Promise<Buffer> {
    return scryptAsync(
      masterSecret,
      salt,
      params.keyLength,
      { N: params.cost, r: params.blockSize, p: params.parallelization }
    ) as Promise<Buffer>;
  }

  #encrypt(
    key: Buffer,
    nonce: Buffer,
    plaintext: Buffer
  ): { ciphertext: Buffer; authTag: Buffer } {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, authTag };
  }

  #decrypt(
    key: Buffer,
    nonce: Buffer,
    ciphertext: Buffer,
    authTag: Buffer
  ): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
