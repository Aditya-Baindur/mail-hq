export function fillForm(input: {
  origin: string;
  username?: string;
  password?: string;
  email?: string;
  mode?: 'login' | 'signup' | 'new-password';
  probe?: boolean;
}): {
  ok: boolean;
  code?: string;
  fields?: number;
  formless?: boolean;
  probe?: boolean;
  top?: boolean;
  count?: number;
};
export function pickFillFrame(
  probes:
    | Array<{
        frameId?: number;
        documentId?: string;
        result?: { ok?: boolean; probe?: boolean; count?: number; code?: string };
      } | null>
    | null
    | undefined,
): { ok: true; frameId: number; documentId?: string } | { ok: false; code: string };
