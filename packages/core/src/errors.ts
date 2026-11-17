// SPDX-License-Identifier: AGPL-3.0-or-later
export type CoreError =
  | { kind: "forbidden"; capability: string }
  | { kind: "invalid-input"; field: string; message: string }
  | { kind: "not-found"; resource: string; id: string };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (error: CoreError): Result<never> => ({ ok: false, error });
