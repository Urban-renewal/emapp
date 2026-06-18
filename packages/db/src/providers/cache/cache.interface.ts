export interface ICacheProvider {
  get<T>(key: string): Promise<T | null>;
  /**
   * Batch-read several keys in ONE round-trip. Returns a Map of key→value for
   * the keys that are present and unexpired (missing/expired keys are absent
   * from the map). Lets a caller fold two dependent lookups (e.g. an epoch
   * counter + a value) into a single DB round-trip — the difference between
   * one and two sequential Neon round-trips on a hot read.
   */
  getMany<T>(keys: string[]): Promise<Map<string, T>>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  incrementCounter(key: string, ttlSeconds: number): Promise<number>;
  healthCheck(): Promise<void>;
}
