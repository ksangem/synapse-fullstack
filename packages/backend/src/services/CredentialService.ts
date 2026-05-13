import crypto from 'node:crypto';
import { config } from '../config';

interface EncryptedData {
  iv: string;
  ciphertext: string;
  authTag: string;
}

export class CredentialService {
  private readonly key: Buffer;

  constructor(encryptionKey?: string) {
    const keyHex = encryptionKey ?? config.ENCRYPTION_KEY;
    this.key = Buffer.from(keyHex, 'hex');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const authTag = cipher.getAuthTag();

    const payload: EncryptedData = {
      iv: iv.toString('base64'),
      ciphertext,
      authTag: authTag.toString('base64'),
    };

    return JSON.stringify(payload);
  }

  decrypt(encryptedPayload: string): string {
    const payload: EncryptedData = JSON.parse(encryptedPayload);

    const iv = Buffer.from(payload.iv, 'base64');
    const authTag = Buffer.from(payload.authTag, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(payload.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
