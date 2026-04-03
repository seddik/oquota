import * as vscode from 'vscode';

import { clearCopilotQuotaCache, getCopilotQuota } from './copilotQuota';
import {
  createCounterInput,
  getConfigurationSection,
  persistCounterInputs,
  readExtensionConfiguration,
} from './configuration';
import { evaluateCounter } from './quotaEngine';
import { StatusBarController } from './statusBar';
import {
  CounterConfiguration,
  CounterConfigurationInput,
  CopilotDisplayMode,
  CounterMode,
  ExtensionConfiguration,
} from './types';

const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const FAST_REFRESH_INTERVAL_SECONDS = 60;

const OPEN_SETTINGS_COMMAND = 'oquota.openSettings';
const CONFIGURE_COUNTER_COMMAND = 'oquota.configureCounter';
const ADD_COUNTER_COMMAND = 'oquota.addCounter';
const REMOVE_COUNTER_COMMAND = 'oquota.removeCounter';

let extensionContext: vscode.ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let statusBarController: StatusBarController | undefined;
let renderSequence = 0;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  statusBarController = new StatusBarController(CONFIGURE_COUNTER_COMMAND);

  context.subscriptions.push(
    statusBarController,
    vscode.commands.registerCommand(OPEN_SETTINGS_COMMAND, async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', getConfigurationSection());
    }),
    vscode.commands.registerCommand(CONFIGURE_COUNTER_COMMAND, async (slot?: number) => {
      await configureCounter(typeof slot === 'number' ? slot : undefined);
    }),
    vscode.commands.registerCommand(ADD_COUNTER_COMMAND, async () => {
      await addCounter();
    }),
    vscode.commands.registerCommand(REMOVE_COUNTER_COMMAND, async () => {
      await removeCounter();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(getConfigurationSection())) {
        applyConfiguration();
      }
    }),
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') {
        clearCopilotQuotaCache();
        applyConfiguration();
      }
    }),
    new vscode.Disposable(() => {
      clearRefreshTimer();
    }),
  );

  applyConfiguration();
}

export function deactivate(): void {
  clearRefreshTimer();
  statusBarController?.dispose();
  statusBarController = undefined;
  extensionContext = undefined;
}

function applyConfiguration(): void {
  const configuration = readExtensionConfiguration();
  void render(configuration);
  resetRefreshTimer(configuration);
}

async function render(configuration: ExtensionConfiguration): Promise<void> {
  if (!statusBarController) {
    return;
  }

  const currentSequence = ++renderSequence;
  const copilotQuota = configuration.counters.some((counter) => counter.enabled && counter.mode === 'copilot')
    ? await getCopilotQuota(extensionContext)
    : undefined;

  if (!statusBarController || currentSequence !== renderSequence) {
    return;
  }

  const evaluations = configuration.counters.map((counter) => {
    return evaluateCounter(counter, new Date(), copilotQuota);
  });

  statusBarController.render(evaluations);
}

function resetRefreshTimer(configuration: ExtensionConfiguration): void {
  clearRefreshTimer();
  const refreshIntervalSeconds = getRefreshIntervalSeconds(configuration);
  refreshTimer = setInterval(() => {
    const latestConfiguration = readExtensionConfiguration();
    clearCopilotQuotaCache();
    void render(latestConfiguration);
  }, Math.max(refreshIntervalSeconds, 10) * 1_000);
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

async function configureCounter(slot?: number): Promise<void> {
  const counters = getEditableCounterInputs();
  const selectedSlot = slot ?? await pickCounterSlot(withSlots(counters));
  if (!selectedSlot) {
    return;
  }

  const counter = counters[selectedSlot - 1];
  if (!counter) {
    return;
  }

  const updatedCounter = await promptForCounterInput(selectedSlot, counter);
  if (!updatedCounter) {
    return;
  }

  counters[selectedSlot - 1] = updatedCounter;
  await persistCountersAndRefresh(counters, counter.mode === 'copilot' || updatedCounter.mode === 'copilot');

  void vscode.window.showInformationMessage(`oQuota Counter ${selectedSlot} updated.`);
}

async function addCounter(): Promise<void> {
  const counters = getEditableCounterInputs();
  const mode = await pickCounterMode('day-of-year');
  if (!mode) {
    return;
  }

  const createdCounter = await promptForCounterInput(counters.length + 1, createCounterInput(mode), mode);
  if (!createdCounter) {
    return;
  }

  counters.push(createdCounter);
  await persistCountersAndRefresh(counters, createdCounter.mode === 'copilot');

  void vscode.window.showInformationMessage(`oQuota Counter ${counters.length} added.`);
}

async function removeCounter(): Promise<void> {
  const counters = getEditableCounterInputs();
  const selectedSlot = await pickCounterSlot(withSlots(counters));
  if (!selectedSlot) {
    return;
  }

  const target = counters[selectedSlot - 1];
  if (!target) {
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Remove oQuota Counter ${selectedSlot}${target.label ? ` (${target.label})` : ''}?`,
    { modal: true },
    'Remove',
  );
  if (confirmation !== 'Remove') {
    return;
  }

  const remainingCounters = counters.filter((_, index) => index !== selectedSlot - 1);
  const nextCounters = remainingCounters.length > 0 ? remainingCounters : [createCounterInput('day-of-year')];
  await persistCountersAndRefresh(nextCounters, target.mode === 'copilot');

  void vscode.window.showInformationMessage(`oQuota Counter ${selectedSlot} removed.`);
}

function getEditableCounterInputs(): CounterConfigurationInput[] {
  return readExtensionConfiguration().counters.map((counter) => toCounterInput(counter));
}

function toCounterInput(counter: CounterConfiguration): CounterConfigurationInput {
  return {
    enabled: counter.enabled,
    label: counter.label,
    emoji: counter.emoji,
    mode: counter.mode,
    monthlyCycleDay: counter.monthlyCycleDay,
    dailyStartTime: counter.dailyStartTime,
    dailyEndTime: counter.dailyEndTime,
    rangeStartDate: counter.rangeStartDate,
    rangeEndDate: counter.rangeEndDate,
    deadlineDate: counter.deadlineDate,
    copilotDisplayMode: counter.copilotDisplayMode,
  };
}

function withSlots(counters: CounterConfigurationInput[]): CounterConfiguration[] {
  return counters.map((counter, index) => ({ ...counter, slot: index + 1 }));
}

async function promptForCounterInput(
  slot: number,
  current: CounterConfigurationInput,
  preferredMode?: CounterMode,
): Promise<CounterConfigurationInput | undefined> {
  const label = await vscode.window.showInputBox({
    prompt: `Counter ${slot} label`,
    value: current.label,
    ignoreFocusOut: true,
  });
  if (label === undefined) {
    return undefined;
  }

  const emoji = await vscode.window.showInputBox({
    prompt: `Counter ${slot} emoji`,
    value: current.emoji,
    placeHolder: 'Optional, for example 📅',
    ignoreFocusOut: true,
  });
  if (emoji === undefined) {
    return undefined;
  }

  const mode = preferredMode ?? await pickCounterMode(current.mode);
  if (!mode) {
    return undefined;
  }

  const draft: CounterConfigurationInput = {
    ...current,
    label: label.trim(),
    emoji: emoji.trim(),
    mode,
  };

  if (mode === 'month') {
    const monthlyCycleDay = await vscode.window.showInputBox({
      prompt: `Counter ${slot} billing cycle day`,
      value: String(current.monthlyCycleDay),
      placeHolder: '1 to 31',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const parsed = Number.parseInt(value, 10);
        return parsed >= 1 && parsed <= 31 ? undefined : 'Enter a number between 1 and 31.';
      },
    });
    if (monthlyCycleDay === undefined) {
      return undefined;
    }

    draft.monthlyCycleDay = Number.parseInt(monthlyCycleDay, 10);
  }

  if (mode === 'day') {
    const dailyStartTime = await vscode.window.showInputBox({
      prompt: `Counter ${slot} start time`,
      value: current.dailyStartTime,
      placeHolder: '09:00',
      ignoreFocusOut: true,
      validateInput: validateTime,
    });
    if (dailyStartTime === undefined) {
      return undefined;
    }

    const dailyEndTime = await vscode.window.showInputBox({
      prompt: `Counter ${slot} end time`,
      value: current.dailyEndTime,
      placeHolder: '17:00',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const baseError = validateTime(value);
        if (baseError) {
          return baseError;
        }

        return compareTimes(dailyStartTime, value) < 0 ? undefined : 'End time must be later than start time.';
      },
    });
    if (dailyEndTime === undefined) {
      return undefined;
    }

    draft.dailyStartTime = dailyStartTime;
    draft.dailyEndTime = dailyEndTime;
  }

  if (mode === 'range') {
    const rangeStartDate = await vscode.window.showInputBox({
      prompt: `Counter ${slot} start date`,
      value: current.rangeStartDate,
      placeHolder: 'YYYY-MM-DD',
      ignoreFocusOut: true,
      validateInput: validateDate,
    });
    if (rangeStartDate === undefined) {
      return undefined;
    }

    const rangeEndDate = await vscode.window.showInputBox({
      prompt: `Counter ${slot} end date`,
      value: current.rangeEndDate,
      placeHolder: 'YYYY-MM-DD',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const baseError = validateDate(value);
        if (baseError) {
          return baseError;
        }

        return compareDates(rangeStartDate, value) <= 0 ? undefined : 'End date must be the same as or later than start date.';
      },
    });
    if (rangeEndDate === undefined) {
      return undefined;
    }

    draft.rangeStartDate = rangeStartDate;
    draft.rangeEndDate = rangeEndDate;
  }

  if (mode === 'deadline') {
    const deadlineDate = await vscode.window.showInputBox({
      prompt: `Counter ${slot} deadline date`,
      value: current.deadlineDate,
      placeHolder: 'YYYY-MM-DD',
      ignoreFocusOut: true,
      validateInput: validateDate,
    });
    if (deadlineDate === undefined) {
      return undefined;
    }

    draft.deadlineDate = deadlineDate;
  }

  if (mode === 'copilot') {
    await maybeRequestGitHubSession();

    const copilotDisplayMode = await pickCopilotDisplayMode(current.copilotDisplayMode);
    if (!copilotDisplayMode) {
      return undefined;
    }

    draft.copilotDisplayMode = copilotDisplayMode;
  }

  return draft;
}

async function persistCountersAndRefresh(counters: CounterConfigurationInput[], clearCopilot: boolean): Promise<void> {
  await persistCounterInputs(counters);
  if (clearCopilot) {
    clearCopilotQuotaCache();
  }
}

async function pickCounterSlot(counters: CounterConfiguration[]): Promise<number | undefined> {
  const selection = await vscode.window.showQuickPick(
    counters.map((counter) => ({
      label: `Counter ${counter.slot}`,
      description: counter.label,
      value: counter.slot,
    })),
    {
      placeHolder: 'Select a counter to configure',
      ignoreFocusOut: true,
    },
  );

  return selection?.value;
}

async function pickCounterMode(currentMode: CounterMode): Promise<CounterMode | undefined> {
  const selection = await vscode.window.showQuickPick(
    [
      { label: 'Current day of year', description: 'Show the current day number and year progress', value: 'day-of-year' },
      { label: 'Monthly billing cycle', description: 'Use a billing cycle day from 1 to 31', value: 'month' },
      { label: 'Current calendar year', description: 'January to December of the current year', value: 'year' },
      { label: 'Current workday', description: 'Use a start and end time for today', value: 'day' },
      { label: 'Custom date range', description: 'Use explicit from and to dates', value: 'range' },
      { label: 'Deadline countdown', description: 'Count down to a future date', value: 'deadline' },
      { label: 'GitHub Copilot quota', description: 'Show Copilot premium interaction quota data', value: 'copilot' },
    ].map((entry) => ({ ...entry, picked: entry.value === currentMode })),
    {
      placeHolder: 'Choose the counter mode',
      ignoreFocusOut: true,
    },
  );

  return selection?.value as CounterMode | undefined;
}

function validateTime(value: string): string | undefined {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? undefined : 'Use 24-hour HH:mm format.';
}

function validateDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return 'Use YYYY-MM-DD format.';
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return 'Enter a valid date.';
  }

  return undefined;
}

function compareTimes(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

async function pickCopilotDisplayMode(currentMode: CopilotDisplayMode): Promise<CopilotDisplayMode | undefined> {
  const selection = await vscode.window.showQuickPick(
    [
      {
        label: 'Raw Remaining',
        description: 'Show remaining premium interactions as the raw value and percentage',
        value: 'raw-remaining',
      },
      {
        label: 'Raw Consumption',
        description: 'Show consumed premium interactions as the raw value and percentage',
        value: 'raw-consumption',
      },
      {
        label: 'Consumption',
        description: 'Show tracked local consumption against total consumed quota',
        value: 'consumption',
      },
      {
        label: 'Remaining Pool',
        description: 'Show how much pace buffer is still available in the current billing cycle',
        value: 'remaining-pool',
      },
      {
        label: 'Average Calibration',
        description: 'Show average daily burn against ideal pace and project early or late quota exhaustion',
        value: 'average-calibration',
      },
    ].map((entry) => ({ ...entry, picked: entry.value === currentMode })),
    {
      placeHolder: 'Choose the Copilot quota display style',
      ignoreFocusOut: true,
    },
  );

  return selection?.value as CopilotDisplayMode | undefined;
}

async function maybeRequestGitHubSession(): Promise<void> {
  const selection = await vscode.window.showInformationMessage(
    'Copilot quota counters use the GitHub account already signed into VS Code.',
    'Sign In',
    'Continue',
  );

  if (selection === 'Sign In') {
    await vscode.authentication.getSession('github', ['user:email'], { createIfNone: true });
  }
}

function getRefreshIntervalSeconds(configuration: ExtensionConfiguration): number {
  const enabledCounters = configuration.counters.filter((counter) => counter.enabled);
  if (enabledCounters.length === 0) {
    return DEFAULT_REFRESH_INTERVAL_SECONDS;
  }

  return enabledCounters.reduce((minimum, counter) => {
    return Math.min(minimum, getSuggestedRefreshIntervalSeconds(counter));
  }, Number.POSITIVE_INFINITY);
}

function getSuggestedRefreshIntervalSeconds(counter: CounterConfiguration): number {
  switch (counter.mode) {
    case 'copilot':
    case 'day':
      return FAST_REFRESH_INTERVAL_SECONDS;
    default:
      return DEFAULT_REFRESH_INTERVAL_SECONDS;
  }
}