/** Type declarations for the Chromium stderr classifier used by the E2E harness. */
export declare function isBrowserNoise(line: string): boolean;
export declare function isExtensionLoadFailure(line: string): boolean;
export declare function extensionLoadErrors(stderr: string, limit?: number): string[];
