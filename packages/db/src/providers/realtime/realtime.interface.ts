export interface RealtimeEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface IRealtimeProvider {
  emitToUser(userId: string, event: RealtimeEvent): void;
  emitToOrg(orgId: string, event: RealtimeEvent): void;
  registerSession(
    sessionId: string,
    userId: string,
    orgId: string,
    send: (event: RealtimeEvent) => void,
  ): void;
  unregisterSession(sessionId: string): void;
}
