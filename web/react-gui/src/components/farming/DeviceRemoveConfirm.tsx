import React from 'react';
import { useTranslation } from 'react-i18next';

import type { DeviceRemoveContext } from './useDeviceRemoval';

/**
 * Loose on purpose: every card holds a namespace-typed TFunction from
 * `useTranslation('devices')`, and the test suites substitute a plain
 * `(key: string) => string`. Both must be passable here.
 */
type TranslateFn = (key: any) => string;

/**
 * Label for the ✕ button, so the control says what it will actually do —
 * "Unassign from this zone" inside a zone, "Remove device" in the unassigned
 * grid. Also gives tests a stable accessible query.
 */
export function deviceRemoveButtonLabel(
  removeContext: DeviceRemoveContext,
  isRemoving: boolean,
  t: TranslateFn,
): string {
  if (isRemoving) {
    return t(removeContext === 'zone' ? 'deviceRemoval.removingZone' : 'deviceRemoval.removingFarm');
  }
  return t(removeContext === 'zone' ? 'deviceRemoval.buttonZone' : 'deviceRemoval.buttonFarm');
}

interface DeviceRemoveConfirmProps {
  removeContext: DeviceRemoveContext;
  isRemoving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one confirm panel shared by every device card. Its copy is picked from
 * `removeContext` so the dialog and the action can never disagree, which is the
 * defect this component was extracted to kill.
 */
export const DeviceRemoveConfirm: React.FC<DeviceRemoveConfirmProps> = ({
  removeContext,
  isRemoving,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation('common');
  const isZone = removeContext === 'zone';

  return (
    <div className="bg-[var(--warn-bg)] border-2 border-[var(--warn-border)] text-[var(--warn-text)] px-4 py-3 rounded-lg mb-4">
      <p className="font-bold mb-2">{t(isZone ? 'deviceRemoval.titleZone' : 'deviceRemoval.titleFarm')}</p>
      <p className="text-sm mb-3">{t(isZone ? 'deviceRemoval.subtitleZone' : 'deviceRemoval.subtitleFarm')}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isRemoving}
          className="bg-[var(--error-bg)] hover:bg-[var(--error-bg)] disabled:bg-[var(--border)] text-[var(--error-text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center gap-2 disabled:text-[var(--text-disabled)]"
        >
          {isRemoving ? (
            <>
              <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
              {t(isZone ? 'deviceRemoval.removingZone' : 'deviceRemoval.removingFarm')}
            </>
          ) : (
            t(isZone ? 'deviceRemoval.confirmZone' : 'deviceRemoval.confirmFarm')
          )}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isRemoving}
          className="bg-[var(--secondary-bg)] hover:bg-[var(--border)] disabled:bg-[var(--border)] text-[var(--text)] font-bold px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-[var(--text-disabled)]"
        >
          {tc('cancel')}
        </button>
      </div>
    </div>
  );
};
