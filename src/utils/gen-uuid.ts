import { genRandom } from "./random";

export const genUUID = (): string => {
  return (
    (BigInt(Date.now()) * 10000n) +
    BigInt(genRandom()) +
    (BigInt(genRandom(10, 99)) * 10000000000000000n)
  ).toString(36);
};