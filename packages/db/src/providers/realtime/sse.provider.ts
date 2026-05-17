import type { IRealtimeProvider, RealtimeEvent } from './realtime.interface';

interface Session {
  userId: string;
  orgId: string;
  send: (event: RealtimeEvent) => void;
}

export class SseRealtimeProvider implements IRealtimeProvider {
  private readonly sessions = new Map<string, Session>();

  registerSession(
    sessionId: string,
    userId: string,
    orgId: string,
    send: (event: RealtimeEvent) => void,
  ): void {
    this.sessions.set(sessionId, { userId, orgId, send });
  }

  unregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  emitToUser(userId: string, event: RealtimeEvent): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        try {
          session.send(event);
        } catch {
          // Dead connection — caller should unregister
        }
      }
    }
  }

  emitToOrg(orgId: string, event: RealtimeEvent): void {
    for (const session of this.sessions.values()) {
      if (session.orgId === orgId) {
        try {
          session.send(event);
        } catch {
          // Dead connection — caller should unregister
        }
      }
    }
  }
}
