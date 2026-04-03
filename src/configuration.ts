import * as vscode from 'vscode';

import {
  CounterConfiguration,
  CounterConfigurationInput,
  CopilotDisplayMode,
  CounterMode,
  ExtensionConfiguration,
  GeneralConfiguration,
} from './types';

const SECTION = 'oquota';
const COUNTERS_KEY = 'counters';
const LEGACY_SLOT_COUNT = 3;

export function getConfigurationSection(): string {
  return SECTION;
}

export function readExtensionConfiguration(): ExtensionConfiguration {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const general = readGeneralConfiguration(configuration);
  const counters = readCounterConfigurations(configuration);

  return { general, counters };
}

export function createCounterInput(mode: CounterMode = 'day-of-year'): CounterConfigurationInput {
  return normalizeCounterInput({
    enabled: true,
    label: defaultLabelForMode(mode),
    emoji: defaultEmojiForMode(mode),
    mode,
    monthlyCycleDay: 1,
    dailyStartTime: '09:00',
    dailyEndTime: '17:00',
    rangeStartDate: '2026-01-01',
    rangeEndDate: '2026-12-31',
    deadlineDate: defaultDeadlineDate(),
    copilotDisplayMode: 'consumption',
  });
}

export function readStoredCounterInputs(): CounterConfigurationInput[] {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const storedCounters = configuration.get<CounterConfigurationInput[]>(COUNTERS_KEY, []);
  return normalizeCounterInputs(storedCounters);
}

export function persistCounterInputs(counters: CounterConfigurationInput[]): Thenable<void> {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  return configuration.update(COUNTERS_KEY, counters.map((counter) => normalizeCounterInput(counter)), vscode.ConfigurationTarget.Global);
}

function readGeneralConfiguration(configuration: vscode.WorkspaceConfiguration): GeneralConfiguration {
  return {
    refreshIntervalSeconds: configuration.get<number>('refreshIntervalSeconds', 0),
    percentDecimals: configuration.get<number>('percentDecimals', 0),
  };
}

function readCounterConfigurations(configuration: vscode.WorkspaceConfiguration): CounterConfiguration[] {
  const storedCounters = normalizeCounterInputs(configuration.get<CounterConfigurationInput[]>(COUNTERS_KEY, []));
  const sourceCounters = storedCounters.length > 0
    ? storedCounters
    : (hasLegacyCounterConfiguration(configuration) ? readLegacyCounterInputs(configuration) : [createCounterInput()]);

  return sourceCounters.map((counter, index) => ({
    ...counter,
    slot: index + 1,
  }));
}

function readLegacyCounterInputs(configuration: vscode.WorkspaceConfiguration): CounterConfigurationInput[] {
  return Array.from({ length: LEGACY_SLOT_COUNT }, (_, index) => {
    return readLegacyCounterInput(configuration, index + 1);
  });
}

function readLegacyCounterInput(
  configuration: vscode.WorkspaceConfiguration,
  slot: number,
): CounterConfigurationInput {
  const prefix = `counter${slot}`;
  const mode = configuration.get<CounterMode>(`${prefix}.mode`, defaultModeForSlot(slot));
  const rawCopilotDisplayMode = configuration.get<string>(`${prefix}.copilotDisplayMode`, 'consumption');

  return normalizeCounterInput({
    enabled: configuration.get<boolean>(`${prefix}.enabled`, true),
    label: normalizeText(configuration.get<string>(`${prefix}.label`, defaultLabelForMode(mode))),
    emoji: normalizeText(configuration.get<string>(`${prefix}.emoji`, defaultEmojiForMode(mode))),
    mode,
    monthlyCycleDay: configuration.get<number>(`${prefix}.monthlyCycleDay`, 1),
    dailyStartTime: normalizeText(configuration.get<string>(`${prefix}.dailyStartTime`, '09:00')),
    dailyEndTime: normalizeText(configuration.get<string>(`${prefix}.dailyEndTime`, '17:00')),
    rangeStartDate: normalizeText(configuration.get<string>(`${prefix}.rangeStartDate`, '2026-01-01')),
    rangeEndDate: normalizeText(configuration.get<string>(`${prefix}.rangeEndDate`, '2026-12-31')),
    deadlineDate: normalizeText(configuration.get<string>(`${prefix}.deadlineDate`, defaultDeadlineDate())),
    copilotDisplayMode: normalizeCopilotDisplayMode(rawCopilotDisplayMode),
  });
}

function normalizeCounterInputs(counters: CounterConfigurationInput[]): CounterConfigurationInput[] {
  return counters.map((counter) => normalizeCounterInput(counter));
}

function normalizeCounterInput(counter: Partial<CounterConfigurationInput>): CounterConfigurationInput {
  const mode = normalizeCounterMode(counter.mode);

  return {
    enabled: counter.enabled ?? true,
    label: normalizeText(counter.label ?? defaultLabelForMode(mode)),
    emoji: normalizeText(counter.emoji ?? defaultEmojiForMode(mode)),
    mode,
    monthlyCycleDay: clampInteger(counter.monthlyCycleDay, 1, 31, 1),
    dailyStartTime: normalizeText(counter.dailyStartTime ?? '09:00'),
    dailyEndTime: normalizeText(counter.dailyEndTime ?? '17:00'),
    rangeStartDate: normalizeText(counter.rangeStartDate ?? '2026-01-01'),
    rangeEndDate: normalizeText(counter.rangeEndDate ?? '2026-12-31'),
    deadlineDate: normalizeText(counter.deadlineDate ?? defaultDeadlineDate()),
    copilotDisplayMode: normalizeCopilotDisplayMode(counter.copilotDisplayMode ?? 'consumption'),
  };
}

function normalizeCounterMode(value: CounterMode | undefined): CounterMode {
  switch (value) {
    case 'day-of-year':
    case 'month':
    case 'year':
    case 'day':
    case 'range':
    case 'deadline':
    case 'copilot':
      return value;
    default:
      return 'day-of-year';
  }
}

function normalizeCopilotDisplayMode(value: string): CopilotDisplayMode {
  switch (value) {
    case 'raw-remaining':
    case 'raw-consumption':
    case 'consumption':
    case 'remaining-pool':
    case 'average-calibration':
      return value;
    case 'today-vs-remaining':
    case 'today-vs-consumed':
      return 'consumption';
    case 'consumed':
      return 'raw-consumption';
    case 'remaining':
      return 'raw-remaining';
    default:
      return 'consumption';
  }
}

function normalizeText(value: string): string {
  return value.trim();
}

function defaultModeForSlot(slot: number): CounterMode {
  switch (slot) {
    case 1:
      return 'day-of-year';
    case 2:
      return 'year';
    default:
      return 'day';
  }
}

function defaultLabelForMode(mode: CounterMode): string {
  switch (mode) {
    case 'day-of-year':
      return 'Day of Year';
    case 'month':
      return 'Month';
    case 'year':
      return 'Year';
    case 'day':
      return 'Day';
    case 'range':
      return 'Range';
    case 'deadline':
      return 'Deadline';
    case 'copilot':
      return 'Copilot';
  }
}

function defaultEmojiForMode(mode: CounterMode): string {
  switch (mode) {
    case 'day-of-year':
      return '📆';
    case 'month':
      return '📅';
    case 'year':
      return '🗓️';
    case 'day':
      return '⏰';
    case 'range':
      return '📈';
    case 'deadline':
      return '⏳';
    case 'copilot':
      return '🤖';
  }
}

function hasLegacyCounterConfiguration(configuration: vscode.WorkspaceConfiguration): boolean {
  const legacyKeys = Array.from({ length: LEGACY_SLOT_COUNT }, (_, index) => index + 1).flatMap((slot) => {
    const prefix = `counter${slot}`;
    return [
      `${prefix}.enabled`,
      `${prefix}.label`,
      `${prefix}.emoji`,
      `${prefix}.mode`,
      `${prefix}.monthlyCycleDay`,
      `${prefix}.dailyStartTime`,
      `${prefix}.dailyEndTime`,
      `${prefix}.rangeStartDate`,
      `${prefix}.rangeEndDate`,
      `${prefix}.copilotDisplayMode`,
    ];
  });

  return legacyKeys.some((key) => {
    const inspection = configuration.inspect(key);
    return inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined;
  });
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function defaultDeadlineDate(): string {
  const value = new Date();
  value.setDate(value.getDate() + 7);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}