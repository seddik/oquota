import {
  CounterConfiguration,
  CounterEvaluation,
  CopilotQuotaResult,
  ProgressWindow,
} from './types';

const DEFAULT_PERCENT_DECIMALS = 0;

export function evaluateCounter(
  counter: CounterConfiguration,
  now: Date = new Date(),
  copilotQuota?: CopilotQuotaResult,
): CounterEvaluation {
  if (!counter.enabled) {
    return {
      slot: counter.slot,
      visible: false,
      text: '',
      tooltip: '',
      accessibilityLabel: '',
    };
  }

  if (counter.mode === 'copilot') {
    return evaluateCopilotCounter(counter, copilotQuota);
  }

  const result = buildProgressWindow(counter, now);
  if (!result.ok) {
    const invalidText = `${formatTextPrefix(counter)}invalid`.trim();
    const tooltip = `${titleForCounter(counter)}\n\n${result.message}\n\nClick to configure this counter.`;

    return {
      slot: counter.slot,
      visible: true,
      text: invalidText,
      tooltip,
      accessibilityLabel: invalidText,
    };
  }

  const percentage = formatPercent(result.window.progress, DEFAULT_PERCENT_DECIMALS);
  const text = formatProgressText(counter, result.window, percentage);
  const tooltip = [
    `${titleForCounter(counter)}: ${percentage}`,
    `Mode: ${readableMode(counter.mode)}`,
    ...buildWindowSummary(counter, result.window),
    `Updated: ${formatDateTime(result.window.now)}`,
    '',
    'Click to configure this counter.',
  ].join('\n');

  return {
    slot: counter.slot,
    visible: true,
    text,
    tooltip,
    accessibilityLabel: `${titleForCounter(counter)} ${percentage}`,
  };
}

function buildProgressWindow(
  counter: CounterConfiguration,
  now: Date,
): { ok: true; window: ProgressWindow } | { ok: false; message: string } {
  switch (counter.mode) {
    case 'day-of-year':
      return { ok: true, window: buildYearWindow(now) };
    case 'month':
      return buildMonthlyWindow(counter, now);
    case 'year':
      return { ok: true, window: buildYearWindow(now) };
    case 'day':
      return buildDayWindow(counter, now);
    case 'range':
      return buildRangeWindow(counter, now);
    case 'deadline':
      return buildDeadlineWindow(counter, now);
    case 'copilot':
      return { ok: false, message: 'Copilot mode is evaluated separately.' };
  }
}

function evaluateCopilotCounter(
  counter: CounterConfiguration,
  copilotQuota?: CopilotQuotaResult,
): CounterEvaluation {
  if (!copilotQuota) {
    const text = `${formatCopilotLabelPrefix(counter)}loading`.trim();
    return {
      slot: counter.slot,
      visible: true,
      text,
      tooltip: `Type: ${readableCopilotDisplayMode(counter)}\n${titleForCounter(counter)}\n\nLoading GitHub Copilot quota data...`,
      accessibilityLabel: text,
    };
  }

  if (!copilotQuota.ok) {
    const text = `${formatCopilotLabelPrefix(counter)}unavailable`.trim();
    const helpLine = copilotQuota.needsSignIn
      ? 'Sign in to GitHub in VS Code, then wait for the next refresh.'
      : 'Copilot quota data is not available for this account right now.';

    return {
      slot: counter.slot,
      visible: true,
      text,
      tooltip: `Type: ${readableCopilotDisplayMode(counter)}\n${titleForCounter(counter)}\n\n${copilotQuota.message}\n\n${helpLine}`,
      accessibilityLabel: text,
    };
  }

  const { data } = copilotQuota;
  if (data.unlimited) {
    const text = `${formatCopilotLabelPrefix(counter)}unlimited`.trim();

    return {
      slot: counter.slot,
      visible: true,
      text,
      tooltip: [
        `Type: ${readableCopilotDisplayMode(counter)}`,
        `${titleForCounter(counter)}: Unlimited`,
        `Plan: ${data.plan}`,
        `Reset: ${formatDateTime(new Date(data.resetDateUtc))}`,
        '',
        'GitHub Copilot premium interactions are unlimited for this account.',
      ].join('\n'),
      accessibilityLabel: text,
    };
  }

  const trackedConsumptionPercent = toPercent(data.todayConsumed, data.entitlement);
  const totalConsumedPercent = data.percentUsed;
  const cycleTotalDays = Math.max(Math.round(data.elapsedDays + data.remainingDays), data.cycleDayNumber, 1);
  const expectedConsumedPercent = Math.min((data.cycleDayNumber / cycleTotalDays) * 100, 100);
  const expectedUsedValue = (expectedConsumedPercent / 100) * data.entitlement;
  const usedBeforeToday = Math.max(data.used - data.todayConsumed, 0);
  const remainingPoolPercent = Math.max(expectedConsumedPercent - totalConsumedPercent, 0);
  const remainingPoolValue = Math.max(expectedUsedValue - data.used, 0);
  const todayPoolValue = Math.max(expectedUsedValue - usedBeforeToday, 0);
  const poolConsumptionRatio = todayPoolValue > 0 ? data.todayConsumed / todayPoolValue : (data.todayConsumed > 0 ? 1 : 0);
  const poolPercentUsed = todayPoolValue > 0 ? toPercent(data.todayConsumed, todayPoolValue) : (data.todayConsumed > 0 ? 100 : 0);
  const poolOverflowRequests = Math.max(data.todayConsumed - todayPoolValue, 0);
  const headroomPercentOfBudget = expectedConsumedPercent > 0
    ? ((expectedConsumedPercent - totalConsumedPercent) / expectedConsumedPercent) * 100
    : 0;
  const paceIndicator = getPaceIndicator(headroomPercentOfBudget, totalConsumedPercent, expectedConsumedPercent);
  const poolBar = buildMiniBar(Math.min(Math.max(poolConsumptionRatio, 0), 1));
  const idealDailyPercent = 100 / cycleTotalDays;
  const actualAverageDailyPercent = data.cycleDayNumber > 0 ? totalConsumedPercent / data.cycleDayNumber : totalConsumedPercent;
  const averageConsumptionRatio = data.averageDailyConsumed > 0 ? data.todayConsumed / data.averageDailyConsumed : (data.todayConsumed > 0 ? 1 : 0);
  const averageBar = buildMiniBar(Math.min(Math.max(averageConsumptionRatio, 0), 1));
  const projectedDayDelta = data.daysAvailableAtCurrentPace === null
    ? data.remainingDays
    : data.daysAvailableAtCurrentPace - data.remainingDays;
  const calibrationIndicator = getCalibrationIndicator(projectedDayDelta);
  const lowDaysWarning = getLowDaysWarning(data.daysAvailableAtCurrentPace, data.remaining);

  let text = '';
  let summaryLine = '';
  let detailLine = '';

  switch (counter.copilotDisplayMode) {
    case 'raw-remaining':
      text = `${formatCopilotLabelPrefix(counter)}${formatQuotaValue(data.remaining)} (${formatCompactPercent(data.percentRemaining)})`.trim();
      summaryLine = `Raw remaining: ${formatQuotaValue(data.remaining)} (${formatCompactPercent(data.percentRemaining)})`;
      detailLine = `Consumed: ${formatQuotaValue(data.used)} (${formatCompactPercent(totalConsumedPercent)})`;
      break;
    case 'raw-consumption':
      text = `${formatCopilotLabelPrefix(counter)}${formatQuotaValue(data.used)} (${formatCompactPercent(totalConsumedPercent)})`.trim();
      summaryLine = `Raw consumption: ${formatQuotaValue(data.used)} (${formatCompactPercent(totalConsumedPercent)})`;
      detailLine = `Remaining: ${formatQuotaValue(data.remaining)} (${formatCompactPercent(data.percentRemaining)})`;
      break;
    case 'consumption':
      text = `${paceIndicator.emoji} ${formatCopilotLabelPrefix(counter)}${formatCompactPercent(expectedConsumedPercent)} ${formatCompactPercent(totalConsumedPercent)}`.trim();
      summaryLine = `Consumption: theoretical ${formatCompactPercent(expectedConsumedPercent)} | total consumed ${formatCompactPercent(totalConsumedPercent)}`;
      detailLine = `Today is ${formatCompactPercent(expectedConsumedPercent)} into the billing cycle | local tracked today ${formatCompactPercent(trackedConsumptionPercent)}`;
      break;
    case 'remaining-pool':
      text = `${paceIndicator.emoji} ${formatCopilotLabelPrefix(counter)}${poolBar} ${formatCountValue(data.todayConsumed)}/${formatCountValue(todayPoolValue)} (${formatCompactPercent(poolPercentUsed)})`.trim();
      summaryLine = `Pool: ${formatCountValue(data.todayConsumed)}/${formatCountValue(todayPoolValue)} (${formatCompactPercent(poolPercentUsed)})`;
      detailLine = poolOverflowRequests > 0
        ? `Today's pool ${formatCountValue(todayPoolValue)} | overflow ${formatCountValue(poolOverflowRequests)} requests | cycle pace target ${formatCompactPercent(expectedConsumedPercent)}`
        : `Today's pool ${formatCountValue(todayPoolValue)} | cycle pace target ${formatCompactPercent(expectedConsumedPercent)} | total consumed ${formatCompactPercent(totalConsumedPercent)}`;
      break;
    case 'average-calibration':
      text = `${calibrationIndicator.emoji} ${formatCopilotLabelPrefix(counter)}${averageBar} ${formatCountValue(data.todayConsumed)}/${formatCountValue(data.averageDailyConsumed)} (${formatCompactPercent(toPercent(data.todayConsumed, data.averageDailyConsumed))}) ${formatSignedDays(projectedDayDelta)}`.trim();
      summaryLine = `Average calibration: ${formatCountValue(data.todayConsumed)}/${formatCountValue(data.averageDailyConsumed)} (${formatCompactPercent(toPercent(data.todayConsumed, data.averageDailyConsumed))}) ${formatSignedDays(projectedDayDelta)}`;
      detailLine = `Today consumed ${formatCountValue(data.todayConsumed)} | average consumed ${formatCountValue(data.averageDailyConsumed)} | ideal ${formatCompactPercent(idealDailyPercent)}`;
      break;
  }

  const markerLegend = [
    'Emoji scale by value:',
    '⚪ Very low',
    '🟢 Low',
    '🔵 Normal',
    '⚫ On target',
    '🟡 High',
    '🟠 Very high',
    '🔴 Critical',
  ].join('\n');
  const trackingNote = data.todayConsumptionIsApproximate
    ? 'Local tracking: the first local snapshot is used as an anchor until a prior-day snapshot exists.'
    : 'Local tracking: today\'s local consumption is based on stored Copilot snapshots.';
  const daysLeftLine = formatDaysLeftLine(data.daysAvailableAtCurrentPace, lowDaysWarning.label, data.remainingDays);
  const projectionLine = `Projected quota end: ${formatSignedDays(projectedDayDelta)} compared with the billing-cycle end.`;
  const stateLine = counter.copilotDisplayMode === 'average-calibration'
    ? `Calibration state: ${calibrationIndicator.label}`
    : `Pace state: ${paceIndicator.label}`;

  return {
    slot: counter.slot,
    visible: true,
    text,
    tooltip: [
      `Type: ${readableCopilotDisplayMode(counter)}`,
      `${titleForCounter(counter)}: ${data.plan}`,
      summaryLine,
      detailLine,
      `Tracked local consumption: ${formatCompactPercent(trackedConsumptionPercent)}`,
      `Total consumed: ${formatCompactPercent(totalConsumedPercent)}`,
      `Theoretical cycle progress: ${formatCompactPercent(expectedConsumedPercent)}`,
      `Expected used by now: ${formatCountValue(expectedUsedValue)}`,
      `Used before today: ${formatCountValue(usedBeforeToday)}`,
      `Remaining pool now: ${formatCountValue(remainingPoolValue)} (${formatCompactPercent(remainingPoolPercent)})`,
      `Today vs pool: ${formatCountValue(data.todayConsumed)}/${formatCountValue(todayPoolValue)} (${formatCompactPercent(poolPercentUsed)})`,
      poolOverflowRequests > 0 ? `Pool overflow: ${formatCountValue(poolOverflowRequests)} requests beyond the available pool.` : 'Pool overflow: none',
      `Average daily burn: ${formatCountValue(data.averageDailyConsumed)} (${formatCompactPercent(actualAverageDailyPercent)})`,
      `Today vs average: ${formatCountValue(data.todayConsumed)}/${formatCountValue(data.averageDailyConsumed)} (${formatCompactPercent(toPercent(data.todayConsumed, data.averageDailyConsumed))})`,
      `Ideal daily burn: ${formatCompactPercent(idealDailyPercent)}`,
      projectionLine,
      daysLeftLine,
      stateLine,
      lowDaysWarning.label ? `Warning: ${lowDaysWarning.label}` : 'Warning: none',
      `Reset: ${formatDateTime(new Date(data.resetDateUtc))}`,
      `Cycle start: ${formatDateTime(new Date(data.cycleStartUtc))}`,
      `Snapshot: ${formatDateTime(new Date(data.snapshotTimeUtc))}`,
      `Elapsed / remaining: ${formatNumber(data.elapsedDays, 1)}d used | ${formatNumber(data.remainingDays, 1)}d left`,
      data.overagePermitted ? 'Overage: Permitted' : 'Overage: Not permitted',
      trackingNote,
      '',
      markerLegend,
      'Data source: GitHub Copilot internal quota endpoint.',
    ].join('\n'),
    accessibilityLabel: text,
  };
}

function buildMonthlyWindow(
  counter: CounterConfiguration,
  now: Date,
): { ok: true; window: ProgressWindow } | { ok: false; message: string } {
  const anchorDay = Math.trunc(counter.monthlyCycleDay);
  if (anchorDay < 1 || anchorDay > 31) {
    return {
      ok: false,
      message: 'Monthly mode requires a billing cycle day between 1 and 31.',
    };
  }

  const currentMonthAnchor = anchoredDate(now.getFullYear(), now.getMonth(), anchorDay);
  const start = now.getTime() >= currentMonthAnchor.getTime()
    ? currentMonthAnchor
    : anchoredDate(now.getFullYear(), now.getMonth() - 1, anchorDay);
  const end = now.getTime() >= currentMonthAnchor.getTime()
    ? anchoredDate(now.getFullYear(), now.getMonth() + 1, anchorDay)
    : currentMonthAnchor;

  return {
    ok: true,
    window: createWindow(start, end, now),
  };
}

function buildYearWindow(now: Date): ProgressWindow {
  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);

  return createWindow(start, end, now);
}

function buildDayWindow(
  counter: CounterConfiguration,
  now: Date,
): { ok: true; window: ProgressWindow } | { ok: false; message: string } {
  const startParts = parseTime(counter.dailyStartTime);
  const endParts = parseTime(counter.dailyEndTime);

  if (!startParts || !endParts) {
    return {
      ok: false,
      message: 'Day mode requires start and end times in HH:mm format.',
    };
  }

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startParts.hours, startParts.minutes, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endParts.hours, endParts.minutes, 0, 0);

  if (end.getTime() <= start.getTime()) {
    return {
      ok: false,
      message: 'Day mode requires an end time that is later than the start time.',
    };
  }

  return {
    ok: true,
    window: createWindow(start, end, now),
  };
}

function buildRangeWindow(
  counter: CounterConfiguration,
  now: Date,
): { ok: true; window: ProgressWindow } | { ok: false; message: string } {
  const startDate = parseIsoDate(counter.rangeStartDate);
  const endDate = parseIsoDate(counter.rangeEndDate);

  if (!startDate || !endDate) {
    return {
      ok: false,
      message: 'Range mode requires valid start and end dates in YYYY-MM-DD format.',
    };
  }

  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
  const endExclusive = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() + 1, 0, 0, 0, 0);

  if (endExclusive.getTime() <= start.getTime()) {
    return {
      ok: false,
      message: 'Range mode requires an end date that is the same as or later than the start date.',
    };
  }

  return {
    ok: true,
    window: createWindow(start, endExclusive, now),
  };
}

function buildDeadlineWindow(
  counter: CounterConfiguration,
  now: Date,
): { ok: true; window: ProgressWindow } | { ok: false; message: string } {
  const deadlineDate = parseIsoDate(counter.deadlineDate);
  if (!deadlineDate) {
    return {
      ok: false,
      message: 'Deadline mode requires a valid date in YYYY-MM-DD format.',
    };
  }

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate() + 1, 0, 0, 0, 0);
  if (end.getTime() <= start.getTime()) {
    return {
      ok: false,
      message: 'Deadline mode requires a future date.',
    };
  }

  return {
    ok: true,
    window: createWindow(start, end, now),
  };
}

function formatProgressText(counter: CounterConfiguration, window: ProgressWindow, percentage: string): string {
  switch (counter.mode) {
    case 'day-of-year':
      return `${formatTextPrefix(counter)}${getDayOfYear(window.now)}/${daysInYear(window.now)} (${percentage})`.trim();
    case 'deadline': {
      const daysLeft = Math.max(0, Math.ceil((window.end.getTime() - window.now.getTime()) / 86_400_000));
      return `${formatTextPrefix(counter)}${daysLeft}d (${percentage})`.trim();
    }
    default:
      return `${formatTextPrefix(counter)}${percentage}`.trim();
  }
}

function buildWindowSummary(counter: CounterConfiguration, window: ProgressWindow): string[] {
  switch (counter.mode) {
    case 'day-of-year':
      return [
        `Day: ${getDayOfYear(window.now)} of ${daysInYear(window.now)}`,
        `Year window: ${formatDateTime(window.start)} to ${formatDateTime(window.end)}`,
      ];
    case 'deadline':
      return [
        `Deadline: ${formatDateTime(window.end)}`,
        `Time left: ${formatNumber(Math.max((window.end.getTime() - window.now.getTime()) / 86_400_000, 0), 1)}d`,
      ];
    default:
      return [`Window: ${formatDateTime(window.start)} to ${formatDateTime(window.end)}`];
  }
}

function createWindow(start: Date, end: Date, now: Date): ProgressWindow {
  const totalDuration = end.getTime() - start.getTime();
  const elapsed = clamp(now.getTime() - start.getTime(), 0, totalDuration);
  const progress = totalDuration === 0 ? 1 : elapsed / totalDuration;

  return { start, end, now, progress };
}

function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
    return undefined;
  }

  return candidate;
}

function anchoredDate(year: number, month: number, anchorDay: number): Date {
  const firstOfMonth = new Date(year, month, 1, 0, 0, 0, 0);
  const lastDay = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth() + 1, 0).getDate();
  const resolvedDay = Math.min(anchorDay, lastDay);
  return new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), resolvedDay, 0, 0, 0, 0);
}

function parseTime(value: string): { hours: number; minutes: number } | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return undefined;
  }

  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
  };
}

function formatTextPrefix(counter: CounterConfiguration): string {
  const pieces = [counter.emoji.trim(), counter.label.trim()].filter(Boolean);
  return pieces.length > 0 ? `${pieces.join(' ')} ` : '';
}

function formatCopilotLabelPrefix(counter: CounterConfiguration): string {
  const label = counter.label.trim();
  const fallback = fallbackCopilotCaption(counter);
  const value = label || fallback;
  return value ? `${value} ` : '';
}

function titleForCounter(counter: CounterConfiguration): string {
  if (counter.mode === 'copilot') {
    return counter.label.trim() || fallbackCopilotCaption(counter) || readableCopilotDisplayMode(counter);
  }

  return counter.label.trim() || readableMode(counter.mode);
}

function formatPercent(progress: number, decimals: number): string {
  return `${(progress * 100).toFixed(clamp(decimals, 0, 2))}%`;
}

function formatNumber(value: number, decimals: number): string {
  return value.toFixed(clamp(decimals, 0, 2));
}

function formatQuotaValue(value: number): string {
  return String(parseFloat(value.toFixed(2)));
}

function formatCountValue(value: number): string {
  return String(Math.max(0, Math.round(value)));
}

function formatCompactPercent(value: number): string {
  return `${parseFloat(value.toFixed(1))}%`;
}

function buildMiniBar(progress: number): string {
  const blockCount = 5;
  const safeProgress = Math.min(Math.max(progress, 0), 1);
  const filledBlocks = Math.round(safeProgress * blockCount);
  let bar = '';

  for (let index = 0; index < blockCount; index += 1) {
    bar += index < filledBlocks ? '█' : '░';
  }

  return bar;
}

function getPaceIndicator(
  headroomPercentOfBudget: number,
  percentUsed: number,
  expectedConsumedPercent: number,
): { emoji: string; label: string } {
  if (percentUsed <= 0 && expectedConsumedPercent <= 0) {
    return { emoji: '⚫', label: 'On target with no visible usage yet.' };
  }

  if (Math.abs(headroomPercentOfBudget) < 1) {
    return { emoji: '⚫', label: 'On target.' };
  }

  if (headroomPercentOfBudget >= 200) {
    return { emoji: '⚪', label: 'Very low usage compared with cycle pace.' };
  }

  if (headroomPercentOfBudget >= 100) {
    return { emoji: '🟢', label: 'Low usage compared with cycle pace.' };
  }

  if (headroomPercentOfBudget >= 0) {
    return { emoji: '🔵', label: 'Normal usage with buffer still available.' };
  }

  if (headroomPercentOfBudget >= -100) {
    return { emoji: '🟡', label: 'High usage with no pool left.' };
  }

  if (headroomPercentOfBudget >= -200) {
    return { emoji: '🟠', label: 'Very high usage beyond the pool.' };
  }

  return { emoji: '🔴', label: 'Critical usage beyond the pool.' };
}

function getCalibrationIndicator(projectedDayDelta: number): { emoji: string; label: string } {
  if (projectedDayDelta >= 9) {
    return { emoji: '⚪', label: 'Very low average burn. Quota should outlast the cycle comfortably.' };
  }

  if (projectedDayDelta >= 6) {
    return { emoji: '🟢', label: 'Low average burn. Quota should outlast the cycle.' };
  }

  if (projectedDayDelta >= 3) {
    return { emoji: '🔵', label: 'Normal average burn with a small positive buffer.' };
  }

  if (projectedDayDelta > -3) {
    return { emoji: '⚫', label: 'Average burn is close to the ideal target.' };
  }

  if (projectedDayDelta > -6) {
    return { emoji: '🟡', label: 'High average burn. Quota may end a few days early.' };
  }

  if (projectedDayDelta > -9) {
    return { emoji: '🟠', label: 'Very high average burn. Quota may end well before reset.' };
  }

  return { emoji: '🔴', label: 'Critical average burn. Quota is projected to end much too early.' };
}

function getLowDaysWarning(
  daysAvailableAtCurrentPace: number | null,
  remaining: number,
): { label: string | null } {
  if (remaining <= 0) {
    return { label: 'Quota is already exhausted.' };
  }

  if (daysAvailableAtCurrentPace === null || !Number.isFinite(daysAvailableAtCurrentPace)) {
    return { label: null };
  }

  if (daysAvailableAtCurrentPace <= 1) {
    return { label: 'At the current pace, the remaining quota may last for about one day.' };
  }

  if (daysAvailableAtCurrentPace <= 3) {
    return { label: 'At the current pace, only about three days of quota remain.' };
  }

  return { label: null };
}

function formatDaysLeftLine(daysAvailableAtCurrentPace: number | null, warningLabel: string | null, remainingDays: number): string {
  if (daysAvailableAtCurrentPace === null || !Number.isFinite(daysAvailableAtCurrentPace)) {
    return `Days of quota left at current pace: still warming up (reset in ${formatNumber(remainingDays, 1)}d).`;
  }

  const base = `Days of quota left at current pace: ${formatNumber(Math.max(daysAvailableAtCurrentPace, 0), 1)}d (reset in ${formatNumber(remainingDays, 1)}d).`;
  return warningLabel ? `${base} ${warningLabel}` : base;
}

function readableMode(mode: CounterConfiguration['mode']): string {
  switch (mode) {
    case 'day-of-year':
      return 'Current day of year';
    case 'month':
      return 'Monthly billing cycle';
    case 'year':
      return 'Current calendar year';
    case 'day':
      return 'Current day';
    case 'range':
      return 'Custom date range';
    case 'deadline':
      return 'Deadline countdown';
    case 'copilot':
      return 'GitHub Copilot quota';
  }
}

function readableCopilotDisplayMode(counter: CounterConfiguration): string {
  switch (counter.copilotDisplayMode) {
    case 'raw-remaining':
      return 'Raw Remaining';
    case 'raw-consumption':
      return 'Raw Consumption';
    case 'consumption':
      return 'Consumption';
    case 'remaining-pool':
      return 'Pool';
    case 'average-calibration':
      return 'Average';
  }
}

function fallbackCopilotCaption(counter: CounterConfiguration): string {
  switch (counter.copilotDisplayMode) {
    case 'consumption':
      return 'Consumption';
    case 'remaining-pool':
      return 'Pool';
    case 'average-calibration':
      return 'Average';
    default:
      return '';
  }
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDayOfYear(value: Date): number {
  const start = new Date(value.getFullYear(), 0, 1, 0, 0, 0, 0);
  return Math.floor((value.getTime() - start.getTime()) / 86_400_000) + 1;
}

function daysInYear(value: Date): number {
  const start = new Date(value.getFullYear(), 0, 1, 0, 0, 0, 0);
  const end = new Date(value.getFullYear() + 1, 0, 1, 0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function toPercent(part: number, whole: number): number {
  if (whole <= 0) {
    return 0;
  }

  return (part / whole) * 100;
}

function formatSignedDays(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}d`;
}