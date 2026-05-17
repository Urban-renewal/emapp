export interface ICacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  incrementCounter(key: string, ttlSeconds: number): Promise<number>;
  healthCheck(): Promise<void>;
}
