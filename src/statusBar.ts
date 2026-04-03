import * as vscode from 'vscode';

import { CounterEvaluation } from './types';

export class StatusBarController implements vscode.Disposable {
  private readonly items = new Map<number, vscode.StatusBarItem>();

  public constructor(private readonly commandId: string) {}

  public render(evaluations: CounterEvaluation[]): void {
    const visibleSlots = new Set<number>();

    for (const evaluation of evaluations) {
      if (!evaluation.visible) {
        this.hideSlot(evaluation.slot);
        continue;
      }

      visibleSlots.add(evaluation.slot);
      const item = this.getOrCreateItem(evaluation.slot);
      item.text = evaluation.text;
      item.tooltip = evaluation.tooltip;
      item.command = {
        command: this.commandId,
        title: `Configure oQuota Counter ${evaluation.slot}`,
        arguments: [evaluation.slot],
      };
      item.accessibilityInformation = {
        label: evaluation.accessibilityLabel,
        role: 'button',
      };
      item.show();
    }

    for (const slot of this.items.keys()) {
      if (!visibleSlots.has(slot)) {
        this.hideSlot(slot);
      }
    }
  }

  public dispose(): void {
    for (const item of this.items.values()) {
      item.dispose();
    }
    this.items.clear();
  }

  private getOrCreateItem(slot: number): vscode.StatusBarItem {
    const existing = this.items.get(slot);
    if (existing) {
      return existing;
    }

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1_000 - slot);
    item.name = `oQuota Counter ${slot}`;
    this.items.set(slot, item);

    return item;
  }

  private hideSlot(slot: number): void {
    const item = this.items.get(slot);
    item?.hide();
  }
}