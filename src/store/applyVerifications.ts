// Apply 沙箱验证状态仓库：记录用户已人工确认的沙箱 apply 结果。
const KEY = "cs.applyVerifications";
const MAX_VERIFICATIONS = 200;

export interface ApplyVerificationTargetFingerprint {
  itemId: string;
  fingerprint: string;
}

export interface ApplyVerification {
  id: string;
  planId: string;
  applyHistoryId: string;
  sandboxConnectionId: string;
  sandboxConnectionName: string;
  sandboxNamespace: string;
  verifiedAt: string;
  verifiedTargetFingerprints: ApplyVerificationTargetFingerprint[];
}

export type ApplyVerificationInput = Omit<ApplyVerification, "id" | "verifiedAt">;

function genId(): string {
  return `verify_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function verifiedAtTime(verification: ApplyVerification): number {
  const time = new Date(verification.verifiedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortVerifications(verifications: ApplyVerification[]): ApplyVerification[] {
  return [...verifications].sort((a, b) => verifiedAtTime(b) - verifiedAtTime(a));
}

function normalizeFingerprint(value: unknown): ApplyVerificationTargetFingerprint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ApplyVerificationTargetFingerprint>;
  const itemId = stringValue(raw.itemId);
  const fingerprint = stringValue(raw.fingerprint);
  if (!itemId || !fingerprint) return null;
  return { itemId, fingerprint };
}

function normalizeVerification(value: unknown): ApplyVerification | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ApplyVerification>;
  const id = stringValue(raw.id);
  const planId = stringValue(raw.planId);
  const applyHistoryId = stringValue(raw.applyHistoryId);
  const sandboxConnectionId = stringValue(raw.sandboxConnectionId);
  const sandboxConnectionName = stringValue(raw.sandboxConnectionName);
  const sandboxNamespace = stringValue(raw.sandboxNamespace);
  const verifiedAt = stringValue(raw.verifiedAt);
  if (!id || !planId || !applyHistoryId || !sandboxConnectionId || !sandboxConnectionName || sandboxNamespace === undefined || !verifiedAt) {
    return null;
  }
  if (!Array.isArray(raw.verifiedTargetFingerprints)) return null;
  const verifiedTargetFingerprints = raw.verifiedTargetFingerprints.map(normalizeFingerprint);
  if (verifiedTargetFingerprints.some((item) => item === null)) return null;
  return {
    id,
    planId,
    applyHistoryId,
    sandboxConnectionId,
    sandboxConnectionName,
    sandboxNamespace,
    verifiedAt,
    verifiedTargetFingerprints: verifiedTargetFingerprints.filter((item): item is ApplyVerificationTargetFingerprint => item !== null),
  };
}

function saveAll(verifications: ApplyVerification[]): void {
  localStorage.setItem(KEY, JSON.stringify(sortVerifications(verifications).slice(0, MAX_VERIFICATIONS)));
}

export function loadApplyVerifications(): ApplyVerification[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortVerifications(parsed.map(normalizeVerification).filter((item): item is ApplyVerification => item !== null));
  } catch {
    return [];
  }
}

export function saveApplyVerification(input: ApplyVerificationInput): ApplyVerification {
  const verification: ApplyVerification = {
    ...input,
    id: genId(),
    verifiedAt: new Date().toISOString(),
  };
  const next = [verification, ...loadApplyVerifications().filter((item) => item.applyHistoryId !== input.applyHistoryId)];
  saveAll(next);
  return verification;
}

export function findApplyVerification(planId: string, applyHistoryId?: string): ApplyVerification | null {
  return (
    loadApplyVerifications().find(
      (verification) => verification.planId === planId && (!applyHistoryId || verification.applyHistoryId === applyHistoryId)
    ) ?? null
  );
}

export function deleteApplyVerification(id: string): void {
  saveAll(loadApplyVerifications().filter((verification) => verification.id !== id));
}

export function clearApplyVerifications(): void {
  localStorage.removeItem(KEY);
}
