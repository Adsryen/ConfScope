import {
  DeleteSecureSecret,
  ReadSecureSecret,
  WriteSecureSecret,
  type SecureSecretRef,
  type SecureSecretWriteResult,
} from "../../wailsjs/go/main/App";

export type { SecureSecretRef, SecureSecretWriteResult };

export function writeSecureSecret(ref: SecureSecretRef, value: string): Promise<SecureSecretWriteResult> {
  return WriteSecureSecret(ref, value);
}

export function readSecureSecret(ref: SecureSecretRef): Promise<string> {
  return ReadSecureSecret(ref);
}

export function deleteSecureSecret(ref: SecureSecretRef): Promise<void> {
  return DeleteSecureSecret(ref);
}
