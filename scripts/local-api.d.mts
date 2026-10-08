export const defaultApiPort: number;
export function apiPort(env: Record<string, string | undefined>): number;
export function httpOrigin(value: string, name: string): string;
export function localApiBase(env: Record<string, string | undefined>): string;
