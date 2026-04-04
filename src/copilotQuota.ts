import * as vscode from 'vscode';

import { CopilotQuotaResult, CopilotQuotaSnapshot } from './types';

interface CopilotQuotaApiSnapshot {
  quota_id?: string;
  timestamp_utc?: string;
  entitlement?: number;
  quota_remaining?: number;
  remaining?: number;
  unlimited?: boolean;
  overage_permitted?: boolean;
}

interface CopilotQuotaApiResponse {
  copilot_plan?: string;
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  quota_snapshots?: Record<string, CopilotQuotaApiSnapshot>;
}

const CACHE_TTL_MS = 30_000;
const GITHUB_SCOPE = ['user:email'];
const COPILOT_ENDPOINT = 'https://api.github.com/copilot_internal/user';
const SNAPSHOT_HISTORY_KEY = 'oquota.copilotSnapshotHistory';
const MAX_HISTORY = 512;

interface LocalQuotaSnapshot {
  timestampUtc: string;
  used: number;
  entitlement: number;
  resetDateUtc: string;
}

let cachedResult: CopilotQuotaResult | undefined;
let cachedAt = 0;
let inFlight: Promise<CopilotQuotaResult> | undefined;

export async function getCopilotQuota(
  context?: vscode.ExtensionContext,
  forceRefresh = false,
): Promise<CopilotQuotaResult> {
  if (!forceRefresh && cachedResult && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = fetchCopilotQuota(context);

  try {
    const result = await inFlight;
    cachedResult = result;
    cachedAt = Date.now();
    return result;
  } finally {
    inFlight = undefined;
  }
}

export function clearCopilotQuotaCache(): void {
  cachedResult = undefined;
  cachedAt = 0;
}

async function fetchCopilotQuota(context?: vscode.ExtensionContext): Promise<CopilotQuotaResult> {
  const session = await vscode.authentication.getSession('github', GITHUB_SCOPE, { createIfNone: false });
  if (!session) {
    return {
      ok: false,
      message: 'Sign in to GitHub in VS Code to read Copilot quota data.',
      needsSignIn: true,
    };
  }

  const response = await fetch(COPILOT_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'oQuota',
    },
  });

  if (response.status === 401) {
    return {
      ok: false,
      message: 'GitHub authentication failed while reading Copilot quota data.',
      needsSignIn: true,
    };
  }

  if (response.status === 403 || response.status === 404) {
    return {
      ok: false,
      message: 'This GitHub account does not expose Copilot quota data through the internal endpoint.',
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `GitHub Copilot API returned ${response.status}: ${response.statusText}`,
    };
  }

  const apiData = (await response.json()) as CopilotQuotaApiResponse;
  const snapshots = apiData.quota_snapshots ? Object.values(apiData.quota_snapshots) : [];
  const premiumQuota = snapshots.find((snapshot) => snapshot.quota_id === 'premium_interactions');

  if (!premiumQuota) {
    return {
      ok: false,
      message: 'No premium Copilot quota snapshot was returned for this account.',
    };
  }

  const resetDateRaw = apiData.quota_reset_date_utc ?? apiData.quota_reset_date;
  const resetDate = resetDateRaw ? new Date(resetDateRaw) : undefined;
  const snapshotTime = premiumQuota.timestamp_utc ? new Date(premiumQuota.timestamp_utc) : new Date();

  if (!resetDate || Number.isNaN(resetDate.getTime())) {
    return {
      ok: false,
      message: 'GitHub Copilot quota data is missing a valid reset date.',
    };
  }

  const unlimited = Boolean(premiumQuota.unlimited);
  const entitlement = normalizeNumber(premiumQuota.entitlement);
  const remaining = normalizeNumber(
    Number.isFinite(premiumQuota.quota_remaining) ? premiumQuota.quota_remaining : premiumQuota.remaining,
  );
  const used = unlimited ? 0 : entitlement - remaining;
  const percentRemaining = unlimited || entitlement <= 0 ? 100 : (remaining / entitlement) * 100;
  const percentUsed = unlimited || entitlement <= 0 ? 0 : (used / entitlement) * 100;
  const cycleStart = shiftUtcMonth(resetDate, -1);
  const cycleDuration = resetDate.getTime() - cycleStart.getTime();
  const elapsed = Math.min(Math.max(snapshotTime.getTime() - cycleStart.getTime(), 0), Math.max(cycleDuration, 0));
  const billingCycleProgress = cycleDuration <= 0 ? 0 : elapsed / cycleDuration;
  const billingCycleRemainingPercent = (1 - billingCycleProgress) * 100;
  const elapsedDays = Math.max(snapshotTime.getTime() - cycleStart.getTime(), 0) / 86_400_000;
  const remainingDays = Math.max(resetDate.getTime() - snapshotTime.getTime(), 0) / 86_400_000;
  const cycleDayNumber = Math.max(getCalendarDayDistance(cycleStart, snapshotTime) + 1, 1);
  const history = context ? await recordSnapshotAndLoadHistory(context, {
    timestampUtc: snapshotTime.toISOString(),
    used,
    entitlement,
    resetDateUtc: resetDate.toISOString(),
  }) : [];
  const todayUsage = deriveTodayConsumption(history, cycleStart, snapshotTime, used, resetDate.toISOString());
  const completedDaysBeforeToday = Math.max(cycleDayNumber - 1, 0);
  const usedBeforeToday = Math.max(used - todayUsage.todayConsumed, 0);
  const averageDailyConsumed = completedDaysBeforeToday > 0 ? usedBeforeToday / completedDaysBeforeToday : 0;
  const daysAvailableAtCurrentPace = averageDailyConsumed > 0 ? remaining / averageDailyConsumed : null;

  const data: CopilotQuotaSnapshot = {
    plan: apiData.copilot_plan?.trim() || 'GitHub Copilot',
    entitlement,
    remaining,
    used,
    percentRemaining,
    percentUsed,
    cycleStartUtc: cycleStart.toISOString(),
    resetDateUtc: resetDate.toISOString(),
    snapshotTimeUtc: snapshotTime.toISOString(),
    billingCycleProgress,
    billingCycleRemainingPercent,
    elapsedDays,
    remainingDays,
    cycleDayNumber,
    averageDailyConsumed,
    todayConsumed: todayUsage.todayConsumed,
    todayConsumedKnown: todayUsage.known,
    todayConsumptionIsApproximate: todayUsage.approximate,
    todayVsAverageRatio: averageDailyConsumed > 0 ? todayUsage.todayConsumed / averageDailyConsumed : null,
    daysAvailableAtCurrentPace,
    unlimited,
    overagePermitted: Boolean(premiumQuota.overage_permitted),
  };

  return {
    ok: true,
    data,
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function shiftUtcMonth(value: Date, delta: number): Date {
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  const seconds = value.getUTCSeconds();
  const milliseconds = value.getUTCMilliseconds();
  const day = value.getUTCDate();
  const firstOfTargetMonth = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + delta, 1, hours, minutes, seconds, milliseconds));
  const lastDay = new Date(Date.UTC(firstOfTargetMonth.getUTCFullYear(), firstOfTargetMonth.getUTCMonth() + 1, 0, hours, minutes, seconds, milliseconds)).getUTCDate();
  const resolvedDay = Math.min(day, lastDay);

  return new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth(),
    resolvedDay,
    hours,
    minutes,
    seconds,
    milliseconds,
  ));
}

async function recordSnapshotAndLoadHistory(
  context: vscode.ExtensionContext,
  current: LocalQuotaSnapshot,
): Promise<LocalQuotaSnapshot[]> {
  const history = context.globalState.get<LocalQuotaSnapshot[]>(SNAPSHOT_HISTORY_KEY, []);
  const merged = [...history];
  const last = merged.at(-1);

  if (!last || last.timestampUtc !== current.timestampUtc || last.used !== current.used || last.resetDateUtc !== current.resetDateUtc) {
    merged.push(current);
  }

  const trimmed = merged.slice(-MAX_HISTORY);
  await context.globalState.update(SNAPSHOT_HISTORY_KEY, trimmed);
  return trimmed;
}

function deriveTodayConsumption(
  history: LocalQuotaSnapshot[],
  cycleStart: Date,
  snapshotTime: Date,
  used: number,
  resetDateUtc: string,
): { todayConsumed: number; known: boolean; approximate: boolean } {
  const relevant = history
    .filter((entry) => entry.resetDateUtc === resetDateUtc)
    .map((entry) => ({
      ...entry,
      date: new Date(entry.timestampUtc),
    }))
    .filter((entry) => !Number.isNaN(entry.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());

  const startOfToday = new Date(snapshotTime);
  startOfToday.setHours(0, 0, 0, 0);
  const cycleStartedToday = cycleStart.getTime() >= startOfToday.getTime();
  const latestBeforeToday = [...relevant].reverse().find((entry) => entry.date.getTime() < startOfToday.getTime());

  if (latestBeforeToday) {
    return {
      todayConsumed: Math.max(used - latestBeforeToday.used, 0),
      known: true,
      approximate: false,
    };
  }

  if (cycleStartedToday) {
    return {
      todayConsumed: used,
      known: true,
      approximate: false,
    };
  }

  const firstToday = relevant.find((entry) => isSameLocalDate(entry.date, snapshotTime));
  if (firstToday) {
    return {
      todayConsumed: Math.max(used - firstToday.used, 0),
      known: true,
      approximate: true,
    };
  }

  return {
    todayConsumed: 0,
    known: true,
    approximate: true,
  };
}

function getCalendarDayDistance(start: Date, end: Date): number {
  const startMidnight = new Date(start);
  startMidnight.setHours(0, 0, 0, 0);
  const endMidnight = new Date(end);
  endMidnight.setHours(0, 0, 0, 0);
  return Math.floor((endMidnight.getTime() - startMidnight.getTime()) / 86_400_000);
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}