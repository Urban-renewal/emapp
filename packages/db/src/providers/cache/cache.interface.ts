export interface ICacheProvider {
  get<T>(orgId: string, key: string): Promise<T | null>;
  set<T>(orgId: string, key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(orgId: string, key: string): Promise<void>;
  incrementCounter(orgId: string, key: string, ttlSeconds: number): Promise<number>;
  healthCheck(): Promise<void>;
}
