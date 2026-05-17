import type { IRealtimeProvider, RealtimeEvent } from './realtime.interface';

export class FakeRealtimeProvider implements IRealtimeProvider {
  public emittedToUser: Array<{ userId: string; event: RealtimeEvent }> = [];
  public emittedToOrg: Array<{ orgId: string; event: RealtimeEvent }> = [];

  emitToUser(userId: string, event: RealtimeEvent): void {
    this.emittedToUser.push({ userId, event });
  }

  emitToOrg(orgId: string, event: RealtimeEvent): void {
    this.emittedToOrg.push({ orgId, event });
  }

  registerSession(): void {}
  unregisterSession(): void {}

  reset(): void {
    this.emittedToUser = [];
    this.emittedToOrg = [];
  }
}
