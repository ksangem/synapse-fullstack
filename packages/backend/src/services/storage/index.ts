/**
 * Storage providers — public surface + built-in registration.
 *
 * registerBuiltinStorageProviders() is called once from hub/register-connectors
 * (idempotent). It is the ONLY place that names concrete providers; adding S3/Azure/
 * Drive is a new line here, nothing else.
 */
import { registerStorageProvider } from './registry';
import { SftpStorageProvider } from './SftpStorageProvider';
import { LocalFsStorageProvider } from './LocalFsStorageProvider';
import { SharePointDriveStorageProvider } from './SharePointDriveStorageProvider';
import { S3StorageProvider } from './S3StorageProvider';
import { AzureBlobStorageProvider } from './AzureBlobStorageProvider';
import { GoogleDriveStorageProvider } from './GoogleDriveStorageProvider';

export * from './StorageProvider';
export * from './registry';

let registered = false;

export function registerBuiltinStorageProviders(): void {
  if (registered) return;
  registered = true;
  registerStorageProvider('sftp', (creds) => new SftpStorageProvider(creds));
  registerStorageProvider('local', (creds) => new LocalFsStorageProvider(creds));
  registerStorageProvider('sharepoint', (creds) => new SharePointDriveStorageProvider(creds));
  registerStorageProvider('s3', (creds, config) => new S3StorageProvider(creds, config));
  registerStorageProvider('azureblob', (creds, config) => new AzureBlobStorageProvider(creds, config));
  registerStorageProvider('gdrive', (creds, config) => new GoogleDriveStorageProvider(creds, config));
}

/** For tests: allow re-registration of built-ins after a manual override. */
export function _resetBuiltinsForTest(): void {
  registered = false;
}
