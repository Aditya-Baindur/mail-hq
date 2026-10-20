export function failureCodeFromResponse(status: number, bodyError: unknown): string;
export function shouldAutoRetry(code: string): boolean;
export function showPairingSetup(input: {
  storedPairing?: boolean;
  paired?: boolean;
  state?: string;
  loadError?: string;
}): boolean;
export function signingKeyAction(input: {
  hasKey: boolean;
  reset?: boolean;
}): 'use' | 'mint' | 'missing';
