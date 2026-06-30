/**
 * Generates a cryptographically secure pseudo-random number (Universal for Node.js & Browser).
 *
 * @param min - The minimum value (default: 1000).
 * @param max - The maximum value (default: 9999).
 * @returns A secure random number between min and max (inclusive).
 */
export function genRandom(min: number = 1000, max: number = 9999): number {
    // 1. Web Crypto API environment (Web browsers and Node.js 19+)
    // Using type assertion 'any' to prevent TypeScript compiler environment dependency errors.
    const webCrypto = (typeof globalThis !== 'undefined' && (globalThis as any).crypto) ||
        (typeof window !== 'undefined' && (window as any).crypto);

    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
        const range: number = max - min + 1;
        const maxUnbiased: number = Math.floor((2 ** 32) / range) * range;
        const randomBuffer = new Uint32Array(1);

        let randomValue: number;
        do {
            webCrypto.getRandomValues(randomBuffer);
            // The value extracted from Uint32Array is guaranteed to be a number type.
            randomValue = randomBuffer[0] as number;
        } while (randomValue >= maxUnbiased); // Prevent modulo bias

        return min + (randomValue % range);
    }

    // 2. Node.js specific environment (Node.js 18 or lower without Web Crypto API)
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        try {
            // Bypass type errors when calling 'require' in TS and browser bundler environments.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const nodeRequire: NodeRequire | null = typeof require === 'function' ? require : null;

            if (nodeRequire) {
                const nodeCrypto = nodeRequire('crypto');
                if (nodeCrypto && typeof nodeCrypto.randomInt === 'function') {
                    // The second argument of randomInt is exclusive, so add 1 to make it inclusive.
                    return nodeCrypto.randomInt(min, max + 1);
                }
            }
        } catch (e) {
            // Ignore require load failures and fall through to the error throw below.
        }
    }

    // 3. Unsupported environment
    throw new Error("Environment does not support secure random number generation.");
}