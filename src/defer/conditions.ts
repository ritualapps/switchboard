/**
 * Deferral condition evaluation.
 *
 * Named conditions (overnight / weekend / until_time / until_day /
 * until_device_context) plus cron as the escape hatch. The background
 * checker (./checker.ts) calls evaluateCondition every poll tick; when
 * it returns true, the line re-rings.
 *
 * Device context (at_desktop / on_mobile) is a stub for now -- the actual
 * check requires platform detection that is out of scope here, so it returns
 * false until a later version wires it up.
 */

import type { DeferralCondition } from '../types.js';

export interface EvaluateInput {
  condition: DeferralCondition;
  now: Date;
  deferredAt: Date;
}

export function evaluateCondition(input: EvaluateInput): boolean {
  const { condition, now, deferredAt } = input;
  switch (condition.kind) {
    case 'overnight':
      return isOvernightElapsed(deferredAt, now);
    case 'weekend':
      return isWeekend(now);
    case 'until_time':
      return now.getTime() >= Date.parse(condition.iso);
    case 'until_day':
      return matchesDayOfWeek(now, condition.dayOfWeek);
    case 'until_device_context':
      // Stub: no device-context detection yet. A later version wires the
      // platform probe.
      return false;
    case 'cron':
      return matchesCron(condition.expression, now);
  }
}

function isOvernightElapsed(deferredAt: Date, now: Date): boolean {
  // Overnight: passed 04:00 local on a calendar day after deferredAt.
  const cutoff = new Date(deferredAt);
  cutoff.setDate(cutoff.getDate() + 1);
  cutoff.setHours(4, 0, 0, 0);
  return now.getTime() >= cutoff.getTime();
}

function isWeekend(now: Date): boolean {
  const day = now.getDay();
  return day === 0 || day === 6;
}

function matchesDayOfWeek(
  now: Date,
  target: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
): boolean {
  const map: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return now.getDay() === map[target];
}

function matchesCron(expression: string, now: Date): boolean {
  // Minimal cron support -- only "M H * * *" patterns (minute + hour). The
  // day-of-month, month, and day-of-week fields are not yet interpreted, so
  // any non-`*` value there is rejected rather than silently ignored:
  // honouring "0 9 * * 1" as a daily 09:00 fire (ignoring the Monday field)
  // would re-ring on the wrong days. Refusing to match is the safe failure
  // -- the operator re-engages the line manually. A later version may swap
  // in a full cron parser.
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return false;
  const minOk = m === '*' || Number.parseInt(m!, 10) === now.getMinutes();
  const hourOk = h === '*' || Number.parseInt(h!, 10) === now.getHours();
  return minOk && hourOk;
}
