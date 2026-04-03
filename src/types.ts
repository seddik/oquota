export type CounterMode = 'day-of-year' | 'month' | 'year' | 'day' | 'range' | 'deadline' | 'copilot';

export type CopilotDisplayMode = 'raw-remaining' | 'raw-consumption' | 'consumption' | 'remaining-pool' | 'average-calibration';

export interface GeneralConfiguration {
  refreshIntervalSeconds: number;
  percentDecimals: number;
}

export interface CounterConfigurationInput {
  enabled: boolean;
  label: string;
  emoji: string;
  mode: CounterMode;
  monthlyCycleDay: number;
  dailyStartTime: string;
  dailyEndTime: string;
  rangeStartDate: string;
  rangeEndDate: string;
  deadlineDate: string;
  copilotDisplayMode: CopilotDisplayMode;
}

export interface CounterConfiguration extends CounterConfigurationInput {
  slot: number;
}

export interface ExtensionConfiguration {
  general: GeneralConfiguration;
  counters: CounterConfiguration[];
}

export interface ProgressWindow {
  start: Date;
  end: Date;
  now: Date;
  progress: number;
}

export interface CounterEvaluation {
  slot: number;
  visible: boolean;
  text: string;
  tooltip: string;
  accessibilityLabel: string;
}

export interface CopilotQuotaSnapshot {
  plan: string;
  entitlement: number;
  remaining: number;
  used: number;
  percentRemaining: number;
  percentUsed: number;
  cycleStartUtc: string;
  resetDateUtc: string;
  snapshotTimeUtc: string;
  billingCycleProgress: number;
  billingCycleRemainingPercent: number;
  elapsedDays: number;
  remainingDays: number;
  cycleDayNumber: number;
  averageDailyConsumed: number;
  todayConsumed: number;
  todayConsumedKnown: boolean;
  todayConsumptionIsApproximate: boolean;
  todayVsAverageRatio: number | null;
  daysAvailableAtCurrentPace: number | null;
  unlimited: boolean;
  overagePermitted: boolean;
}

export type CopilotQuotaResult =
  | {
      ok: true;
      data: CopilotQuotaSnapshot;
    }
  | {
      ok: false;
      message: string;
      needsSignIn?: boolean;
    };