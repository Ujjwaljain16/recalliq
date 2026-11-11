export function clock(ms: number, timeZone: string): string;
export function shortDate(ms: number, now: number, timeZone: string): string;
export function listStamp(ms: number, now: number, timeZone: string): string;
export function duration(ms: number): string;
export function localTimeLabel(localTime: string, options?: { long?: boolean }): string;
