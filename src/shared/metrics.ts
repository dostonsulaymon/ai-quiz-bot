type BotMetrics = {
  totalUpdates: number;
  totalErrors: number;
  aiGenerations: {
    success: number;
    failed: number;
    totalMs: number;
  };
  activeUsers: Set<number>;
};

const metrics: BotMetrics = {
  totalUpdates: 0,
  totalErrors: 0,
  aiGenerations: {
    success: 0,
    failed: 0,
    totalMs: 0
  },
  activeUsers: new Set()
};

export function recordUpdate(userId: number): void {
  metrics.totalUpdates++;
  metrics.activeUsers.add(userId);
}

export function recordError(): void {
  metrics.totalErrors++;
}

export function recordAIGeneration(success: boolean, durationMs: number): void {
  if (success) {
    metrics.aiGenerations.success++;
  } else {
    metrics.aiGenerations.failed++;
  }

  metrics.aiGenerations.totalMs += durationMs;
}

export function getMetrics(): {
  totalUpdates: number;
  totalErrors: number;
  aiGenerations: {
    success: number;
    failed: number;
    totalMs: number;
    avgMs: number;
  };
  activeUsers: number;
} {
  return {
    ...metrics,
    activeUsers: metrics.activeUsers.size,
    aiGenerations: {
      ...metrics.aiGenerations,
      avgMs:
        metrics.aiGenerations.success > 0
          ? Math.round(metrics.aiGenerations.totalMs / metrics.aiGenerations.success)
          : 0
    }
  };
}
