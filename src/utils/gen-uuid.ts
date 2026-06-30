import { genRandom } from "./random";

export const genUUID = (): string => {
  return ((BigInt(Date.now()) * 10000n) + BigInt(genRandom())).toString(36);
};